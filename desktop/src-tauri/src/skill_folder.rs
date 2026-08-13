//! Native `SKILL.md` folder import.
//!
//! The folder path and instruction bodies stay in the native process. The
//! Dashboard receives only an opaque candidate id and Core's redacted
//! compatibility report.

use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use light_file_dialog::dialog::{Dialog, SelectFolder};
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{State, WebviewWindow};

use super::{BrowserSession, DesktopState, NATIVE_PROMPT_TTL};
use crate::commands::require_dashboard_window;

const MAX_FILES: usize = 40;
const MAX_DIRECTORIES: usize = 100;
const MAX_DEPTH: usize = 12;
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
    if !selected_root.is_absolute() {
        return Err("skill_folder_unreadable".into());
    }
    let root = Dir::open_ambient_dir(selected_root, ambient_authority())
        .map_err(|_| "skill_folder_unreadable")?;
    let mut files = Vec::new();
    let mut pending = vec![(root, String::new(), 0_usize)];
    let mut directory_count = 1_usize;
    let mut total_bytes = 0_usize;
    while let Some((directory, prefix, depth)) = pending.pop() {
        let entries = directory.entries().map_err(|_| "skill_folder_unreadable")?;
        for entry in entries {
            let entry = entry.map_err(|_| "skill_folder_unreadable")?;
            let name = single_skill_component(&entry.file_name())?;
            let file_type = entry.file_type().map_err(|_| "skill_folder_unreadable")?;
            if file_type.is_symlink() {
                continue;
            }
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if file_type.is_dir() {
                if depth >= MAX_DEPTH {
                    return Err("skill_folder_too_deep".into());
                }
                directory_count = directory_count.saturating_add(1);
                if directory_count > MAX_DIRECTORIES {
                    return Err("skill_folder_too_many_directories".into());
                }
                let child = directory
                    .open_dir_nofollow(&name)
                    .map_err(|_| "skill_folder_unreadable")?;
                pending.push((child, relative, depth + 1));
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            if files.len() >= MAX_FILES {
                return Err("skill_folder_too_many_files".into());
            }
            let mut options = OpenOptions::new();
            options.read(true).follow(FollowSymlinks::No);
            let mut file = directory
                .open_with(&name, &options)
                .map_err(|_| "skill_folder_unreadable")?;
            let metadata = file.metadata().map_err(|_| "skill_folder_unreadable")?;
            if !metadata.is_file() {
                return Err("skill_folder_unreadable".into());
            }
            let remaining = MAX_PACKAGE_BYTES.saturating_sub(total_bytes);
            if metadata.len() > remaining as u64 {
                return Err("skill_folder_too_large".into());
            }
            let mut bytes = Vec::with_capacity(
                usize::try_from(metadata.len()).map_err(|_| "skill_folder_too_large")?,
            );
            file.by_ref()
                .take((remaining as u64).saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(|_| "skill_folder_unreadable")?;
            if bytes.len() > remaining {
                return Err("skill_folder_too_large".into());
            }
            total_bytes = total_bytes.saturating_add(bytes.len());
            files.push(SkillFolderFile {
                content: readable_skill_content(&relative, &bytes),
                path: relative,
            });
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let has_skill_md = files.iter().any(|file| {
        let lower = file.path.to_ascii_lowercase();
        lower == "skill.md" || lower.ends_with("/skill.md")
    });
    if !has_skill_md {
        return Err("skill_md_missing".into());
    }
    Ok(CollectedSkill { files, total_bytes })
}

fn single_skill_component(name: &std::ffi::OsStr) -> Result<String, String> {
    let text = name.to_str().ok_or("skill_folder_unreadable")?;
    if text.is_empty() || text == "." || text == ".." || text.contains('/') || text.contains('\\') {
        return Err("skill_folder_unreadable".into());
    }
    Ok(text.to_owned())
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
    use std::fs;
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
    fn imported_files_are_sorted_by_relative_path() {
        let fixture = tempdir().expect("fixture");
        fs::write(fixture.path().join("z.txt"), "last").expect("z");
        fs::write(fixture.path().join("SKILL.md"), "---\nname: sorted\n---\n").expect("skill");
        fs::write(fixture.path().join("a.txt"), "first").expect("a");

        let collected = collect_skill_files(fixture.path()).expect("import");
        let paths = collected
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["SKILL.md", "a.txt", "z.txt"]);
    }

    #[test]
    fn reads_are_bounded_by_the_package_limit() {
        let fixture = tempdir().expect("fixture");
        fs::write(
            fixture.path().join("SKILL.md"),
            vec![b'a'; MAX_PACKAGE_BYTES + 1],
        )
        .expect("oversized skill");
        let result = collect_skill_files(fixture.path());
        assert!(matches!(result, Err(ref error) if error == "skill_folder_too_large"));
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
