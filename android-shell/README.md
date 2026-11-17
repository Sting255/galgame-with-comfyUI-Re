# android-shell — 邻舍安卓网页壳

> **本目录自 2026-11-16 起不再维护。** 产品范围收敛为 Windows 桌面端：
> 发布链不再构建或打包 APK，`npm run apk` 仅作自用/回溯保留，不计入交付与验收。
> 手机端改用浏览器访问电脑端显示的局域网地址。

单 Activity + WebView 套壳应用：

- 首次启动输入后端地址（如 `http://192.168.1.100:3099`），保存到 SharedPreferences
- **只允许导航到该地址的 origin**：外链一律交给系统浏览器，壳内不承载第三方页面
  （原生桥只对已批准来源开放；混合内容按 Compatibility 模式处理，不再全局放行）
- 网页内按返回键先打开角色列表，再按一次把 App 退到桌面；地址设置页保留退出确认
- 支持 `<input type="file">` 文件上传（头像上传）
- 明文 HTTP 仅用于受信局域网；跨不可信网络请自行配 HTTPS
- 后台通知使用设备令牌（`Authorization: Bearer`），令牌由网页配对后经原生桥下发，
  用 Android Keystore 的 AES-GCM 加密保存；401/403 时停止重连并提示重新配对
- release 使用本机私钥签名，仓库不再携带固定 keystore 或密码；缺配置会明确失败，不会回退 debug 签名。
  `assembleDebug` 仍使用 Android 默认 debug 签名，不受 release 配置影响。
- 旧固定签名已轮换：旧签名 APK 升级前必须先备份并卸载，再安装新签名 APK，步骤见下文。

## 依赖可复现性（P2-08 现状，如实记录）

- **直接依赖已固定精确版本**：`app/build.gradle.kts` 里
  `androidx.appcompat:appcompat:1.7.0` 与根 `build.gradle.kts` 的 AGP 8.5.2、Kotlin 1.9.24
  都是不带 `+` 的具体版本。
- **传递依赖尚未锁定**：仓库里没有 `gradle/verification-metadata.xml`，也没有
  `dependencyLocking` 配置。也就是说 AGP 解析出的二级依赖（以及它们的校验和）
  仍可能随仓库元数据变化。补齐它需要在能联网的环境里跑一次
  `./gradlew --write-verification-metadata sha256 assembleRelease`，
  本仓当前没有可用的 Gradle 工具链，所以**这一项未做**。
- 发布时应记录本次实际使用的 `gradlew` 版本与构建产物哈希；APK 的版本号来自
  `app/build.gradle.kts` 的 `versionName`，与桌面端 VERSION 相互独立。

## release 签名配置（只保存在本机）

可以通过同名环境变量注入，也可以写入已被 `.gitignore` 忽略的 `android-shell/local.properties`；环境变量优先。四项缺一不可：

```properties
LINSHE_RELEASE_KEYSTORE=C:/secure/linshe.jks
LINSHE_RELEASE_STORE_PASSWORD=替换为本机随机密码
LINSHE_RELEASE_KEY_ALIAS=linshe
LINSHE_RELEASE_KEY_PASSWORD=替换为本机随机密码
```

`LINSHE_RELEASE_KEYSTORE` 可写绝对路径或相对 `android-shell/` 的路径。**在 Java Properties 中，Windows 绝对路径必须用正斜杠或双反斜杠**：推荐 `C:/secure/linshe.jks`；若写反斜杠则必须是 `C:\\secure\\linshe.jks`，单个 `\` 可能被当成转义。`android-shell/*.jks`、`*.keystore`、`*.p12`、`*.pfx`、`keystores/` 与 `local.properties` 均已忽略，**不要把新私钥或密码提交、发聊天或写进构建日志**。

私钥和密码由你自行备份；丢失后无法给同一签名 lineage 继续发布覆盖升级包。`npm run apk` 会继承环境变量，并在写入便携 SDK 路径时保留 `local.properties` 中的签名项。

### 旧签名 APK 的迁移

1. 在电脑网页「设置 → 数据备份」导出全部数据，需要换机配置时勾选「包含模型配置」。
2. 卸载手机上的旧签名 APK。
3. 安装使用本机新私钥签名的 APK，重新连接电脑并输入配对码。
4. 在电脑网页恢复刚才导出的备份并等待重启完成。

## 通知推送（仅局域网内生效）

前台服务（SseNotificationService）保持一条到 `/api/stream` 的原生 SSE 长连接，
App 退到后台/锁屏后仍能收事件并弹系统通知，点击通知跳转对应页面。

| 通知类别 (channel) | 对应 SSE 事件 | 点击跳转 |
|---|---|---|
| 聊天消息 | proactive_message, delayed_reply | /chat/:id |
| 朋友圈 | new_post, new_comment | /moments |
| 群聊 | group_message, group_created | /group/:id |
| 信箱 | reply_ready, reply_failed | /mailbox |
| 事件 | new_event, event_concluded, event_expired | /events |

- 分类开关：App 内设置页（地址输入页）有 6 个复选框（聊天 / 朋友圈 / 评论 / 群聊 / 信箱 / 事件）；系统设置的通知渠道里也能按类关闭
- App 在前台时不弹通知（页面内已有红点/实时追加）
- 断线指数退避重连（5s→60s 封顶），服务端心跳 30s、客户端 90s 读超时判死链
- 后台通知使用**独立设备令牌**（`Authorization: Bearer`，网页配对成功后经原生桥下发，
  Keystore 加密保存）；401/403 时停止重连并提示重新配对，不会无限重试
- 保活依赖：电池优化白名单（保存时自动弹引导）；国产 ROM 还需手动允许「自启动 + 无限制后台」
- 开机自启：BootReceiver（同样受 ROM 自启动白名单限制）

## 构建方式

**方式一（推荐）**：项目根目录 `npm run apk`，脚本（scripts/build-apk.mjs）会自动下载便携
JDK 17 / Android SDK / Gradle 到 `launcher/build_cache/android-toolchain/`（仅构建缓存，
不进发布包），产物在 `app/build/outputs/apk/release/app-release.apk`。

**方式二**：`npm run release` 会调用同一构建逻辑，并把成功产出的 APK 打入发布压缩包。
**当前限制**：APK 构建失败只警告、不阻断 release；因此不能把构建成功的桌面包当作已包含 Android 的完整交付包，须先检查 APK 产物与版本。

**方式三**：用 Android Studio 打开本目录，直接构建。

源码已入库；构建产物（`app/build/`、`.gradle/`）与本地配置（`local.properties`）被 `.gitignore` 忽略。
发布物为 `npm run release` 打入压缩包的 APK。

## 应用图标

图标源文件是本目录下的 **`app-icon.png` 或 `app-icon.jpg`**（任意正方形图，建议 ≥256px，
两者都存在时 png 优先）。构建时由 gradle 的 `syncAppIcon` 任务（preBuild 前置）自动同步到
`app/src/main/res/drawable-nodpi/ic_launcher_image.*`（该 res 文件是派生产物，不入库），
`npm run apk` 与 Android Studio 两条构建路径均生效；两处源图都缺失时构建会报错提示。
**换图标 = 覆盖 `app-icon.png|jpg` 后重新构建**，无需改代码。
它同时用于桌面图标（全出血自适应，边缘约 1/4 会被启动器蒙版裁掉，主体放中间）和 App 内欢迎页。
