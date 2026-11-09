plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.giraffe.music"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.giraffe.music"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.3.0"
        // El repo de GitHub de donde salen las actualizaciones ("usuario/repo"), en gradle.properties.
        buildConfigField("String", "UPDATE_REPO", "\"${project.findProperty("giraffe.updateRepo") ?: ""}\"")
    }

    // Llave de firma del proyecto (para que las actualizaciones se instalen encima).
    // Es de demostración: para publicar, generá una propia y no la subas al repo.
    signingConfigs {
        create("giraffe") {
            // La llave de firma NO está en el repo. Viene de variables de entorno: en GitHub
            // Actions, de los secretos del repo; en tu PC, exportalas antes de compilar.
            // Sin llave, se firma con la de depuración (sirve para probar, no para publicar).
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
        debug {
            signingConfig = signingConfigs.getByName("giraffe")
        }
    }

    // Un APK por arquitectura (más chico) y uno universal.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    // La interfaz (web/) va dentro del núcleo nativo; acá no hay assets.
    packaging {
        jniLibs.useLegacyPackaging = false
    }
}

dependencies {
    val media3 = "1.5.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-session:$media3")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.12.1")
}
