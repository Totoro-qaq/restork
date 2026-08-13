//! Native Dashboard commands and recoverable setup flows.

use super::*;

#[tauri::command]
pub(super) fn desktop_status(state: State<'_, DesktopState>) -> Result<DesktopStatus, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    Ok(inner.status.clone())
}

#[tauri::command]
pub(super) fn desktop_session(
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
pub(super) fn desktop_store_session(
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
pub(super) fn desktop_vault_config(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<VaultConfigResponse, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    require_dashboard_window(&window, inner.origin.as_deref())?;
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|_| "vault_path_unavailable")?;
    let configured = configured_vault_dir(&data_root);
    #[cfg(debug_assertions)]
    let environment = std::env::var_os("RESTORK_VAULT_DIR").is_some();
    #[cfg(not(debug_assertions))]
    let environment = false;
    let Some(path) = configured else {
        return Ok(VaultConfigResponse {
            status: "unconfigured",
            grant_id: None,
            label: None,
            mutable: !environment,
        });
    };
    Ok(VaultConfigResponse {
        status: if environment {
            "environment"
        } else {
            "configured"
        },
        grant_id: Some(vault_grant_id(&path)),
        label: Some(vault_label(&path)),
        mutable: !environment,
    })
}

#[tauri::command]
pub(super) async fn desktop_choose_vault(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<VaultCandidateResponse, String> {
    // Resolve fallible, non-interactive state before marking a native prompt as
    // active. Otherwise an unavailable data directory would lock every later
    // prompt until the desktop process restarts.
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|_| "vault_path_unavailable")?;
    let expected_origin = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "desktop_state_unavailable")?;
        require_dashboard_window(&window, inner.origin.as_deref())?;
        if inner.native_prompt_active {
            return Err("native_prompt_already_open".into());
        }
        inner.vault_candidate = None;
        inner.native_prompt_active = true;
        inner.origin.clone().ok_or("desktop_origin_unavailable")?
    };
    let selected = tauri::async_runtime::spawn_blocking(|| {
        SelectFolder::new("Choose your Restork knowledge library").show()
    })
    .await
    .map_err(|_| "native_prompt_unavailable".to_owned());
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    inner.native_prompt_active = false;
    require_dashboard_window(&window, inner.origin.as_deref())?;
    if inner.origin.as_deref() != Some(expected_origin.as_str()) {
        return Err("desktop_session_changed".into());
    }
    let selected = selected?;
    let Some(raw_path) = selected else {
        inner.record("vault_selection_cancelled");
        return Ok(VaultCandidateResponse::Cancelled);
    };
    let path = PathBuf::from(raw_path);
    let home = user_home_dir();
    let canonical =
        validate_vault_dir(&data_root, &path, home.as_deref()).map_err(str::to_owned)?;
    let active = configured_vault_dir(&data_root);
    let same_as_active = active.as_ref().is_some_and(|value| value == &canonical);
    let label = vault_label(&canonical);
    let candidate_id = vault_candidate_id(&canonical);
    inner.vault_candidate = Some(VaultCandidate {
        id: candidate_id.clone(),
        path: canonical,
        label: label.clone(),
        created_at: Instant::now(),
    });
    inner.record("vault_candidate_selected");
    Ok(VaultCandidateResponse::Selected {
        candidate_id,
        label,
        same_as_active,
    })
}

#[tauri::command]
pub(super) async fn desktop_choose_workspace(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<WorkspaceGrantResponse, String> {
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|_| "workspace_path_unavailable")?;
    let expected_origin = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "desktop_state_unavailable")?;
        require_dashboard_window(&window, inner.origin.as_deref())?;
        if inner.native_prompt_active {
            return Err("native_prompt_already_open".into());
        }
        inner.native_prompt_active = true;
        inner.origin.clone().ok_or("desktop_origin_unavailable")?
    };
    let selected = tauri::async_runtime::spawn_blocking(|| {
        SelectFolder::new("Choose the project folder Restork may inspect").show()
    })
    .await
    .map_err(|_| "native_prompt_unavailable".to_owned());
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    inner.native_prompt_active = false;
    require_dashboard_window(&window, inner.origin.as_deref())?;
    if inner.origin.as_deref() != Some(expected_origin.as_str()) {
        return Err("desktop_session_changed".into());
    }
    let selected = selected?;
    let Some(raw_path) = selected else {
        inner.record("workspace_selection_cancelled");
        return Ok(WorkspaceGrantResponse::Cancelled);
    };
    let grant = issue_workspace_grant(&data_root, Path::new(&raw_path)).map_err(str::to_owned)?;
    inner.record("workspace_grant_issued");
    Ok(WorkspaceGrantResponse::Selected {
        grant_id: grant.id,
        label: grant.label,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(super) fn desktop_apply_vault(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    candidate_id: String,
) -> Result<VaultApplyResponse, String> {
    if candidate_id.is_empty() || candidate_id.len() > 128 {
        return Err("vault_candidate_invalid".into());
    }
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|_| "vault_path_unavailable")?;
    let (candidate, previous, generation, core_to_stop) = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "desktop_state_unavailable")?;
        require_dashboard_window(&window, inner.origin.as_deref())?;
        let candidate = inner
            .vault_candidate
            .take()
            .filter(|value| {
                value.id == candidate_id && value.created_at.elapsed() <= NATIVE_PROMPT_TTL
            })
            .ok_or("vault_candidate_expired")?;
        let previous = configured_vault_dir(&data_root);
        if previous
            .as_ref()
            .is_some_and(|value| value == &candidate.path)
        {
            return Ok(VaultApplyResponse::Unchanged {
                label: candidate.label,
            });
        }
        inner.switch_generation = inner.switch_generation.saturating_add(1);
        let generation = inner.switch_generation;
        inner.status = DesktopStatus {
            phase: DesktopPhase::Switching,
            message: "Reconnecting the private local workspace…".into(),
        };
        inner.pairing_code = None;
        inner.browser_session = None;
        inner.origin = None;
        inner.skill_candidate = None;
        inner.record("vault_switch_started");
        (candidate, previous, generation, inner.core.take())
    };
    if let Some(mut core) = core_to_stop {
        core.terminate();
    }
    navigate_to_loader(&app);
    let label = candidate.label.clone();
    thread::spawn(move || restart_with_vault(app, data_root, candidate, previous, generation));
    Ok(VaultApplyResponse::Switching { label })
}

#[tauri::command(rename_all = "camelCase")]
pub(super) async fn desktop_configure_provider_secret(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    provider_kind: String,
) -> Result<SecretResponse, String> {
    let expected_origin = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "desktop_state_unavailable")?;
        require_dashboard_window(&window, inner.origin.as_deref())?;
        if inner.native_prompt_active {
            return Err("native_prompt_already_open".into());
        }
        inner.native_prompt_active = true;
        inner.origin.clone().ok_or("desktop_origin_unavailable")?
    };
    let result =
        tauri::async_runtime::spawn_blocking(move || configure_provider_secret(&provider_kind))
            .await
            .map_err(|_| "native_prompt_unavailable".to_owned());
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    inner.native_prompt_active = false;
    require_dashboard_window(&window, inner.origin.as_deref())?;
    if inner.origin.as_deref() != Some(expected_origin.as_str()) {
        return Err("desktop_session_changed".into());
    }
    match result?? {
        SecretPromptResult::Cancelled => {
            inner.record("native_secret_cancelled");
            Ok(SecretResponse::Cancelled)
        }
        SecretPromptResult::Saved { secret_ref } => {
            inner.record("native_secret_saved");
            Ok(SecretResponse::Saved { secret_ref })
        }
    }
}

#[tauri::command]
pub(super) fn desktop_onboarding_state(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<OnboardingState, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    require_dashboard_window(&window, inner.origin.as_deref())?;
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|_| "onboarding_state_unavailable")?;
    Ok(load_onboarding_state(&data_root))
}

#[tauri::command]
pub(super) fn desktop_set_onboarding_dismissed(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    dismissed: bool,
) -> Result<OnboardingState, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    require_dashboard_window(&window, inner.origin.as_deref())?;
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|_| "onboarding_state_unavailable")?;
    let saved = save_onboarding_state(&data_root, dismissed).map_err(str::to_owned)?;
    inner.record(if dismissed {
        "onboarding_dismissed"
    } else {
        "onboarding_reopened"
    });
    Ok(saved)
}

fn restart_with_vault(
    app: AppHandle,
    data_root: PathBuf,
    candidate: VaultCandidate,
    previous: Option<PathBuf>,
    generation: u64,
) {
    if invalidate_vault_authority(&app).is_err() {
        match start_core_with_vault(&app, previous.as_deref()) {
            Ok(core) => finish_vault_restart(
                &app,
                core,
                generation,
                "Restork could not revoke old approvals, so the previous workspace was restored.",
                "vault_switch_authority_rollback",
            ),
            Err(_) => fail_vault_restart(&app, generation),
        }
        return;
    }
    if let Ok(mut core) = start_core_with_vault(&app, Some(&candidate.path)) {
        if save_vault_dir(&data_root, &candidate.path).is_ok() {
            finish_vault_restart(
                &app,
                core,
                generation,
                "Restork is connected to the selected knowledge library.",
                "vault_switch_completed",
            );
            return;
        }
        core.terminate();
    }
    match start_core_with_vault(&app, previous.as_deref()) {
        Ok(core) => finish_vault_restart(
            &app,
            core,
            generation,
            "The new library could not start. Restork restored the previous workspace.",
            "vault_switch_rolled_back",
        ),
        Err(_) => fail_vault_restart(&app, generation),
    }
}

fn finish_vault_restart(
    app: &AppHandle,
    core: CoreProcess,
    generation: u64,
    message: &'static str,
    event: &'static str,
) {
    let origin = core.origin.clone();
    let port = core.port;
    let process_id = core.child.id();
    let pairing_code = core.pairing_code.clone();
    let mut core = Some(core);
    let installed = {
        let state = app.state::<DesktopState>();
        let Ok(mut inner) = state.inner.lock() else {
            if let Some(core) = core.as_mut() {
                core.terminate();
            }
            return;
        };
        if inner.switch_generation != generation
            || !matches!(inner.status.phase, DesktopPhase::Switching)
        {
            false
        } else {
            inner.status = DesktopStatus {
                phase: DesktopPhase::Ready,
                message: message.into(),
            };
            inner.origin = Some(origin.clone());
            inner.pairing_code = Some(pairing_code);
            inner.browser_session = None;
            inner.core = core.take();
            inner.record(event);
            true
        }
    };
    if !installed {
        if let Some(core) = core.as_mut() {
            core.terminate();
        }
        return;
    }
    monitor_core(app.clone(), origin.clone(), process_id, port);
    if let Some(window) = app.get_webview_window("main")
        && let Ok(url) = origin.parse()
    {
        let _ = window.navigate(url);
    }
}

fn fail_vault_restart(app: &AppHandle, generation: u64) {
    let state = app.state::<DesktopState>();
    if let Ok(mut inner) = state.inner.lock()
        && inner.switch_generation == generation
    {
        inner.status = DesktopStatus {
            phase: DesktopPhase::Failed,
            message: "Restork could not reconnect either knowledge library. Retry Core without changing files.".into(),
        };
        inner.core = None;
        inner.pairing_code = None;
        inner.browser_session = None;
        inner.origin = None;
        inner.skill_candidate = None;
        inner.record("vault_switch_failed");
    }
    navigate_to_loader(app);
}

fn vault_label(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(120).collect())
        .unwrap_or_else(|| "Knowledge Library".into())
}

fn vault_grant_id(path: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(b"restork-vault-grant-v1\0");
    digest.update(path.to_string_lossy().as_bytes());
    format!("vault-{:x}", digest.finalize())[..22].to_owned()
}

fn vault_candidate_id(path: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(b"restork-vault-candidate-v1\0");
    digest.update(path.to_string_lossy().as_bytes());
    digest.update(std::process::id().to_le_bytes());
    digest.update(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_le_bytes(),
    );
    format!("candidate-{:x}", digest.finalize())[..34].to_owned()
}

fn user_home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key).map(PathBuf::from)
}

#[tauri::command]
pub(super) fn desktop_retry(app: AppHandle, state: State<'_, DesktopState>) -> Result<(), String> {
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
        inner.skill_candidate = None;
    }
    launch_core(app);
    Ok(())
}

#[tauri::command]
pub(super) fn desktop_quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub(super) fn desktop_update_recovery(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<Vec<RecoveryArtifact>, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    require_dashboard_window(&window, inner.origin.as_deref())?;
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|_| "update_recovery_unavailable")?;
    let storage = UpdateStorage::open(&data_root).map_err(str::to_owned)?;
    Ok(recovery_artifacts(&storage))
}

#[tauri::command]
pub(super) fn desktop_update_status(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<update::UpdateStatus, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    require_dashboard_window(&window, inner.origin.as_deref())?;
    drop(inner);
    let coordinator = state
        .updates
        .lock()
        .map_err(|_| "update_state_unavailable")?;
    Ok(coordinator.status.clone())
}

pub(crate) fn require_dashboard_window(
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
