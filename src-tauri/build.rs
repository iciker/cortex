fn main() {
    // ScreenCaptureKit's Swift bridge links the concurrency runtime through
    // @rpath. Dependency build-script link arguments do not propagate to the
    // final Tauri executable, so declare the system Swift runtime search path
    // at the application target as well. The Frameworks path is where
    // swift-stdlib-tool places compatibility libraries in a bundled app.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }
    tauri_build::build()
}
