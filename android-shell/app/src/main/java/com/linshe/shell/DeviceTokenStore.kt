package com.linshe.shell

import android.content.Context
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.util.Base64

/**
 * 设备配对令牌（P0-02）。
 *
 * 背景：远程 `/api/stream` 需要配对凭证，而网页里的 HttpOnly Cookie 不会共享给
 * 原生 `HttpURLConnection`。原来的原生 SSE 只带 `Accept` 头 ⇒ 网页配对成功、
 * 后台通知永远收不到，且 401 被当成普通断线无限重连。
 *
 * 现在的口径：
 *   · 网页配对成功后，通过受 origin 保护的原生桥把**设备令牌**下发给原生层；
 *   · 令牌用 Android Keystore 里的 AES-GCM 密钥加密后存在 SharedPreferences，
 *     不以明文落盘，也不进系统自动备份；
 *   · 原生 SSE 用 `Authorization: Bearer <token>` 连接；
 *   · 401/403 时清空令牌并提示重新配对，不再无限重试。
 *
 * 注意：这不是根配对码。根配对码只用于一次性配对，长期凭证是这台设备专属的令牌。
 */
object DeviceTokenStore {
    private const val TAG = "DeviceTokenStore"
    private const val PREFS = "shell"
    private const val KEY_TOKEN = "device_token_enc"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "linshe_device_token_key"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance("AES", KEYSTORE)
        generator.init(
            android.security.keystore.KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or
                    android.security.keystore.KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return generator.generateKey()
    }

    /** 保存设备令牌（来自网页配对）；传空值等于清除 */
    fun save(ctx: Context, token: String?) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (token.isNullOrBlank()) {
            prefs.edit().remove(KEY_TOKEN).apply()
            return
        }
        runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
            // iv + 密文一起存：GCM 的 IV 每次不同，解密时必须原样取回
            val payload = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
                Base64.encodeToString(encrypted, Base64.NO_WRAP)
            prefs.edit().putString(KEY_TOKEN, payload).apply()
        }.onFailure { Log.w(TAG, "保存设备令牌失败", it) }
    }

    /** 读取设备令牌；没有或解密失败返回 null */
    fun load(ctx: Context): String? {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val payload = prefs.getString(KEY_TOKEN, null) ?: return null
        return runCatching {
            val (ivPart, dataPart) = payload.split(":", limit = 2)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(128, Base64.decode(ivPart, Base64.NO_WRAP))
            )
            String(cipher.doFinal(Base64.decode(dataPart, Base64.NO_WRAP)), Charsets.UTF_8)
        }.getOrElse {
            // 密钥被系统清掉（换机/恢复备份）时解密必然失败：当作未配对处理
            Log.w(TAG, "读取设备令牌失败，按未配对处理", it)
            prefs.edit().remove(KEY_TOKEN).apply()
            null
        }
    }

    fun hasToken(ctx: Context): Boolean = load(ctx) != null
}
