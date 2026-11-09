#!/usr/bin/env sh
# Compila Giraffe Music: el núcleo Rust para Android y después el APK.
# Requisitos: Rust + cargo-ndk, Android SDK con NDK 27 (ANDROID_HOME), Java 17+.
set -e
cd "$(dirname "$0")"
: "${ANDROID_HOME:?definí ANDROID_HOME con la ruta del Android SDK}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)}"

rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
command -v cargo-ndk >/dev/null || cargo install cargo-ndk

cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -P 26 -o android/app/src/main/jniLibs build --release --lib
cd android
./gradlew --max-workers=2 assembleRelease
echo
echo "Listo: android/app/build/outputs/apk/release/"
ls -1 app/build/outputs/apk/release/*.apk
