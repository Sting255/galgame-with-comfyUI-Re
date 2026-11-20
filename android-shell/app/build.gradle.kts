import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val signingProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.isFile) file.inputStream().use { load(it) }
}
fun signingValue(name: String): String? =
    System.getenv(name)?.takeIf { it.isNotBlank() }
        ?: signingProperties.getProperty(name)?.takeIf { it.isNotBlank() }

val releaseSigning = listOf(
    "LINSHE_RELEASE_KEYSTORE",
    "LINSHE_RELEASE_STORE_PASSWORD",
    "LINSHE_RELEASE_KEY_ALIAS",
    "LINSHE_RELEASE_KEY_PASSWORD",
).associateWith(::signingValue)
val missingReleaseSigning = releaseSigning.filterValues { it == null }.keys
val releaseStoreFile = releaseSigning["LINSHE_RELEASE_KEYSTORE"]?.let(rootProject::file)

android {
    namespace = "com.linshe.shell"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.linshe.shell"
        minSdk = 26
        targetSdk = 34
        versionCode = 12
        versionName = "2.1"
    }

    signingConfigs {
        create("release") {
            releaseStoreFile?.let { storeFile = it }
            releaseSigning["LINSHE_RELEASE_STORE_PASSWORD"]?.let { storePassword = it }
            releaseSigning["LINSHE_RELEASE_KEY_ALIAS"]?.let { keyAlias = it }
            releaseSigning["LINSHE_RELEASE_KEY_PASSWORD"]?.let { keyPassword = it }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 缺签名配置时由 validateReleaseSigning 明确失败，绝不静默回退 debug。
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        // 自用壳应用，lint 问题不阻塞 release 构建
        checkReleaseBuilds = false
        abortOnError = false
    }
}

val validateReleaseSigning = tasks.register("validateReleaseSigning") {
    doLast {
        if (missingReleaseSigning.isNotEmpty()) {
            throw GradleException(
                "release 缺少签名配置：${missingReleaseSigning.joinToString()}。" +
                    "请用同名环境变量或 android-shell/local.properties 注入；不会回退 debug 签名。"
            )
        }
        if (releaseStoreFile?.isFile != true) {
            throw GradleException("LINSHE_RELEASE_KEYSTORE 指向的私钥文件不存在")
        }
    }
}
tasks.configureEach {
    if (name == "assembleRelease" || name == "packageRelease" || name == "bundleRelease") {
        dependsOn(validateReleaseSigning)
    }
}

// 同步应用图标：android-shell/app-icon.png|jpg → res/drawable-nodpi/ic_launcher_image.*
// 放在 gradle 层保证 npm run apk 与 Android Studio 两条构建路径都生效（res 内为派生产物，不入库）
val syncAppIcon = tasks.register("syncAppIcon") {
    doLast {
        val src = listOf("png", "jpg")
            .map { File(rootProject.projectDir, "app-icon.$it") }
            .firstOrNull { it.exists() }
        val resDir = File(projectDir, "src/main/res/drawable-nodpi")
        if (src != null) {
            resDir.mkdirs()
            src.copyTo(File(resDir, "ic_launcher_image.${src.extension}"), overwrite = true)
            val stale = File(resDir, "ic_launcher_image.${if (src.extension == "jpg") "png" else "jpg"}")
            if (stale.exists()) stale.delete()
        } else if (!File(resDir, "ic_launcher_image.png").exists() &&
            !File(resDir, "ic_launcher_image.jpg").exists()
        ) {
            throw GradleException("缺少应用图标：请在 android-shell/ 下放置 app-icon.png 或 app-icon.jpg")
        }
    }
}
tasks.named("preBuild") { dependsOn(syncAppIcon) }

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
}
