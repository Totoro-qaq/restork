mod commands;
#[cfg(unix)]
mod diagnostics;
#[cfg(windows)]
#[path = "diagnostics_windows.rs"]
mod diagnostics;
mod native_secret;
mod onboarding;
#[cfg(unix)]
mod supervisor;
#[cfg(windows)]
#[path = "supervisor_windows.rs"]
mod supervisor;
mod updates;
mod vault_grant;
mod workspace_grant;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use light_file_dialog::dialog::{Dialog, SelectFolder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, RunEvent, State, WebviewWindow};
#[cfg(not(debug_assertions))]
use tauri_plugin_updater::UpdaterExt;

use diagnostics::Diagnostics;
use native_secret::{SecretPromptResult, configure_provider_secret};
use onboarding::{OnboardingState, load_onboarding_state, save_onboarding_state};
use supervisor::{
    CoreProcess, invalidate_vault_authority, readiness_request, start_core, start_core_with_vault,
};
#[cfg(not(debug_assertions))]
use updates::{BackgroundUpdateAction, accepts_update, background_update_action};
use updates::{RecoveryArtifact, UpdateStorage, recovery_artifacts};
use vault_grant::{configured_vault_dir, save_vault_dir, validate_vault_dir};
use workspace_grant::issue_workspace_grant;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const HEARTBEAT_FAILURE_LIMIT: u8 = 3;
const NATIVE_PROMPT_TTL: Duration = Duration::from_secs(5 * 60);
#[cfg(not(debug_assertions))]
const UPDATE_CHECK_DELAY: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HeartbeatObservation {
    Healthy,
    Recovered,
    Lost,
    Missing,
    Failed,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum DesktopPhase {
    Starting,
    Ready,
    Switching,
    Failed,
}

#[derive(Clone, Serialize)]
struct DesktopStatus {
    phase: DesktopPhase,
    message: String,
}

struct BrowserSession {
    access_token: String,
    expires_at: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum DesktopSession {
    Pairing {
        pairing_code: String,
    },
    Token {
        access_token: String,
        expires_at: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSessionInput {
    access_token: String,
    expires_at: String,
}

struct VaultCandidate {
    id: String,
    path: PathBuf,
    label: String,
    created_at: Instant,
}

#[derive(Serialize)]
struct VaultConfigResponse {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    grant_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    mutable: bool,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum VaultCandidateResponse {
    Cancelled,
    Selected {
        candidate_id: String,
        label: String,
        same_as_active: bool,
    },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum VaultApplyResponse {
    Switching { label: String },
    Unchanged { label: String },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum SecretResponse {
    Cancelled,
    Saved { secret_ref: String },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum WorkspaceGrantResponse {
    Cancelled,
    Selected { grant_id: String, label: String },
}

struct DesktopInner {
    status: DesktopStatus,
    core: Option<CoreProcess>,
    pairing_code: Option<String>,
    browser_session: Option<BrowserSession>,
    origin: Option<String>,
    diagnostics: Option<Diagnostics>,
    vault_candidate: Option<VaultCandidate>,
    native_prompt_active: bool,
    switch_generation: u64,
}

struct DesktopState {
    inner: Mutex<DesktopInner>,
}

impl Default for DesktopState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(DesktopInner {
                status: DesktopStatus {
                    phase: DesktopPhase::Starting,
                    message: "Preparing the private local workspace…".into(),
                },
                core: None,
                pairing_code: None,
                browser_session: None,
                origin: None,
                diagnostics: None,
                vault_candidate: None,
                native_prompt_active: false,
                switch_generation: 0,
            }),
        }
    }
}

impl DesktopState {
    fn shutdown(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(mut core) = inner.core.take() {
                core.terminate();
            }
            inner.pairing_code = None;
            inner.browser_session = None;
            inner.origin = None;
            inner.vault_candidate = None;
            inner.native_prompt_active = false;
            inner.record("core_stopped");
        }
    }
}

fn launch_core(app: AppHandle) {
    if let Ok(inner) = app.state::<DesktopState>().inner.lock() {
        inner.record("core_starting");
    }
    std::thread::spawn(move || match start_core(&app) {
        Ok(mut core) => {
            let origin = core.origin.clone();
            let port = core.port;
            let process_id = core.child.id();
            let pairing_code = core.pairing_code.clone();
            let state = app.state::<DesktopState>();
            if let Ok(mut inner) = state.inner.lock() {
                inner.status = DesktopStatus {
                    phase: DesktopPhase::Ready,
                    message: "Restork Core is ready.".into(),
                };
                inner.origin = Some(origin.clone());
                inner.pairing_code = Some(pairing_code);
                inner.core = Some(core);
                inner.record("core_ready");
            } else {
                core.terminate();
                return;
            }
            monitor_core(app.clone(), origin.clone(), process_id, port);
            if let Some(window) = app.get_webview_window("main")
                && let Ok(url) = origin.parse()
            {
                let _ = window.navigate(url);
            }
            launch_update_check(app);
        }
        Err(_) => {
            let state = app.state::<DesktopState>();
            if let Ok(mut inner) = state.inner.lock() {
                inner.status = DesktopStatus {
                    phase: DesktopPhase::Failed,
                    message: "Restork Core could not start. Retry or quit the application.".into(),
                };
                inner.core = None;
                inner.pairing_code = None;
                inner.browser_session = None;
                inner.origin = None;
                inner.record("core_start_failed");
            }
        }
    });
}

fn monitor_core(app: AppHandle, origin: String, process_id: u32, port: u16) {
    thread::spawn(move || {
        let mut consecutive_failures = 0_u8;
        loop {
            thread::sleep(HEARTBEAT_INTERVAL);
            let child_running = {
                let state = app.state::<DesktopState>();
                let Ok(mut inner) = state.inner.lock() else {
                    return;
                };
                let Some(core) = inner.core.as_mut() else {
                    return;
                };
                if core.origin != origin || core.child.id() != process_id {
                    return;
                }
                matches!(core.child.try_wait(), Ok(None))
            };
            if !child_running {
                fail_running_core(
                    &app,
                    &origin,
                    process_id,
                    "core_exited",
                    "Restork Core stopped unexpectedly. Retry with a fresh local session.",
                );
                return;
            }
            let observation;
            (consecutive_failures, observation) =
                observe_heartbeat(consecutive_failures, readiness_request(port));
            match observation {
                HeartbeatObservation::Recovered => {
                    record_for_core(&app, &origin, process_id, "core_heartbeat_recovered");
                }
                HeartbeatObservation::Lost => {
                    record_for_core(&app, &origin, process_id, "core_heartbeat_lost");
                }
                HeartbeatObservation::Failed => {
                    fail_running_core(
                        &app,
                        &origin,
                        process_id,
                        "core_heartbeat_failed",
                        "Restork Core stopped responding. Retry with a fresh local session.",
                    );
                    return;
                }
                HeartbeatObservation::Healthy | HeartbeatObservation::Missing => {}
            }
        }
    });
}

fn observe_heartbeat(consecutive_failures: u8, ready: bool) -> (u8, HeartbeatObservation) {
    if ready {
        return (
            0,
            if consecutive_failures == 0 {
                HeartbeatObservation::Healthy
            } else {
                HeartbeatObservation::Recovered
            },
        );
    }
    let failures = consecutive_failures.saturating_add(1);
    let observation = if failures >= HEARTBEAT_FAILURE_LIMIT {
        HeartbeatObservation::Failed
    } else if failures == 1 {
        HeartbeatObservation::Lost
    } else {
        HeartbeatObservation::Missing
    };
    (failures, observation)
}

fn record_for_core(app: &AppHandle, origin: &str, process_id: u32, event: &'static str) {
    let state = app.state::<DesktopState>();
    if let Ok(inner) = state.inner.lock()
        && inner
            .core
            .as_ref()
            .is_some_and(|core| core.origin == origin && core.child.id() == process_id)
    {
        inner.record(event);
    }
}

fn fail_running_core(
    app: &AppHandle,
    origin: &str,
    process_id: u32,
    event: &'static str,
    message: &'static str,
) {
    let core_to_stop = {
        let state = app.state::<DesktopState>();
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        if !inner
            .core
            .as_ref()
            .is_some_and(|core| core.origin == origin && core.child.id() == process_id)
        {
            return;
        }
        let core = inner.core.take();
        inner.status = DesktopStatus {
            phase: DesktopPhase::Failed,
            message: message.into(),
        };
        inner.pairing_code = None;
        inner.browser_session = None;
        inner.origin = None;
        inner.record(event);
        core
    };
    if let Some(mut core) = core_to_stop {
        core.terminate();
    }
    navigate_to_loader(app);
}

fn navigate_to_loader(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main")
        && let Ok(url) = "tauri://localhost/index.html".parse()
    {
        let _ = window.navigate(url);
    }
}

impl DesktopInner {
    fn record(&self, event: &'static str) {
        if let Some(diagnostics) = &self.diagnostics {
            diagnostics.record(event);
        }
    }
}

#[cfg(not(debug_assertions))]
fn launch_update_check(app: AppHandle) {
    thread::spawn(move || {
        thread::sleep(UPDATE_CHECK_DELAY);
        tauri::async_runtime::spawn(async move {
            let Ok(updater) = app.updater() else {
                return;
            };
            let Ok(Some(update)) = updater.check().await else {
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

#[cfg(debug_assertions)]
fn launch_update_check(_app: AppHandle) {}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _directory| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            commands::desktop_status,
            commands::desktop_session,
            commands::desktop_store_session,
            commands::desktop_vault_config,
            commands::desktop_choose_vault,
            commands::desktop_apply_vault,
            commands::desktop_choose_workspace,
            commands::desktop_configure_provider_secret,
            commands::desktop_onboarding_state,
            commands::desktop_set_onboarding_dismissed,
            commands::desktop_open_external,
            commands::desktop_retry,
            commands::desktop_quit,
            commands::desktop_update_recovery,
        ])
        .setup(|app| {
            let diagnostics = Diagnostics::create(app.handle()).ok();
            if let Ok(mut inner) = app.state::<DesktopState>().inner.lock() {
                inner.diagnostics = diagnostics;
                inner.record("desktop_started");
            }
            launch_core(app.handle().clone());
            Ok(())
        });

    builder
        .build(tauri::generate_context!())
        .expect("failed to build Restork desktop application")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                app.state::<DesktopState>().shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{HeartbeatObservation, observe_heartbeat};

    #[test]
    fn heartbeat_requires_three_consecutive_failures_and_can_recover() {
        let (failures, observation) = observe_heartbeat(0, false);
        assert_eq!((failures, observation), (1, HeartbeatObservation::Lost));
        let (failures, observation) = observe_heartbeat(failures, false);
        assert_eq!((failures, observation), (2, HeartbeatObservation::Missing));
        let (failures, observation) = observe_heartbeat(failures, true);
        assert_eq!(
            (failures, observation),
            (0, HeartbeatObservation::Recovered)
        );

        let (failures, _) = observe_heartbeat(failures, false);
        let (failures, _) = observe_heartbeat(failures, false);
        let (failures, observation) = observe_heartbeat(failures, false);
        assert_eq!((failures, observation), (3, HeartbeatObservation::Failed));
    }
}
