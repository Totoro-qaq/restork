fn main() {
    const COMMANDS: &[&str] = &[
        "desktop_status",
        "desktop_session",
        "desktop_store_session",
        "desktop_update_recovery",
        "desktop_retry",
        "desktop_quit",
    ];

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Restork desktop permissions");
}
