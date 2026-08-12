//! Native commands for checking, downloading, and scheduling desktop updates.

use super::*;
use crate::commands::require_dashboard_window;
use crate::update::UpdatePhase;
#[cfg(not(debug_assertions))]
use crate::update_runtime::desktop_updater;
use crate::update_runtime::persist_update_state;
#[cfg(not(debug_assertions))]
use crate::updates::archive_verified_update;

#[tauri::command]
pub(super) async fn desktop_check_for_updates(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<update::UpdateStatus, String> {
    {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "desktop_state_unavailable")?;
        require_dashboard_window(&window, inner.origin.as_deref())?;
    }
    {
        let mut coordinator = state
            .updates
            .lock()
            .map_err(|_| "update_state_unavailable")?;
        coordinator.begin_check().map_err(str::to_owned)?;
        emit_update_status(&app, &coordinator.status);
    }
    #[cfg(debug_assertions)]
    {
        let mut coordinator = state
            .updates
            .lock()
            .map_err(|_| "update_state_unavailable")?;
        coordinator.status.phase = UpdatePhase::PolicyRejected;
        coordinator.status.detail = Some("source_build_updates_are_manual");
        emit_update_status(&app, &coordinator.status);
        Ok(coordinator.status.clone())
    }
    #[cfg(not(debug_assertions))]
    {
        let channel = state
            .updates
            .lock()
            .map_err(|_| "update_state_unavailable")?
            .status
            .preferences
            .channel;
        let result = match desktop_updater(&app, channel) {
            Ok(updater) => updater.check().await,
            Err(error) => Err(error),
        };
        let mut coordinator = state
            .updates
            .lock()
            .map_err(|_| "update_state_unavailable")?;
        match result {
            Ok(candidate) => coordinator.checked(candidate.map(|item| item.version)),
            Err(_) => {
                coordinator.status.phase = UpdatePhase::CheckFailed;
                coordinator.status.detail = Some("update_check_failed");
            }
        }
        persist_update_state(&app, &coordinator);
        emit_update_status(&app, &coordinator.status);
        Ok(coordinator.status.clone())
    }
}

#[tauri::command]
pub(super) fn desktop_download_update(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    version: String,
) -> Result<update::UpdateStatus, String> {
    {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "desktop_state_unavailable")?;
        require_dashboard_window(&window, inner.origin.as_deref())?;
    }
    if version.len() > 64 || semver::Version::parse(&version).is_err() {
        return Err("update_version_invalid".into());
    }
    let mut coordinator = state
        .updates
        .lock()
        .map_err(|_| "update_state_unavailable")?;
    if !coordinator.status.can_self_update
        || coordinator.status.phase != UpdatePhase::Available
        || coordinator.status.available_version.as_deref() != Some(&version)
        || coordinator.download_task.is_some()
    {
        return Err("update_download_not_available".into());
    }
    coordinator.status.phase = UpdatePhase::Downloading;
    coordinator.status.progress_percent = Some(0);
    coordinator.status.detail = None;
    let task_app = app.clone();
    let expected_version = version.clone();
    let task = tauri::async_runtime::spawn(async move {
        download_verified_update(task_app, expected_version).await;
    });
    coordinator.download_task = Some(task);
    emit_update_status(&app, &coordinator.status);
    Ok(coordinator.status.clone())
}

#[tauri::command]
pub(super) fn desktop_cancel_update_download(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<update::UpdateStatus, String> {
    {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "desktop_state_unavailable")?;
        require_dashboard_window(&window, inner.origin.as_deref())?;
    }
    let mut coordinator = state
        .updates
        .lock()
        .map_err(|_| "update_state_unavailable")?;
    coordinator.cancel_download().map_err(str::to_owned)?;
    persist_update_state(&app, &coordinator);
    emit_update_status(&app, &coordinator.status);
    Ok(coordinator.status.clone())
}

#[tauri::command]
pub(super) fn desktop_schedule_update(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    mode: update::UpdateScheduleMode,
) -> Result<update::UpdateStatus, String> {
    {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "desktop_state_unavailable")?;
        require_dashboard_window(&window, inner.origin.as_deref())?;
    }
    let mut coordinator = state
        .updates
        .lock()
        .map_err(|_| "update_state_unavailable")?;
    coordinator.schedule(mode).map_err(str::to_owned)?;
    // Installing a Core or shell update while work is active can invalidate an
    // approval or interrupt a paid request. "Now" therefore means "at the next
    // clean launch" until Core exposes an authoritative idle lease.
    if mode == update::UpdateScheduleMode::Now {
        coordinator.status.phase = UpdatePhase::WaitingForIdle;
        coordinator.status.detail = Some("will_install_on_next_clean_launch");
    }
    persist_update_state(&app, &coordinator);
    emit_update_status(&app, &coordinator.status);
    Ok(coordinator.status.clone())
}

#[tauri::command]
pub(super) fn desktop_set_update_preferences(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    preferences: update::UpdatePreferences,
) -> Result<update::UpdateStatus, String> {
    {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "desktop_state_unavailable")?;
        require_dashboard_window(&window, inner.origin.as_deref())?;
    }
    let mut coordinator = state
        .updates
        .lock()
        .map_err(|_| "update_state_unavailable")?;
    coordinator.status.preferences = preferences;
    persist_update_state(&app, &coordinator);
    emit_update_status(&app, &coordinator.status);
    Ok(coordinator.status.clone())
}

#[tauri::command]
pub(super) fn desktop_dismiss_update(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    version: String,
) -> Result<update::UpdateStatus, String> {
    {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "desktop_state_unavailable")?;
        require_dashboard_window(&window, inner.origin.as_deref())?;
    }
    if version.len() > 64 || semver::Version::parse(&version).is_err() {
        return Err("update_version_invalid".into());
    }
    let mut coordinator = state
        .updates
        .lock()
        .map_err(|_| "update_state_unavailable")?;
    coordinator
        .dismiss_available(&version)
        .map_err(str::to_owned)?;
    persist_update_state(&app, &coordinator);
    emit_update_status(&app, &coordinator.status);
    Ok(coordinator.status.clone())
}

fn emit_update_status(app: &AppHandle, status: &update::UpdateStatus) {
    let _ = app.emit("restork://update-status", status);
}

#[cfg(not(debug_assertions))]
async fn download_verified_update(app: AppHandle, expected_version: String) {
    let result = async {
        let channel = app
            .state::<DesktopState>()
            .updates
            .lock()
            .map_err(|_| "update_state_unavailable")?
            .status
            .preferences
            .channel;
        let candidate = desktop_updater(&app, channel)
            .map_err(|_| "update_check_failed")?
            .check()
            .await
            .map_err(|_| "update_check_failed")?
            .ok_or("update_no_longer_available")?;
        if candidate.version != expected_version
            || candidate.download_url.scheme() != "https"
            || !candidate.download_url.username().is_empty()
            || candidate.download_url.password().is_some()
        {
            return Err("update_policy_rejected");
        }
        let bytes = candidate
            .download(
                {
                    let app = app.clone();
                    let mut downloaded = 0_u64;
                    move |chunk, total| {
                        downloaded = downloaded.saturating_add(chunk as u64);
                        if let Ok(mut coordinator) = app.state::<DesktopState>().updates.lock() {
                            coordinator.status.progress_percent =
                                total.filter(|total| *total > 0).map(|total| {
                                    ((downloaded.saturating_mul(100) / total).min(99)) as u8
                                });
                            emit_update_status(&app, &coordinator.status);
                        }
                    }
                },
                || {},
            )
            .await
            .map_err(|_| "update_verification_failed")?;
        let data_root = app
            .path()
            .app_data_dir()
            .map_err(|_| "update_archive_unavailable")?;
        let storage = UpdateStorage::open(&data_root)?;
        archive_verified_update(&storage, &candidate.version, &candidate.target, &bytes)?;
        Ok::<(), &'static str>(())
    }
    .await;
    if let Ok(mut coordinator) = app.state::<DesktopState>().updates.lock() {
        coordinator.download_task = None;
        coordinator.status.progress_percent = None;
        match result {
            Ok(()) => {
                coordinator.status.phase = UpdatePhase::ReadyToRestart;
                coordinator.status.detail = None;
            }
            Err("update_policy_rejected") => {
                coordinator.status.phase = UpdatePhase::PolicyRejected;
                coordinator.status.detail = Some("update_policy_rejected");
            }
            Err("update_verification_failed") => {
                coordinator.status.phase = UpdatePhase::VerificationFailed;
                coordinator.status.detail = Some("update_verification_failed");
            }
            Err(detail) => {
                coordinator.status.phase = UpdatePhase::InstallFailed;
                coordinator.status.detail = Some(detail);
            }
        }
        persist_update_state(&app, &coordinator);
        emit_update_status(&app, &coordinator.status);
    }
}

#[cfg(debug_assertions)]
async fn download_verified_update(app: AppHandle, _expected_version: String) {
    if let Ok(mut coordinator) = app.state::<DesktopState>().updates.lock() {
        coordinator.download_task = None;
        coordinator.status.phase = UpdatePhase::PolicyRejected;
        coordinator.status.progress_percent = None;
        coordinator.status.detail = Some("source_build_updates_are_manual");
        persist_update_state(&app, &coordinator);
        emit_update_status(&app, &coordinator.status);
    }
}
