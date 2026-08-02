mod diagnostics;
mod supervisor;

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent, State, WebviewWindow};
#[cfg(not(debug_assertions))]
use tauri_plugin_updater::UpdaterExt;

use diagnostics::Diagnostics;
use supervisor::{CoreProcess, readiness_request, start_core};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const HEARTBEAT_FAILURE_LIMIT: u8 = 3;
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
    #[cfg_attr(debug_assertions, allow(dead_code))]
    Updating,
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

struct DesktopInner {
    status: DesktopStatus,
    core: Option<CoreProcess>,
    pairing_code: Option<String>,
    browser_session: Option<BrowserSession>,
    origin: Option<String>,
    diagnostics: Option<Diagnostics>,
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
            inner.record("core_stopped");
        }
    }
}

#[tauri::command]
fn desktop_status(state: State<'_, DesktopState>) -> Result<DesktopStatus, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    Ok(inner.status.clone())
}

#[tauri::command]
fn desktop_session(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<DesktopSession, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    require_dashboard_window(&window, inner.origin.as_deref())?;
    inner.record("browser_session_requested");
    if let Some(session) = &inner.browser_session {
        inner.record("browser_session_issued");
        return Ok(DesktopSession::Token {
            access_token: session.access_token.clone(),
            expires_at: session.expires_at.clone(),
        });
    }
    let session = inner
        .pairing_code
        .as_ref()
        .map(|pairing_code| DesktopSession::Pairing {
            pairing_code: pairing_code.clone(),
        })
        .ok_or_else(|| "desktop_session_unavailable".to_owned())?;
    inner.record("browser_session_issued");
    Ok(session)
}

#[tauri::command]
fn desktop_store_session(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    session: BrowserSessionInput,
) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    require_dashboard_window(&window, inner.origin.as_deref())?;
    if !(32..=512).contains(&session.access_token.len())
        || session
            .access_token
            .contains(|character: char| character.is_whitespace())
        || !(20..=64).contains(&session.expires_at.len())
        || !session.expires_at.contains('T')
    {
        return Err("desktop_session_shape_invalid".into());
    }
    inner.browser_session = Some(BrowserSession {
        access_token: session.access_token,
        expires_at: session.expires_at,
    });
    inner.pairing_code = None;
    inner.record("browser_session_stored");
    Ok(())
}

#[tauri::command]
fn desktop_retry(app: AppHandle, state: State<'_, DesktopState>) -> Result<(), String> {
    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "desktop_state_unavailable")?;
        if !matches!(inner.status.phase, DesktopPhase::Failed) {
            return Err("desktop_retry_not_available".into());
        }
        inner.status = DesktopStatus {
            phase: DesktopPhase::Starting,
            message: "Retrying with a new private local port…".into(),
        };
        inner.pairing_code = None;
        inner.browser_session = None;
        inner.origin = None;
    }
    launch_core(app);
    Ok(())
}

#[tauri::command]
fn desktop_quit(app: AppHandle) {
    app.exit(0);
}

fn require_dashboard_window(
    window: &WebviewWindow,
    expected_origin: Option<&str>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("desktop_window_not_allowed".into());
    }
    let expected = expected_origin.ok_or("desktop_origin_unavailable")?;
    let url = window.url().map_err(|_| "desktop_origin_unavailable")?;
    let actual = format!(
        "{}://{}:{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        url.port_or_known_default().unwrap_or_default()
    );
    if actual != expected || url.path() != "/" {
        return Err("desktop_origin_not_allowed".into());
    }
    Ok(())
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
            let Ok(bytes) = update.download(|_, _| {}, || {}).await else {
                if let Ok(inner) = app.state::<DesktopState>().inner.lock() {
                    inner.record("update_download_failed");
                }
                return;
            };

            let state = app.state::<DesktopState>();
            if let Ok(mut inner) = state.inner.lock() {
                inner.status = DesktopStatus {
                    phase: DesktopPhase::Updating,
                    message: "Installing a verified Restork update…".into(),
                };
                inner.record("update_verified");
                if let Some(mut core) = inner.core.take() {
                    core.terminate();
                }
                inner.pairing_code = None;
                inner.browser_session = None;
                inner.origin = None;
            } else {
                return;
            }
            navigate_to_loader(&app);
            if update.install(bytes).is_ok() {
                if let Ok(inner) = app.state::<DesktopState>().inner.lock() {
                    inner.record("update_installed");
                }
                app.restart();
            } else if let Ok(mut inner) = app.state::<DesktopState>().inner.lock() {
                inner.status = DesktopStatus {
                    phase: DesktopPhase::Failed,
                    message:
                        "The verified update could not be installed. Retry Restork Core or quit."
                            .into(),
                };
                inner.record("update_install_failed");
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
            desktop_status,
            desktop_session,
            desktop_store_session,
            desktop_retry,
            desktop_quit,
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
