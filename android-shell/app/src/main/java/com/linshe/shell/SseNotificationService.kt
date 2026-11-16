package com.linshe.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 前台服务：维持到 /api/stream 的 SSE 长连接，把服务端事件转成系统通知。
 *
 * 通知分 5 个 channel（聊天/朋友圈/群聊/信箱/事件），系统设置里可按类关闭，
 * App 内设置页也有对应开关（SharedPreferences notify_* 键）。
 * App 在前台时不弹通知（页面内已有红点/实时追加）。
 */
class SseNotificationService : Service() {

    companion object {
        private const val SERVICE_NOTIFICATION_ID = 1
        private const val CHANNEL_SERVICE = "service"
        // P0-02：凭证失效提示的独立通知 id（不与具体消息通知抢位置）
        private const val NOTIFY_ID_REPAIR = 2

        const val CAT_CHAT = "chat"
        const val CAT_MOMENTS = "moments"
        const val CAT_COMMENTS = "comments"
        const val CAT_GROUP = "group"
        const val CAT_MAILBOX = "mailbox"
        const val CAT_EVENTS = "events"

        val ALL_CATEGORIES = listOf(CAT_CHAT, CAT_MOMENTS, CAT_COMMENTS, CAT_GROUP, CAT_MAILBOX, CAT_EVENTS)

        /** 朋友圈评论较吵，默认关闭；其余默认开启 */
        fun defaultFor(category: String) = category != CAT_COMMENTS

        fun isCategoryEnabled(ctx: Context, category: String): Boolean {
            val prefs = ctx.getSharedPreferences("shell", Context.MODE_PRIVATE)
            return prefs.getBoolean("notify_$category", defaultFor(category))
        }

        fun anyCategoryEnabled(ctx: Context): Boolean {
            return ALL_CATEGORIES.any { isCategoryEnabled(ctx, it) }
        }

        const val SERVICE_CHANNEL_ID = CHANNEL_SERVICE

        /** 创建全部通知渠道（服务启动和设置页跳转渠道设置前都会调用，幂等） */
        fun ensureChannels(ctx: Context) {
            val nm = ctx.getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_SERVICE, "后台连接", NotificationManager.IMPORTANCE_MIN).apply {
                    description = "保持与邻舍服务端的通知连接（在此关闭可隐藏常驻通知，不影响推送）"
                    setShowBadge(false)
                })
            nm.createNotificationChannel(
                NotificationChannel(CAT_CHAT, "聊天消息", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "角色主动聊天、延迟回复"
                })
            nm.createNotificationChannel(
                NotificationChannel(CAT_MOMENTS, "朋友圈新帖", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "角色发布新朋友圈"
                })
            nm.createNotificationChannel(
                NotificationChannel(CAT_COMMENTS, "朋友圈评论", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "朋友圈评论区互动"
                })
            nm.createNotificationChannel(
                NotificationChannel(CAT_GROUP, "群聊", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "群聊消息、新群创建"
                })
            nm.createNotificationChannel(
                NotificationChannel(CAT_MAILBOX, "信箱", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "回信送达"
                })
            nm.createNotificationChannel(
                NotificationChannel(CAT_EVENTS, "事件", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "事件发生与进展"
                })
        }
    }

    @Volatile private var running = false
    @Volatile private var currentConn: HttpURLConnection? = null
    private var worker: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(SERVICE_NOTIFICATION_ID, persistentNotification())
        if (!running) {
            running = true
            worker = Thread({ runLoop() }, "sse-notify").apply {
                isDaemon = true
                start()
            }
        } else {
            // 服务已在运行但配置可能变了（如新地址）：掐断当前连接，循环会立即用新配置重连
            abortCurrentConnection()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        abortCurrentConnection()
        worker?.interrupt()
        super.onDestroy()
    }

    /** disconnect 可打断阻塞中的 socket read（interrupt 做不到），需在子线程执行避免主线程网络操作 */
    private fun abortCurrentConnection() {
        val conn = currentConn ?: return
        Thread { runCatching { conn.disconnect() } }.start()
    }

    private fun persistentNotification(): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("邻舍通知服务运行中")
            .setContentIntent(pi)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .build()
    }

    // ── SSE 连接循环（指数退避重连）──

    private fun runLoop() {
        var backoffMs = 5000L
        while (running) {
            val base = getSharedPreferences("shell", MODE_PRIVATE).getString("url", null)
            if (base.isNullOrEmpty()) {
                sleepQuiet(30000)
                continue
            }
            val gotData = try {
                connectAndRead(base)
            } catch (e: Exception) {
                false
            }
            if (!running) break
            backoffMs = if (gotData) 5000L else (backoffMs * 2).coerceAtMost(60000L)
            sleepQuiet(backoffMs)
        }
    }

    /** 返回是否收到过至少一个事件（用于重置退避） */
    private fun connectAndRead(base: String): Boolean {
        var gotData = false
        val url = URL(base.trimEnd('/') + "/api/stream")
        val conn = url.openConnection() as HttpURLConnection
        conn.connectTimeout = 10000
        // 服务端每 30s 心跳，90s 读不到即判定死链
        conn.readTimeout = 90000
        conn.setRequestProperty("Accept", "text/event-stream")
        // P0-02：带上设备令牌。
        //
        // 原来这里只有 Accept 头。远程 /api/stream 需要配对 Cookie 或 Bearer，
        // 而网页里的 HttpOnly Cookie 不会共享给 HttpURLConnection ⇒
        // 「网页配对成功、后台通知永远收不到」，且 401 被当成普通断线无限重连。
        // 令牌由网页配对成功后通过受 origin 保护的原生桥下发并持久化（见 DeviceTokenStore）。
        DeviceTokenStore.load(this)?.let { conn.setRequestProperty("Authorization", "Bearer $it") }
        currentConn = conn
        try {
            val status = conn.responseCode
            if (status == 401 || status == 403) {
                // 凭证失效：停止本轮重连，等网页重新配对下发新令牌。
                // 继续退避重试只会无意义地打服务端，用户也永远看不到「需要重新配对」。
                notifyRepairRequired(status)
                running = false
                return false
            }
            conn.inputStream.bufferedReader().use { reader ->
                var event = ""
                val data = StringBuilder()
                while (running) {
                    val line = reader.readLine() ?: break
                    when {
                        line.isEmpty() -> {
                            if (event.isNotEmpty()) {
                                gotData = true
                                try { dispatch(event, data.toString()) } catch (_: Exception) {}
                            }
                            event = ""
                            data.setLength(0)
                        }
                        line.startsWith(":") -> gotData = true   // 心跳也算活
                        line.startsWith("event:") -> event = line.substring(6).trim()
                        line.startsWith("data:") -> {
                            if (data.isNotEmpty()) data.append('\n')
                            data.append(line.substring(5).trim())
                        }
                    }
                }
            }
        } finally {
            currentConn = null
            conn.disconnect()
        }
        return gotData
    }

    /**
     * 凭证被拒时给用户一条可执行的提示（P0-02）。
     * 只提示一次，避免每次服务重启都弹一条。
     */
    private fun notifyRepairRequired(status: Int) {
        val prefs = getSharedPreferences("shell", MODE_PRIVATE)
        val lastNotice = prefs.getLong("sse_repair_notice_at", 0L)
        if (System.currentTimeMillis() - lastNotice < 10 * 60_000L) return
        prefs.edit().putLong("sse_repair_notice_at", System.currentTimeMillis()).apply()
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("通知已断开")
            .setContentText("设备凭证已失效（HTTP $status），请在网页里重新配对")
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        runCatching { NotificationManagerCompat.from(this).notify(NOTIFY_ID_REPAIR, notification) }
    }

    private fun sleepQuiet(ms: Long) {
        try { Thread.sleep(ms) } catch (_: InterruptedException) {}
    }

    // ── 事件 → 通知 ──

    private fun dispatch(event: String, dataStr: String) {
        // App 在前台时页面自己会展示，不重复弹通知
        if (MainActivity.inForeground) return

        val category = when (event) {
            "proactive_message", "delayed_reply" -> CAT_CHAT
            "new_post" -> CAT_MOMENTS
            "new_comment" -> CAT_COMMENTS
            "group_message", "group_created" -> CAT_GROUP
            "reply_ready" -> CAT_MAILBOX
            // 信箱失败终态（2026-10-17 §P2-1）：后端连续失败到上限后不再自动重试、广播 reply_failed。
            // 归同一个信箱分类（用户可以在设置里一起关掉）。不弹的话，手机端用户永远不知道
            // 那封信已经停了 —— 而这恰恰是最需要他去处理的一件事（修 LLM / 开 ComfyUI / 手动重投）。
            "reply_failed" -> CAT_MAILBOX
            "new_event", "event_concluded", "event_expired" -> CAT_EVENTS
            else -> return   // connected / 各类进度事件不弹通知
        }

        if (!isCategoryEnabled(this, category)) return

        val json = try { JSONObject(dataStr) } catch (_: Exception) { JSONObject() }

        var title: String
        var text: String
        var route: String
        var notifyId: Int

        when (event) {
            "proactive_message" -> {
                title = str(json, "display_name", "character_name").ifEmpty { "新消息" }
                text = str(json, "content", "text").ifEmpty { "发来了一条消息" }
                route = "/chat/${json.opt("character_id")}"
                notifyId = "chat${json.opt("character_id")}".hashCode()
            }
            "delayed_reply" -> {
                title = str(json, "display_name", "character_name").ifEmpty { "新消息" }
                val msgs = json.optJSONArray("messages")
                text = (msgs?.optJSONObject(0)?.optString("content") ?: "").ifEmpty { "发来了一条消息" }
                route = "/chat/${json.opt("character_id")}"
                notifyId = "chat${json.opt("character_id")}".hashCode()
            }
            "new_post" -> {
                val n = str(json, "display_name", "character_name")
                title = if (n.isEmpty()) "新朋友圈" else "$n 发了一条朋友圈"
                text = str(json, "content", "text").ifEmpty { "点击查看" }
                route = "/moments"
                notifyId = "post${json.opt("id")}".hashCode()
            }
            "new_comment" -> {
                val n = str(json, "display_name", "character_name", "commenter_name", "from_name")
                title = if (n.isEmpty()) "朋友圈有新评论" else "$n 评论了朋友圈"
                text = str(json, "content", "comment", "text").ifEmpty { "点击查看" }
                route = "/moments"
                notifyId = "comment${json.opt("post_id")}${json.opt("id")}".hashCode()
            }
            "group_message" -> {
                val n = str(json, "speaker_name", "display_name")
                title = if (n.isEmpty()) "群聊新消息" else "$n（群聊）"
                text = str(json, "content", "text").ifEmpty { "发来了一条群消息" }
                route = "/group/${json.opt("group_id")}"
                notifyId = "group${json.opt("group_id")}".hashCode()
            }
            "group_created" -> {
                val creator = str(json, "creator_name")
                title = if (creator.isEmpty()) "新群聊" else "$creator 创建了群聊"
                text = str(json, "name").ifEmpty { "点击查看" }
                route = "/group/${json.opt("id")}"
                notifyId = "group${json.opt("id")}".hashCode()
            }
            "reply_ready" -> {
                val n = str(json, "character_name", "display_name")
                title = if (n.isEmpty()) "收到一封回信" else "$n 的回信"
                text = str(json, "title").ifEmpty { "点击查看回信" }
                route = "/mailbox"
                notifyId = "letter${json.opt("letter_id")}".hashCode()
            }
            // 失败终态：文案要说清"停了、要你处理"，而不是让人以为还在回信
            "reply_failed" -> {
                val n = str(json, "character_name", "display_name")
                title = if (n.isEmpty()) "有一封信没能送到" else "$n 的信没能送到"
                text = "已停止自动重试，点开可以重新投递"
                route = "/mailbox"
                notifyId = "letterfail${json.opt("letter_id")}".hashCode()
            }
            "new_event" -> {
                title = str(json, "title").ifEmpty { "新事件发生" }
                text = str(json, "description", "content").ifEmpty { "点击查看" }
                route = "/events"
                notifyId = "event${json.opt("id")}$event".hashCode()
            }
            else -> {   // 事件系统
                title = when (event) {
                    "event_concluded" -> "事件已结束"
                    else -> "事件已过期"
                }
                text = str(json, "title", "name", "summary", "description", "content").ifEmpty { "点击查看" }
                route = "/events"
                notifyId = "event${json.opt("id")}$event".hashCode()
            }
        }

        if (text.length > 100) text = text.take(100) + "…"

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra("route", route)
        }
        val pi = PendingIntent.getActivity(
            this, notifyId, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, category)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            // 同一会话的连发消息覆盖同一条通知时只响一次，避免群聊连环响铃
            .setOnlyAlertOnce(true)
            .build()

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return
        try {
            NotificationManagerCompat.from(this).notify(notifyId, notification)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS 未授权
        }
    }

    private fun str(j: JSONObject, vararg keys: String): String {
        for (k in keys) {
            val v = j.optString(k)
            if (v.isNotEmpty() && v != "null") return v
        }
        return ""
    }
}
