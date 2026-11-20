package com.linshe.shell

import android.Manifest
import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.ContentValues
import android.content.Intent
import android.graphics.BitmapFactory
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.View
import android.webkit.ValueCallback
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.graphics.Outline
import android.media.MediaScannerConnection
import android.view.MotionEvent
import android.view.ViewOutlineProvider
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import java.io.File

class MainActivity : AppCompatActivity() {

    companion object {
        private const val PREFS_NAME = "shell"
        private const val KEY_URL = "url"

        /** 通知服务据此判断 App 是否在前台（前台时不弹系统通知） */
        @Volatile
        var inForeground = false
    }

    private lateinit var webView: WebView
    private lateinit var setupPanel: View
    private lateinit var urlInput: EditText
    private lateinit var hintText: TextView

    private val prefs by lazy { getSharedPreferences(PREFS_NAME, MODE_PRIVATE) }

    /**
     * P0-03：判断某个 URL 是否属于「已批准来源」。
     *
     * 已批准来源 = 用户在设置页填的那个服务地址的 origin（scheme + host + port）。
     * 只有它能在 WebView 内部导航；其它一切（外链、别的站点、非 http 协议）
     * 都交给系统浏览器/处理器，壳内不再承载，因此也拿不到原生桥。
     *
     * 用 Uri 解析而不是字符串前缀比较：`http://192.168.1.5:3099.evil.com` 这种
     * 前缀攻击用 startsWith 是挡不住的。
     */
    private fun isApprovedOrigin(target: Uri): Boolean {
        val approved = runCatching { Uri.parse(prefs.getString(KEY_URL, null) ?: return false) }.getOrNull()
            ?: return false
        if (approved.scheme != target.scheme) return false
        if (!approved.host.equals(target.host, ignoreCase = true)) return false
        val approvedPort = if (approved.port > 0) approved.port else defaultPortFor(approved.scheme)
        val targetPort = if (target.port > 0) target.port else defaultPortFor(target.scheme)
        return approvedPort == targetPort
    }

    private fun defaultPortFor(scheme: String?): Int = when (scheme?.lowercase()) {
        "https" -> 443
        "http" -> 80
        else -> -1
    }

    /**
     * 桥方法的第一道闸：当前页面必须仍在已批准来源上。
     *
     * addJavascriptInterface 挂上之后对所有页面可见，无法按页面撤销；
     * 所以每个桥方法自己先确认「现在这个页面是不是我们的」。
     * 页面若被重定向到外站（shouldOverrideUrlLoading 已拦，这里是第二道），
     * 桥调用会直接失败而不是默默执行。
     */
    private fun requireApprovedOrigin(): String? {
        val current = webView.url ?: return "当前没有已加载的页面"
        val uri = runCatching { Uri.parse(current) }.getOrNull() ?: return "页面地址无效"
        return if (isApprovedOrigin(uri)) null else "当前页面不是已批准来源，原生桥不可用"
    }

    private val notifyToggleIds = mapOf(
        SseNotificationService.CAT_CHAT to R.id.notifyChat,
        SseNotificationService.CAT_MOMENTS to R.id.notifyMoments,
        SseNotificationService.CAT_COMMENTS to R.id.notifyComments,
        SseNotificationService.CAT_GROUP to R.id.notifyGroup,
        SseNotificationService.CAT_MAILBOX to R.id.notifyMailbox,
        SseNotificationService.CAT_EVENTS to R.id.notifyEvents,
    )

    // <input type="file"> 支持（头像上传等）
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        fileChooserCallback?.onReceiveValue(
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        )
        fileChooserCallback = null
    }

    private val notifPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* 拒绝也不阻塞，网页功能不受影响 */ }

    // ── 网页相册保存（AndroidBridge.saveImage）──

    /** API 26–28 缺存储权限时暂存待保存任务，授权后落盘 */
    private var pendingSave: (() -> Unit)? = null

    private val writePermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val job = pendingSave
        pendingSave = null
        if (granted && job != null) {
            runCatching {
                job()
                Toast.makeText(this, "已保存到相册", Toast.LENGTH_SHORT).show()
            }.onFailure {
                Toast.makeText(this, "保存失败: ${it.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        configureTaskDescription()

        webView = findViewById(R.id.webView)
        setupPanel = findViewById(R.id.setupPanel)
        urlInput = findViewById(R.id.urlInput)
        hintText = findViewById(R.id.hintText)

        // logo 圆角裁切
        findViewById<ImageView>(R.id.heroIcon).apply {
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    val r = 20f * resources.displayMetrics.density
                    outline.setRoundRect(0, 0, view.width, view.height, r)
                }
            }
        }

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            // P0-03：不再全局放行混合内容。
            // 原来 MIXED_CONTENT_ALWAYS_ALLOW 会让 HTTPS 页面里的 HTTP 资源照常加载，
            // 在不可信网络上等于放弃传输保密性。Compatibility 只放行"被动混合内容"
            // （图片等），脚本类混合内容仍然拦截。
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            useWideViewPort = true
            loadWithOverviewMode = true
        }

        // 网页调用的原生存储桥（图片详情「下载」按钮），见 web-ui ImageLightbox。
        // P0-03：桥对象仍常驻（addJavascriptInterface 无法按页面切换），
        // 但 WebBridge 的每个方法都会先校验当前页面 origin，
        // 不是已批准来源就抛错——见 WebBridge 内的 requireApprovedOrigin。
        webView.addJavascriptInterface(WebBridge(), "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                val url = request.url
                // P0-03：只允许在 WebView 内部导航到**已批准来源**。
                // 原来是「http/https 一律放行」，于是用户点一条外链就留在壳里，
                // 而壳里挂着原生桥 —— 第三方页面因此获得了保存文件等能力。
                // 现在：已批准来源留在 WebView；其它 http(s) 与所有非 http 协议交系统浏览器/处理器。
                if (isApprovedOrigin(url)) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                return true
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    showSetup("无法连接：${error.description}\n请确认地址正确且服务已启动")
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                return try {
                    fileChooserLauncher.launch(params.createIntent())
                    true
                } catch (e: Exception) {
                    fileChooserCallback = null
                    false
                }
            }
        }

        findViewById<TextView>(R.id.hideServiceNotifyBtn).setOnClickListener {
            // 跳到「后台连接」渠道的系统设置页，用户关掉即可隐藏常驻通知（服务不受影响）
            SseNotificationService.ensureChannels(this)
            runCatching {
                startActivity(Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    putExtra(Settings.EXTRA_CHANNEL_ID, SseNotificationService.SERVICE_CHANNEL_ID)
                })
            }
        }

        findViewById<TextView>(R.id.goBackgroundSettingsBtn).setOnClickListener {
            // 应用详情页：后台权限（无限制）、自启动、电池策略都在这里设置
            runCatching {
                startActivity(Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:$packageName")
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }

        setupSwipeToConfirm()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val savedUrl = prefs.getString(KEY_URL, null)
                when {
                    // 设置页按返回：已有保存地址则回到网页
                    setupPanel.visibility == View.VISIBLE && savedUrl != null
                            && webView.url != null -> showWeb()
                    webView.visibility == View.VISIBLE -> handleWebBack()
                    else -> confirmExit()
                }
            }
        })

        val savedUrl = prefs.getString(KEY_URL, null)
        val initialRoute = intent?.getStringExtra("route")
        intent?.removeExtra("route")
        if (savedUrl != null) {
            showWeb()
            // 冷启动带路由（点通知拉起）：直接加载目标页，避免先加载首页再跳转
            val target = if (initialRoute != null)
                savedUrl.trimEnd('/') + "/#" + initialRoute
            else savedUrl
            webView.loadUrl(target)
            syncNotificationService()
        } else {
            showSetup(null)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleRoute(intent)
    }

    /** 通知点击 → 跳转对应页面（hash 路由） */
    private fun handleRoute(intent: Intent?) {
        val route = intent?.getStringExtra("route") ?: return
        intent.removeExtra("route")
        val base = prefs.getString(KEY_URL, null) ?: return
        showWeb()
        val current = webView.url
        if (current != null && current.startsWith(base.trimEnd('/'))) {
            // SPA 已加载：原地改 hash 触发 vue-router 跳转，避免整页刷新。
            // 所有通知点击都先通知前端收起移动端角色列表。
            webView.evaluateJavascript(
                "window.dispatchEvent(new Event('linshe:notification-opened'));",
                null
            )
            // 重复点击朋友圈通知时 hash 不会变化，额外通知前端执行与 Navbar 重复点击相同的刷新动作。
            if (route == "/moments") {
                webView.evaluateJavascript(
                    """
                    if (window.location.hash === '#/moments') {
                        window.dispatchEvent(new CustomEvent('linshe:route-reselected', { detail: { route: '/moments' } }));
                    } else {
                        window.location.hash = '#/moments';
                    }
                    """.trimIndent(),
                    null
                )
            } else {
                webView.evaluateJavascript("window.location.hash = '#$route';", null)
            }
        } else {
            webView.loadUrl(base.trimEnd('/') + "/#" + route)
        }
    }

    override fun onResume() {
        super.onResume()
        inForeground = true
    }

    override fun onPause() {
        inForeground = false
        super.onPause()
    }

    @Suppress("DEPRECATION")
    private fun configureTaskDescription() {
        val label = getString(R.string.app_title)
        val color = getColor(R.color.page_bg)
        setTaskDescription(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ActivityManager.TaskDescription(label, R.mipmap.ic_launcher, color)
        } else {
            val icon = BitmapFactory.decodeResource(resources, R.drawable.ic_launcher_image)
            ActivityManager.TaskDescription(label, icon, color)
        })
    }

    private fun handleWebBack() {
        webView.evaluateJavascript(
            """(function() {
                try {
                    return typeof window.__linsheHandleAndroidBack === 'function'
                        && window.__linsheHandleAndroidBack();
                } catch (_) {
                    return false;
                }
            })();""".trimIndent()
        ) { handled ->
            if (handled != "true") moveTaskToBack(true)
        }
    }

    // ── 上滑确认（代替保存按钮：滑动过程即执行保存动作）──

    private fun setupSwipeToConfirm() {
        // 箭头持续上浮提示
        val chevron = findViewById<View>(R.id.swipeChevron)
        ObjectAnimator.ofFloat(chevron, "translationY", 0f, -10f, 0f).apply {
            duration = 1400
            repeatCount = ValueAnimator.INFINITE
            start()
        }

        val threshold = 110f * resources.displayMetrics.density
        var downY = 0f
        findViewById<View>(R.id.swipeBar).setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downY = e.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dy = e.rawY - downY
                    // 整个欢迎页跟手上移（带一点阻尼）
                    setupPanel.translationY = if (dy < 0) dy / 1.4f else 0f
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    val dy = e.rawY - downY
                    if (dy < -threshold && performSave()) {
                        // 越过阈值且保存成功：整页上滑退场，进入网页
                        setupPanel.animate()
                            .translationY(-setupPanel.height.toFloat())
                            .setDuration(220)
                            .withEndAction {
                                showWeb()
                                setupPanel.translationY = 0f
                            }
                            .start()
                    } else {
                        if (dy < -threshold) hintText.text = getString(R.string.url_empty_hint)
                        setupPanel.animate().translationY(0f).setDuration(180).start()
                    }
                    true
                }
                else -> false
            }
        }
    }

    /** 保存地址与通知开关并开始加载网页；地址为空返回 false */
    private fun performSave(): Boolean {
        var url = urlInput.text.toString().trim()
        if (url.isEmpty()) return false
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://$url"
        }
        val editor = prefs.edit().putString(KEY_URL, url)
        for ((cat, id) in notifyToggleIds) {
            editor.putBoolean("notify_$cat", findViewById<CompoundButton>(id).isChecked)
        }
        editor.apply()
        syncNotificationService(interactive = true)
        webView.loadUrl(url)
        return true
    }

    // ── 通知服务管理 ──

    /**
     * @param interactive 仅在用户主动操作（点保存）时为 true，此时才弹权限/白名单请求；
     *                    App 启动时静默启停服务，避免拒绝过的用户每次打开都被弹窗骚扰
     */
    private fun syncNotificationService(interactive: Boolean = false) {
        val intent = Intent(this, SseNotificationService::class.java)
        val url = prefs.getString(KEY_URL, null)
        if (url != null && SseNotificationService.anyCategoryEnabled(this)) {
            if (interactive) {
                if (Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED
                ) {
                    notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
                requestBatteryExemption()
            }
            startForegroundService(intent)
        } else {
            stopService(intent)
        }
    }

    /** 引导用户把 App 加入电池优化白名单，否则锁屏后 SSE 连接会被 Doze 掐断 */
    @SuppressLint("BatteryLife")
    private fun requestBatteryExemption() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            runCatching {
                startActivity(
                    Intent(
                        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:$packageName")
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        }
    }

    // ── 视图切换 ──

    /**
     * 暴露给 WebView 的原生桥。返回值约定（同步）：
     * "ok" 成功；"permission_pending" 已发起存储权限弹窗，授权后自动落盘；其余为错误信息。
     */
    inner class WebBridge {
        /**
         * P0-02：网页配对成功后把设备令牌下发给原生层，供后台 SSE 使用。
         *
         * 网页里的 HttpOnly Cookie 不会共享给 HttpURLConnection，所以后台通知
         * 必须有自己的凭证。令牌由服务端按设备签发，网页拿到后经这里交过来，
         * 加密存在 Keystore 保护的偏好里。
         *
         * 与 saveImage 同样先过 origin 校验：只有我们的页面才能下发/清除令牌。
         */
        @JavascriptInterface
        fun setDeviceToken(token: String?): String {
            requireApprovedOrigin()?.let { return it }
            DeviceTokenStore.save(this@MainActivity, token)
            return "ok"
        }

        /** 当前是否已有设备令牌（网页据此显示「后台通知已授权」） */
        @JavascriptInterface
        fun hasDeviceToken(): Boolean {
            if (requireApprovedOrigin() != null) return false
            return DeviceTokenStore.hasToken(this@MainActivity)
        }

        @JavascriptInterface
        fun saveImage(name: String?, dataUrl: String?): String {
            // P0-03：先确认当前页面仍属于已批准来源，否则拒绝执行
            requireApprovedOrigin()?.let { return it }
            val mime = Regex("^data:(image/[a-z0-9.+-]+);base64,").find(dataUrl ?: "")?.groupValues?.get(1)
                ?: return "图片数据格式错误"
            val base64 = (dataUrl ?: "").substringAfter(";base64,", "")
            if (base64.isEmpty()) return "图片数据格式错误"
            val bytes = try {
                Base64.decode(base64, Base64.DEFAULT)
            } catch (_: IllegalArgumentException) {
                return "图片数据解码失败"
            }
            val cleanName = (name ?: "")
                .replace(Regex("[\\\\/:*?\"<>|]"), "_")
                .trim()
                .ifEmpty { "image.${extForMime(mime)}" }

            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    saveViaMediaStore(cleanName, mime, bytes)
                } else if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    == PackageManager.PERMISSION_GRANTED
                ) {
                    saveToPublicPictures(cleanName, mime, bytes)
                } else {
                    pendingSave = { saveToPublicPictures(cleanName, mime, bytes) }
                    runOnUiThread {
                        writePermLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    }
                    return "permission_pending"
                }
                "ok"
            } catch (e: Exception) {
                e.message ?: "保存失败"
            }
        }
    }

    private fun extForMime(mime: String): String = when (mime) {
        "image/jpeg" -> "jpg"
        "image/webp" -> "webp"
        "image/gif" -> "gif"
        else -> "png"
    }

    /** Android 10+：写入公共相册 Pictures/邻舍，无需存储权限 */
    private fun saveViaMediaStore(displayName: String, mime: String, bytes: ByteArray) {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/邻舍")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("无法写入相册")
        try {
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: throw IllegalStateException("无法写入相册")
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
        } catch (e: Exception) {
            contentResolver.delete(uri, null, null)
            throw e
        }
    }

    /** Android 8–9：写公共 Pictures 目录并触发媒体扫描（需已授权 WRITE_EXTERNAL_STORAGE） */
    private fun saveToPublicPictures(displayName: String, mime: String, bytes: ByteArray) {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "邻舍")
        if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("无法创建相册目录")
        val file = uniqueFile(dir, displayName)
        file.writeBytes(bytes)
        MediaScannerConnection.scanFile(this, arrayOf(file.absolutePath), arrayOf(mime), null)
    }

    private fun uniqueFile(dir: File, name: String): File {
        var file = File(dir, name)
        if (!file.exists()) return file
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var i = 1
        while (file.exists()) {
            file = File(dir, "$stem ($i)$ext")
            i++
        }
        return file
    }

    private fun showWeb() {
        // 状态栏跟随页面配色：网页为暖米白
        window.statusBarColor = getColor(R.color.page_bg)
        window.navigationBarColor = getColor(R.color.page_bg)
        setupPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
    }

    private fun showSetup(error: String?) {
        // 状态栏跟随页面配色：欢迎页为冷蓝白
        window.statusBarColor = getColor(R.color.setup_bg)
        window.navigationBarColor = getColor(R.color.setup_bg)
        urlInput.setText(prefs.getString(KEY_URL, "") ?: "")
        for ((cat, id) in notifyToggleIds) {
            findViewById<CompoundButton>(id).isChecked =
                prefs.getBoolean("notify_$cat", SseNotificationService.defaultFor(cat))
        }
        hintText.text = error ?: getString(R.string.setup_hint)
        webView.visibility = View.GONE
        setupPanel.visibility = View.VISIBLE
    }

    private fun confirmExit() {
        AlertDialog.Builder(this)
            .setMessage(R.string.exit_confirm)
            .setPositiveButton(R.string.exit) { _, _ -> finish() }
            .setNegativeButton(R.string.change_url) { _, _ -> showSetup(null) }
            .setNeutralButton(R.string.cancel, null)
            .show()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
