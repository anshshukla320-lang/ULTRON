pluginManagement {
    repositories {
        // Only Android's own artifacts come from Google's repository.
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("androidx.*")
                includeGroupByRegex("com\\.google.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        id("com.android.application") version "8.10.1"
        id("org.jetbrains.kotlin.android") version "2.1.21"
        id("org.jetbrains.kotlin.jvm") version "2.1.21"
    }
}

dependencyResolutionManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("androidx.*")
                includeGroupByRegex("com\\.google.*")
            }
        }
        mavenCentral()
    }
}

rootProject.name = "ultron-android"

// ULTRON's brain, the PC link and the routing between them: plain Kotlin,
// buildable and testable anywhere.
include(":core")

// The Android app itself needs the Android SDK (ANDROID_HOME, or sdk.dir in
// local.properties). Without it, only :core is built — handy for working on
// the brain on a machine without Android Studio.
val localSdk = file("local.properties").takeIf { it.exists() }?.readLines()
    ?.firstOrNull { it.startsWith("sdk.dir=") }?.substringAfter("=")
if (System.getenv("ANDROID_HOME") != null || System.getenv("ANDROID_SDK_ROOT") != null || localSdk != null) {
    include(":app")
}
