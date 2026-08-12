//! Persistence and background lifecycle for desktop updates.

#[cfg(not(debug_assertions))]
use std::thread;
#[cfg(not(debug_assertions))]
use std::time::Duration;

#[cfg(not(debug_assertions))]
use tauri::Emitter;
use tauri::{AppHandle, Manager};
#[cfg(not(debug_assertions))]
use tauri_plugin_updater::UpdaterExt;
#[cfg(not(debug_assertions))]
use url::Url;

use crate::DesktopState;
#[cfg(not(debug_assertions))]
use crate::update;
use crate::update::{UpdateCoordinator, UpdatePhase};
#[cfg(not(debug_assertions))]
use crate::updates::{
    BackgroundUpdateAction, accepts_update, background_update_action, verified_update_bytes,
};
use crate::updates::{PersistedUpdateState, UpdateStorage, load_update_state, save_update_state};

pub(super) fn restore_update_state(app: &AppHandle) {
    let Ok(data_root) = app.path().app_data_dir() else {
        return;
    };
    let Ok(storage) = UpdateStorage::open(&data_root) else {
        return;
    };
    let persisted = load_update_state(&storage);
    if let Ok(mut coordinator) = app.state::<DesktopState>().updates.lock() {
        coordinator.status.preferences = persisted.preferences;
        coordinator.status.scheduled_mode = persisted.scheduled_mode;
        coordinator.status.available_version = persisted.pending_version;
        coordinator.status.last_checked_at_unix = persisted.last_checked_at_unix;
        coordinator.dismissed_version = persisted.dismissed_version;
        coordinator.status.notification_dismissed = coordinator.status.available_version.as_deref()
            == coordinator.dismissed_version.as_deref();
        coordinator.automatic_check_eligible = persisted.launch_count > 0;
        coordinator.launch_count = persisted.launch_count.saturating_add(1);
        if coordinator.status.scheduled_mode.is_some()
            && coordinator.status.available_version.is_some()
        {
            coordinator.status.phase = UpdatePhase::WaitingForIdle;
        }
        persist_update_state(app, &coordinator);
    }
}

pub(crate) fn persist_update_state(app: &AppHandle, coordinator: &UpdateCoordinator) {
    let Ok(data_root) = app.path().app_data_dir() else {
        return;
    };
    let Ok(storage) = UpdateStorage::open(&data_root) else {
        return;
    };
    let state = PersistedUpdateState::new(
        coordinator.status.preferences.clone(),
        coordinator.status.scheduled_mode,
        coordinator.status.available_version.clone(),
        coordinator.status.last_checked_at_unix,
        coordinator.launch_count,
        coordinator.dismissed_version.clone(),
    );
    let _ = save_update_state(&storage, &state);
}

#[cfg(not(debug_assertions))]
pub(crate) fn desktop_updater(
    app: &AppHandle,
    channel: update::UpdateChannel,
) -> Result<tauri_plugin_updater::Updater, tauri_plugin_updater::Error> {
    let endpoint = match channel {
        update::UpdateChannel::Stable => {
            "https://github.com/Totoro-qaq/restork/releases/latest/download/latest.json"
        }
        update::UpdateChannel::Beta => {
            "https://github.com/Totoro-qaq/restork/releases/download/desktop-beta/beta.json"
        }
    };
    let endpoints = vec![Url::parse(endpoint).expect("static updater endpoint")];
    app.updater_builder()
        .endpoints(endpoints)?
        .timeout(Duration::from_secs(30))
        .build()
}

#[cfg(not(debug_assertions))]
pub(super) async fn install_scheduled_update(app: AppHandle) -> bool {
    let (version, channel, can_self_update) = {
        let state = app.state::<DesktopState>();
        let Ok(mut coordinator) = state.updates.lock() else {
            return false;
        };
        let Some(version) = coordinator.status.available_version.clone() else {
            return false;
        };
        if coordinator.status.scheduled_mode.is_none() {
            return false;
        }
        coordinator.status.phase = UpdatePhase::Installing;
        let _ = app.emit("restork://update-status", &coordinator.status);
        (
            version,
            coordinator.status.preferences.channel,
            coordinator.status.can_self_update,
        )
    };
    if !can_self_update {
        return false;
    }
    let result = async {
        let candidate = desktop_updater(&app, channel)
            .map_err(|_| "update_check_failed")?
            .check()
            .await
            .map_err(|_| "update_check_failed")?
            .filter(|candidate| candidate.version == version)
            .ok_or("update_no_longer_available")?;
        let data_root = app
            .path()
            .app_data_dir()
            .map_err(|_| "update_archive_unavailable")?;
        let storage = UpdateStorage::open(&data_root)?;
        let bytes = verified_update_bytes(&storage, &candidate.version, &candidate.target)?;
        candidate
            .install(&bytes)
            .map_err(|_| "update_install_failed")?;
        Ok::<(), &'static str>(())
    }
    .await;
    if let Ok(mut coordinator) = app.state::<DesktopState>().updates.lock() {
        match result {
            Ok(()) => {
                coordinator.status.phase = UpdatePhase::Completed;
                coordinator.status.scheduled_mode = None;
                coordinator.status.available_version = None;
            }
            Err(detail) => {
                coordinator.status.phase = UpdatePhase::InstallFailed;
                coordinator.status.detail = Some(detail);
                coordinator.status.scheduled_mode = None;
            }
        }
        persist_update_state(&app, &coordinator);
        let _ = app.emit("restork://update-status", &coordinator.status);
    }
    result.is_ok()
}

#[cfg(not(debug_assertions))]
pub(super) fn launch_update_check(app: AppHandle) {
    thread::spawn(move || {
        // Startup and Core recovery remain the first priority. Update checks
        // wait until the desktop has had time to settle.
        thread::sleep(Duration::from_secs(45));
        tauri::async_runtime::spawn(async move {
            let should_check =
                app.state::<DesktopState>()
                    .updates
                    .lock()
                    .is_ok_and(|coordinator| {
                        coordinator.should_automatically_check(update::now_unix())
                    });
            if !should_check {
                return;
            }
            let channel = app
                .state::<DesktopState>()
                .updates
                .lock()
                .map_or(update::UpdateChannel::Stable, |coordinator| {
                    coordinator.status.preferences.channel
                });
            let Ok(updater) = desktop_updater(&app, channel) else {
                record_background_update_failure(&app);
                return;
            };
            let update = match updater.check().await {
                Ok(candidate) => candidate,
                Err(_) => {
                    record_background_update_failure(&app);
                    return;
                }
            };
            let Some(update) = update else {
                if let Ok(mut coordinator) = app.state::<DesktopState>().updates.lock() {
                    coordinator.checked(None);
                    persist_update_state(&app, &coordinator);
                    let _ = app.emit("restork://update-status", &coordinator.status);
                }
                return;
            };
            let Ok(data_root) = app.path().app_data_dir() else {
                return;
            };
            let Ok(storage) = UpdateStorage::open(&data_root) else {
                return;
            };
            let Some(expected_target) = tauri_plugin_updater::target() else {
                return;
            };
            if update.download_url.scheme() != "https"
                || !update.download_url.username().is_empty()
                || update.download_url.password().is_some()
                || !accepts_update(
                    &update.current_version,
                    &update.version,
                    &update.target,
                    &expected_target,
                    &storage,
                )
            {
                if let Ok(inner) = app.state::<DesktopState>().inner.lock() {
                    inner.record("update_policy_rejected");
                }
                return;
            }
            if let Ok(mut coordinator) = app.state::<DesktopState>().updates.lock() {
                coordinator.checked(Some(update.version.clone()));
                persist_update_state(&app, &coordinator);
                let _ = app.emit("restork://update-status", &coordinator.status);
            }
            match background_update_action() {
                BackgroundUpdateAction::NotifyOnly => {
                    if let Ok(inner) = app.state::<DesktopState>().inner.lock() {
                        inner.record("update_available");
                    }
                }
            }
        });
    });
}

#[cfg(not(debug_assertions))]
fn record_background_update_failure(app: &AppHandle) {
    if let Ok(mut coordinator) = app.state::<DesktopState>().updates.lock() {
        coordinator.status.phase = UpdatePhase::CheckFailed;
        coordinator.status.last_checked_at_unix = Some(update::now_unix());
        coordinator.status.detail = Some("update_check_failed");
        persist_update_state(app, &coordinator);
        let _ = app.emit("restork://update-status", &coordinator.status);
    }
}

#[cfg(debug_assertions)]
pub(super) fn launch_update_check(_app: AppHandle) {}
