import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing: a keystore from the ANDROID_KEYSTORE_* secrets in CI, so
// every build is signed with the same key and installs as an update. Without
// them the debug key is used (a new install is then needed for each update).
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { file(it).exists() }

android {
    namespace = "ai.ultron.phone"
    compileSdk = 36

    defaultConfig {
        applicationId = "ai.ultron.phone"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0.$versionCode"
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: "ultron"
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD") ?: System.getenv("ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // The Anthropic SDK and Jackson rely on reflection; shrinking
            // would need a long keep list for a few MB saved.
            isMinifyEnabled = false
            signingConfig = if (keystorePath != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources {
            excludes += setOf(
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE*",
                "META-INF/NOTICE*",
                "META-INF/INDEX.LIST",
                "META-INF/*.version",
                "META-INF/versions/9/OSGI-INF/MANIFEST.MF",
                "META-INF/FastDoubleParser-*",
                "META-INF/{AL2.0,LGPL2.1}",
            )
        }
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":core"))
    // FileProvider, for handing the camera app a file to write the photo to.
    implementation("androidx.core:core:1.13.1")
    // Health Connect (steps, sleep, heart rate) and what it's built on.
    implementation("androidx.health.connect:connect-client:1.1.0")
    implementation("androidx.activity:activity:1.9.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
