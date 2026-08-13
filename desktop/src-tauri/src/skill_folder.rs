//! Native `SKILL.md` folder import.
//!
//! The folder path and instruction bodies stay in the native process. The
//! Dashboard receives only an opaque candidate id and Core's redacted
//! compatibility report.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use light_file_dialog::dialog::{Dialog, SelectFolder};
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{State, WebviewWindow};

use super::{BrowserSession, DesktopState, NATIVE_PROMPT_TTL};
use crate::commands::require_dashboard_window;

const MAX_FILES: usize = 40;
const MAX_PACKAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const TEXT_EXTENSIONS: &[&str] = &["md", "txt", "json", "yaml", "yml", "csv"];
const SCRIPT_EXTENSIONS: &[&str] = &[
    "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "sh", "bash", "zsh", "ps1", "exe", "bin", "wasm",
    "so", "dylib", "dll",
];

#[derive(Clone)]
pub(super) struct SkillCandidate {
    id: String,
    manifest: Value,
    file_count: usize,
    total_bytes: usize,
    created_at: Instant,
    preview_digest: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(super) enum SkillFolderResponse {
    Cancelled,
    Selected {
        candidate_id: String,
        label: String,
        file_count: usize,
        total_bytes: usize,
    },
}

#[derive(Serialize)]
pub(super) struct SkillImportPreviewResponse {
    preview_digest: String,
    preview: SkillCompatibilityReport,
}

#[derive(Serialize)]
pub(super) struct SkillInstallResponse {
    status: &'static str,
    package_id: String,
    state: String,
    manifest_hash: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct SkillCompatibilityReport {
    imported: Vec<CompatibilityPart>,
    stripped: Vec<CompatibilityPart>,
    notice: String,
    discourage: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct CompatibilityPart {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bytes: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

#[derive(Serialize)]
struct SkillFolderFile {
    path: String,
    content: String,
}

struct CollectedSkill {
    files: Vec<SkillFolderFile>,
    total_bytes: usize,
}

#[derive(Deserialize)]
struct CorePreviewEnvelope {
    preview_digest: String,
    preview: SkillCompatibilityReport,
}

#[derive(Deserialize)]
struct CoreInstallEnvelope {
    package_id: String,
    state: String,
    manifest_hash: String,
}

#[tauri::command]
pub(super) async fn desktop_import_skill_folder(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<SkillFolderResponse, String> {
    let expected_origin = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "desktop_state_unavailable")?;
        require_dashboard_window(&window, inner.origin.as_deref())?;
        if inner.native_prompt_active {
            return Err("native_prompt_already_open".into());
        }
        inner.skill_candidate = None;
        inner.native_prompt_active = true;
        inner.origin.clone().ok_or("desktop_origin_unavailable")?
    };
    let selected = tauri::async_runtime::spawn_blocking(|| {
        SelectFolder::new("Choose the SKILL.md folder Restork may import").show()
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
        inner.record("skill_folder_selection_cancelled");
        return Ok(SkillFolderResponse::Cancelled);
    };
    drop(inner);
    let root = Path::new(&raw_path);
    let collected = collect_skill_files(root)?;
    let label = root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Imported skill")
        .chars()
        .take(120)
        .collect::<String>();
    let candidate_id = random_candidate_id()?;
    let candidate = SkillCandidate {
        id: candidate_id.clone(),
        file_count: collected.files.len(),
        total_bytes: collected.total_bytes,
        manifest: json!({"format": "agent_skill_v1", "files": collected.files}),
        created_at: Instant::now(),
        preview_digest: None,
    };
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    require_dashboard_window(&window, inner.origin.as_deref())?;
    if inner.origin.as_deref() != Some(expected_origin.as_str()) {
        return Err("desktop_session_changed".into());
    }
    inner.skill_candidate = Some(candidate);
    inner.record("skill_folder_candidate_selected");
    Ok(SkillFolderResponse::Selected {
        candidate_id,
        label,
        file_count: inner
            .skill_candidate
            .as_ref()
            .map_or(0, |value| value.file_count),
        total_bytes: inner
            .skill_candidate
            .as_ref()
            .map_or(0, |value| value.total_bytes),
    })
}

#[tauri::command]
pub(super) async fn desktop_preview_skill_import(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    candidate_id: String,
) -> Result<SkillImportPreviewResponse, String> {
    let (origin, token, candidate) = candidate_snapshot(&window, &state, &candidate_id, false)?;
    let payload = json!({"package_kind": "skill", "manifest": candidate.manifest});
    let response = core_request(&origin, &token, payload).await?;
    if response.status() != StatusCode::ACCEPTED {
        return Err(core_error(response.status()));
    }
    let envelope = read_core_json::<CorePreviewEnvelope>(response).await?;
    if !valid_digest(&envelope.preview_digest) {
        return Err("skill_import_response_invalid".into());
    }
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    require_dashboard_window(&window, inner.origin.as_deref())?;
    if inner.origin.as_deref() != Some(origin.as_str()) {
        return Err("desktop_session_changed".into());
    }
    let stored = inner
        .skill_candidate
        .as_mut()
        .filter(|value| value.id == candidate_id && value.created_at.elapsed() <= NATIVE_PROMPT_TTL)
        .ok_or("skill_candidate_expired")?;
    stored.preview_digest = Some(envelope.preview_digest.clone());
    inner.record("skill_folder_compatibility_previewed");
    Ok(SkillImportPreviewResponse {
        preview_digest: envelope.preview_digest,
        preview: envelope.preview,
    })
}

#[tauri::command]
pub(super) async fn desktop_install_skill_import(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    candidate_id: String,
    preview_digest: String,
) -> Result<SkillInstallResponse, String> {
    if !valid_digest(&preview_digest) {
        return Err("skill_preview_digest_invalid".into());
    }
    let (origin, token, candidate) = candidate_snapshot(&window, &state, &candidate_id, true)?;
    if candidate.preview_digest.as_deref() != Some(preview_digest.as_str()) {
        return Err("skill_preview_digest_mismatch".into());
    }
    let payload = json!({
        "package_kind": "skill",
        "manifest": candidate.manifest,
        "approved_preview_digest": preview_digest,
    });
    let response = core_request(&origin, &token, payload).await?;
    if response.status() != StatusCode::CREATED {
        return Err(core_error(response.status()));
    }
    let envelope = read_core_json::<CoreInstallEnvelope>(response).await?;
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    require_dashboard_window(&window, inner.origin.as_deref())?;
    if inner.origin.as_deref() != Some(origin.as_str()) {
        return Err("desktop_session_changed".into());
    }
    if inner
        .skill_candidate
        .as_ref()
        .is_some_and(|value| value.id == candidate_id)
    {
        inner.skill_candidate = None;
    }
    inner.record("skill_folder_imported");
    Ok(SkillInstallResponse {
        status: "installed",
        package_id: envelope.package_id,
        state: envelope.state,
        manifest_hash: envelope.manifest_hash,
    })
}

fn candidate_snapshot(
    window: &WebviewWindow,
    state: &State<'_, DesktopState>,
    candidate_id: &str,
    require_preview: bool,
) -> Result<(String, String, SkillCandidate), String> {
    if candidate_id.len() != 32 || !candidate_id.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("skill_candidate_invalid".into());
    }
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    require_dashboard_window(window, inner.origin.as_deref())?;
    if inner
        .skill_candidate
        .as_ref()
        .is_some_and(|value| value.created_at.elapsed() > NATIVE_PROMPT_TTL)
    {
        inner.skill_candidate = None;
        return Err("skill_candidate_expired".into());
    }
    let candidate = inner
        .skill_candidate
        .as_ref()
        .filter(|value| value.id == candidate_id)
        .filter(|value| !require_preview || value.preview_digest.is_some())
        .ok_or("skill_candidate_expired")?
        .clone();
    let origin = inner.origin.clone().ok_or("desktop_origin_unavailable")?;
    let token = active_token(inner.browser_session.as_ref())?;
    Ok((origin, token, candidate))
}

fn active_token(session: Option<&BrowserSession>) -> Result<String, String> {
    session
        .map(|value| value.access_token.clone())
        .ok_or_else(|| "desktop_session_unavailable".to_owned())
}

async fn core_request(
    origin: &str,
    token: &str,
    payload: Value,
) -> Result<reqwest::Response, String> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "skill_import_unavailable")?;
    client
        .post(format!("{origin}/v1/extensions"))
        .bearer_auth(token)
        .header("Accept", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|_| "skill_import_unavailable".to_owned())
}

async fn read_core_json<T: DeserializeOwned>(mut response: reqwest::Response) -> Result<T, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("skill_import_response_invalid".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "skill_import_unavailable")?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("skill_import_response_invalid".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "skill_import_response_invalid".into())
}

fn core_error(status: StatusCode) -> String {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "desktop_session_expired".into(),
        StatusCode::UNPROCESSABLE_ENTITY | StatusCode::BAD_REQUEST => {
            "skill_package_incompatible".into()
        }
        _ => "skill_import_unavailable".into(),
    }
}

fn random_candidate_id() -> Result<String, String> {
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy).map_err(|_| "skill_candidate_unavailable")?;
    Ok(entropy
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>())
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn collect_skill_files(selected_root: &Path) -> Result<CollectedSkill, String> {
    let root = canonical_selected_root(selected_root)?;
    let mut files = Vec::new();
    let mut pending = vec![root.clone()];
    let mut total_bytes = 0_usize;
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory).map_err(|_| "skill_folder_unreadable")?;
        for entry in entries {
            let entry = entry.map_err(|_| "skill_folder_unreadable")?;
            let file_type = entry.file_type().map_err(|_| "skill_folder_unreadable")?;
            if file_type.is_symlink() {
                continue;
            }
            let path = canonical_child(&root, &entry.path())?;
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let relative = relative_skill_path(&root, &path)?;
            if files.len() >= MAX_FILES {
                return Err("skill_folder_too_many_files".into());
            }
            let file_bytes = usize::try_from(
                entry
                    .metadata()
                    .map_err(|_| "skill_folder_unreadable")?
                    .len(),
            )
            .map_err(|_| "skill_folder_too_large")?;
            if total_bytes.saturating_add(file_bytes) > MAX_PACKAGE_BYTES {
                return Err("skill_folder_too_large".into());
            }
            let bytes = fs::read(&path).map_err(|_| "skill_folder_unreadable")?;
            total_bytes = total_bytes.saturating_add(bytes.len());
            if total_bytes > MAX_PACKAGE_BYTES {
                return Err("skill_folder_too_large".into());
            }
            files.push(SkillFolderFile {
                content: readable_skill_content(&relative, &bytes),
                path: relative,
            });
        }
    }
    let has_skill_md = files.iter().any(|file| {
        let lower = file.path.to_ascii_lowercase();
        lower == "skill.md" || lower.ends_with("/skill.md")
    });
    if !has_skill_md {
        return Err("skill_md_missing".into());
    }
    Ok(CollectedSkill { files, total_bytes })
}

fn canonical_selected_root(selected_root: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(selected_root).map_err(|_| "skill_folder_unreadable")?;
    let metadata = fs::metadata(&root).map_err(|_| "skill_folder_unreadable")?;
    if !root.is_absolute() || !metadata.is_dir() {
        return Err("skill_folder_unreadable".into());
    }
    Ok(root)
}

fn canonical_child(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let path = fs::canonicalize(candidate).map_err(|_| "skill_folder_unreadable")?;
    if path == root || !path.starts_with(root) {
        return Err("skill_folder_unreadable".into());
    }
    Ok(path)
}

fn relative_skill_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "skill_folder_unreadable")?;
    let text = relative
        .to_str()
        .ok_or("skill_folder_unreadable")?
        .replace('\\', "/");
    if text.is_empty()
        || text.starts_with('/')
        || text
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("skill_folder_unreadable".into());
    }
    Ok(text)
}

fn readable_skill_content(relative: &str, bytes: &[u8]) -> String {
    let lower = relative.to_ascii_lowercase();
    let extension = lower.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    if bytes.contains(&0) {
        return "\0".into();
    }
    if lower.starts_with("scripts/")
        || SCRIPT_EXTENSIONS.contains(&extension)
        || !TEXT_EXTENSIONS.contains(&extension)
    {
        return String::new();
    }
    String::from_utf8(bytes.to_vec()).unwrap_or_else(|_| "\0".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn relative_script_paths_are_stripped_and_absolute_paths_never_leave() {
        let fixture = tempdir().expect("fixture");
        let root = fixture.path();
        fs::create_dir_all(root.join("scripts")).expect("dir");
        fs::write(
            root.join("SKILL.md"),
            "---\nname: ppt-master\n---\nWrite slides from the brief.\n",
        )
        .expect("skill");
        fs::write(root.join("scripts/render.mjs"), "console.log(1)").expect("script");
        let collected = collect_skill_files(root).expect("import");
        assert!(
            collected
                .files
                .iter()
                .any(|file| file.path == "SKILL.md" && file.content.contains("Write slides"))
        );
        assert!(
            collected
                .files
                .iter()
                .any(|file| file.path == "scripts/render.mjs" && file.content.is_empty())
        );
    }

    #[cfg(unix)]
    #[test]
    fn selected_root_and_children_cannot_escape_through_symlinks() {
        use std::os::unix::fs::symlink;

        let fixture = tempdir().expect("fixture");
        let outside = tempdir().expect("outside");
        fs::write(
            fixture.path().join("SKILL.md"),
            "---\nname: safe\n---\nRead only this folder.\n",
        )
        .expect("skill");
        fs::write(outside.path().join("secret.txt"), "must not be imported").expect("outside");
        symlink(outside.path(), fixture.path().join("outside-link")).expect("child link");

        let collected = collect_skill_files(fixture.path()).expect("import");
        assert_eq!(collected.files.len(), 1);
        assert_eq!(collected.files[0].path, "SKILL.md");
    }

    #[test]
    fn dashboard_response_exposes_only_an_opaque_summary() {
        let response = SkillFolderResponse::Selected {
            candidate_id: "a".repeat(32),
            label: "ppt-master".into(),
            file_count: 2,
            total_bytes: 120,
        };
        let encoded = serde_json::to_string(&response).expect("json");
        assert!(!encoded.contains("content"));
        assert!(!encoded.contains("SKILL.md"));
        assert!(!encoded.contains("/Users/"));
    }

    #[test]
    fn digest_and_candidate_shapes_are_narrow() {
        assert!(valid_digest(&"f".repeat(64)));
        assert!(!valid_digest(&"f".repeat(63)));
        assert!(!valid_digest(&format!("{}g", "f".repeat(63))));
    }
}
