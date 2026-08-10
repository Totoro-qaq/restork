//! Native Vault-grant persistence and the private desktop-to-Core launch bridge.
//!
//! The Dashboard receives only opaque candidate identifiers and a display label.
//! Absolute paths stay in Rust, are persisted in the user's application-data
//! directory, and reach Core through a short-lived owner-private descriptor file.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const VAULT_DIR_FILE: &str = "vault-dir.txt";
const VAULT_DIR_PENDING_FILE: &str = "vault-dir.pending";
const VAULT_LAUNCH_FILE: &str = "vault-launch.grant";
const VAULT_PATH_LIMIT: usize = 4_096;

/// Resolve the user's configured knowledge-base directory.
///
/// Debug builds may use `RESTORK_VAULT_DIR`; release builds deliberately ignore
/// the environment so the native grant remains the sole desktop authority.
pub(crate) fn configured_vault_dir(data_root: &Path) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    let environment = std::env::var_os("RESTORK_VAULT_DIR")
        .and_then(|value| value.into_string().ok())
        .filter(|value| !value.trim().is_empty());
    #[cfg(not(debug_assertions))]
    let environment: Option<String> = None;
    let raw = environment.or_else(|| fs::read_to_string(data_root.join(VAULT_DIR_FILE)).ok())?;
    let candidate = raw.trim();
    if !valid_path_text(candidate) {
        return None;
    }
    let path = PathBuf::from(candidate);
    if !path.is_dir() {
        return None;
    }
    let canonical = fs::canonicalize(path).ok()?;
    canonical.is_dir().then_some(canonical)
}

/// Persist an approved Vault grant atomically in the private application-data directory.
pub(crate) fn save_vault_dir(data_root: &Path, path: &Path) -> Result<PathBuf, &'static str> {
    #[cfg(unix)]
    let home = std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let canonical = validate_vault_dir(data_root, path, home.as_deref())?;
    fs::create_dir_all(data_root).map_err(|_| "vault_path_persist_failed")?;
    let pending = data_root.join(VAULT_DIR_PENDING_FILE);
    let target = data_root.join(VAULT_DIR_FILE);
    write_private_file(&pending, canonical.to_string_lossy().as_bytes())?;
    replace_file(&pending, &target)?;
    sync_directory(data_root);
    Ok(canonical)
}

pub(crate) fn validate_vault_dir(
    data_root: &Path,
    path: &Path,
    home: Option<&Path>,
) -> Result<PathBuf, &'static str> {
    let text = path.to_string_lossy();
    if path.as_os_str().is_empty() || !valid_path_text(&text) {
        return Err("vault_path_invalid");
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "vault_path_unavailable")?;
    if metadata.file_type().is_symlink() {
        return Err("vault_path_symlink");
    }
    if !metadata.is_dir() {
        return Err("vault_path_not_directory");
    }
    let canonical = fs::canonicalize(path).map_err(|_| "vault_path_unavailable")?;
    let data_root = fs::canonicalize(data_root).unwrap_or_else(|_| data_root.to_path_buf());
    let home = home.and_then(|value| fs::canonicalize(value).ok());
    if canonical.parent().is_none()
        || canonical == data_root
        || home.as_ref().is_some_and(|value| canonical == *value)
    {
        return Err("vault_path_too_broad");
    }
    fs::read_dir(&canonical).map_err(|_| "vault_path_unreadable")?;
    Ok(canonical)
}

/// Create the short-lived descriptor consumed by Core during startup.
///
/// The descriptor path may appear in the process list; its contents and the
/// user's absolute Vault path may not. It is removed after readiness or failure.
pub(crate) fn prepare_launch_vault_grant(
    data_root: &Path,
    vault_dir: Option<&Path>,
) -> Result<Option<PathBuf>, &'static str> {
    fs::create_dir_all(data_root).map_err(|_| "vault_launch_grant_failed")?;
    let grant_file = data_root.join(VAULT_LAUNCH_FILE);
    remove_private_file(&grant_file)?;
    let Some(vault_dir) = vault_dir else {
        return Ok(None);
    };
    let text = vault_dir.to_str().ok_or("vault_launch_grant_failed")?;
    if !valid_path_text(text) {
        return Err("vault_launch_grant_failed");
    }
    write_private_file_with_error(&grant_file, text.as_bytes(), "vault_launch_grant_failed")?;
    Ok(Some(grant_file))
}

pub(crate) fn remove_launch_vault_grant(grant_file: Option<&Path>) -> Result<(), &'static str> {
    if let Some(path) = grant_file {
        remove_private_file(path)?;
    }
    Ok(())
}

pub(crate) fn append_launch_argument(command: &mut Command, grant_file: Option<&Path>) {
    if let Some(path) = grant_file {
        command.arg("--vault-grant-file").arg(path);
    }
}

fn valid_path_text(candidate: &str) -> bool {
    !candidate.is_empty()
        && candidate.len() <= VAULT_PATH_LIMIT
        && !candidate.contains(['\0', '\r', '\n'])
}

fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), &'static str> {
    write_private_file_with_error(path, contents, "vault_path_persist_failed")
}

fn write_private_file_with_error(
    path: &Path,
    contents: &[u8],
    error: &'static str,
) -> Result<(), &'static str> {
    remove_private_file_with_error(path, error)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    let mut file = options.open(path).map_err(|_| error)?;
    file.write_all(contents)
        .and_then(|()| file.sync_all())
        .map_err(|_| error)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| error)?;
    Ok(())
}

fn remove_private_file(path: &Path) -> Result<(), &'static str> {
    remove_private_file_with_error(path, "vault_launch_grant_failed")
}

fn remove_private_file_with_error(path: &Path, error: &'static str) -> Result<(), &'static str> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(error);
    }
    fs::remove_file(path).map_err(|_| error)
}

#[cfg(unix)]
fn replace_file(pending: &Path, target: &Path) -> Result<(), &'static str> {
    fs::rename(pending, target).map_err(|_| "vault_path_persist_failed")
}

#[cfg(windows)]
fn replace_file(pending: &Path, target: &Path) -> Result<(), &'static str> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !target.exists() {
        return fs::rename(pending, target).map_err(|_| "vault_path_persist_failed");
    }
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let pending = pending
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both UTF-16 paths are NUL-terminated and remain live for the call.
    let replaced = unsafe {
        ReplaceFileW(
            target.as_ptr(),
            pending.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    (replaced != 0)
        .then_some(())
        .ok_or("vault_path_persist_failed")
}

#[cfg(unix)]
fn sync_directory(data_root: &Path) {
    if let Ok(directory) = File::open(data_root) {
        let _ = directory.sync_all();
    }
}

#[cfg(windows)]
fn sync_directory(_data_root: &Path) {}

#[cfg(test)]
mod tests {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::process::Command;

    use super::{
        append_launch_argument, prepare_launch_vault_grant, remove_launch_vault_grant,
        save_vault_dir, validate_vault_dir,
    };

    #[test]
    fn vault_grants_are_specific_atomic_and_private() {
        let data_root = tempfile::tempdir().expect("data root");
        let vault = tempfile::tempdir().expect("vault");
        fs::write(vault.path().join("note.md"), "# note").expect("fixture note");
        let saved = save_vault_dir(data_root.path(), vault.path()).expect("save vault");
        assert_eq!(
            saved,
            fs::canonicalize(vault.path()).expect("canonical vault")
        );
        let config = data_root.path().join("vault-dir.txt");
        assert!(config.is_file());
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&config)
                .expect("config metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600,
        );
        assert!(!data_root.path().join("vault-dir.pending").exists());
    }

    #[cfg(unix)]
    #[test]
    fn vault_grants_reject_broad_or_indirect_roots() {
        let data_root = tempfile::tempdir().expect("data root");
        let home = tempfile::tempdir().expect("synthetic home");
        let vault = tempfile::tempdir().expect("vault");
        let link = data_root.path().join("linked-vault");
        symlink(vault.path(), &link).expect("symlink fixture");
        assert_eq!(
            validate_vault_dir(data_root.path(), home.path(), Some(home.path())),
            Err("vault_path_too_broad"),
        );
        assert_eq!(
            validate_vault_dir(data_root.path(), &link, Some(home.path())),
            Err("vault_path_symlink"),
        );
        assert_eq!(
            validate_vault_dir(data_root.path(), data_root.path(), Some(home.path())),
            Err("vault_path_too_broad"),
        );
    }

    #[test]
    fn launch_arguments_expose_only_the_private_descriptor() {
        let data_root = tempfile::tempdir().expect("data root");
        let vault = tempfile::tempdir().expect("vault");
        let grant = prepare_launch_vault_grant(data_root.path(), Some(vault.path()))
            .expect("prepare grant")
            .expect("grant path");
        let mut command = Command::new("restorkd");
        append_launch_argument(&mut command, Some(&grant));
        let arguments = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(arguments[0], "--vault-grant-file");
        assert_eq!(arguments[1], grant.to_string_lossy());
        assert!(
            !arguments
                .iter()
                .any(|value| value.contains(vault.path().to_string_lossy().as_ref()))
        );
        assert_eq!(
            fs::read_to_string(&grant).expect("private grant contents"),
            vault.path().to_string_lossy()
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&grant)
                .expect("grant metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600,
        );
        remove_launch_vault_grant(Some(&grant)).expect("remove launch grant");
        assert!(!grant.exists());
    }
}
