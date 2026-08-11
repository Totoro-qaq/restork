//! Short-lived desktop grants for Work project folders.
//!
//! The Dashboard receives only an opaque identifier and a human-readable
//! folder label. The absolute path remains in an owner-private file that Core
//! resolves for the first Work plan request.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use crate::vault_grant::validate_vault_dir;

const GRANT_DIRECTORY: &str = "workspace-grants";
const GRANT_SUFFIX: &str = ".grant";
const GRANT_RETENTION: Duration = Duration::from_secs(30 * 60);

pub(crate) struct WorkspaceGrant {
    pub(crate) id: String,
    pub(crate) label: String,
}

pub(crate) fn workspace_grant_dir(data_root: &Path) -> PathBuf {
    data_root.join(GRANT_DIRECTORY)
}

pub(crate) fn issue_workspace_grant(
    data_root: &Path,
    selected: &Path,
) -> Result<WorkspaceGrant, &'static str> {
    #[cfg(unix)]
    let home = std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let canonical = validate_vault_dir(data_root, selected, home.as_deref())
        .map_err(|_| "workspace_path_invalid")?;
    let directory = workspace_grant_dir(data_root);
    fs::create_dir_all(&directory).map_err(|_| "workspace_grant_unavailable")?;
    purge_expired(&directory);
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy).map_err(|_| "workspace_grant_unavailable")?;
    let id = entropy
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let grant = directory.join(format!("{id}{GRANT_SUFFIX}"));
    let path = canonical.to_str().ok_or("workspace_path_invalid")?;
    if path.is_empty() || path.len() > 4_096 || path.contains(['\0', '\r', '\n']) {
        return Err("workspace_path_invalid");
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    let mut file = options
        .open(&grant)
        .map_err(|_| "workspace_grant_unavailable")?;
    file.write_all(path.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|_| "workspace_grant_unavailable")?;
    #[cfg(unix)]
    fs::set_permissions(&grant, fs::Permissions::from_mode(0o600))
        .map_err(|_| "workspace_grant_unavailable")?;
    let label = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Selected project")
        .to_owned();
    Ok(WorkspaceGrant { id, label })
}

fn purge_expired(directory: &Path) {
    let now = SystemTime::now();
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let expired = entry
            .metadata()
            .ok()
            .filter(|metadata| metadata.is_file())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > GRANT_RETENTION);
        if expired && path.extension().and_then(|value| value.to_str()) == Some("grant") {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::{issue_workspace_grant, workspace_grant_dir};

    #[test]
    fn project_path_stays_inside_a_private_opaque_grant() {
        let data_root = tempfile::tempdir().expect("data root");
        let workspace = tempfile::tempdir().expect("workspace");
        fs::write(workspace.path().join("README.md"), "# project").expect("fixture");
        let grant = issue_workspace_grant(data_root.path(), workspace.path()).expect("grant");
        assert_eq!(grant.id.len(), 32);
        assert_eq!(
            grant.label,
            workspace.path().file_name().unwrap().to_string_lossy()
        );
        let path = workspace_grant_dir(data_root.path()).join(format!("{}.grant", grant.id));
        assert_eq!(
            fs::read_to_string(&path).expect("contents"),
            workspace
                .path()
                .canonicalize()
                .expect("canonical workspace")
                .to_string_lossy()
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(path).expect("metadata").permissions().mode() & 0o777,
            0o600
        );
    }
}
