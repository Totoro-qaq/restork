fn main() {
    const COMMANDS: &[&str] = &[
        "desktop_status",
        "desktop_session",
        "desktop_store_session",
        "desktop_update_recovery",
        "desktop_update_status",
        "desktop_check_for_updates",
        "desktop_download_update",
        "desktop_schedule_update",
        "desktop_cancel_update_download",
        "desktop_set_update_preferences",
        "desktop_dismiss_update",
        "desktop_vault_config",
        "desktop_choose_vault",
        "desktop_apply_vault",
        "desktop_choose_workspace",
        "desktop_import_skill_folder",
        "desktop_preview_skill_import",
        "desktop_install_skill_import",
        "desktop_configure_provider_secret",
        "desktop_onboarding_state",
        "desktop_set_onboarding_dismissed",
        "desktop_open_external",
        "desktop_retry",
        "desktop_quit",
    ];

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Restork desktop permissions");
}
