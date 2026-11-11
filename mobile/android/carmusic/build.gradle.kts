plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Giraffe CarMusic: app independiente para el auto (Android Auto) con una pantalla liviana en el
// celular. Lleva el mismo núcleo en Rust que Giraffe Music; si Giraffe está instalada, se vincula
// con ella (misma cuenta, mismas descargas).
android {
    namespace = "com.giraffe.carmusic"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.giraffe.carmusic"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        // Los celulares con Android Auto son ARM: así el APK pesa la mitad.
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
        buildConfigField("String", "UPDATE_REPO", "\"${project.findProperty("giraffe.updateRepo") ?: ""}\"")
    }

    // La misma llave que Giraffe: así el puente entre las dos apps las reconoce.
    signingConfigs {
        create("giraffe") {
            val ks = System.getenv("GIRAFFE_KEYSTORE")?.let { file(it) }?.takeIf { it.exists() }
            if (ks != null) {
                storeFile = ks
                storePassword = System.getenv("GIRAFFE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("GIRAFFE_KEY_ALIAS") ?: "giraffe"
                keyPassword = System.getenv("GIRAFFE_KEY_PASSWORD") ?: System.getenv("GIRAFFE_KEYSTORE_PASSWORD")
            } else {
                initWith(getByName("debug"))
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("giraffe")
        }
    }
    // El núcleo (libgiraffe.so) es el mismo que compila Giraffe Music.
    sourceSets["main"].jniLibs.srcDirs("../app/src/main/jniLibs")
    packaging { jniLibs { useLegacyPackaging = false } }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-session:1.5.1")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}
