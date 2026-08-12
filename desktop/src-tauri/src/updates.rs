use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(not(windows))]
use std::fs::File;
use std::{fs::OpenOptions, io::Write};

#[cfg(any(test, not(debug_assertions)))]
use semver::Version;
use serde::{Deserialize, Serialize};
#[cfg(any(test, not(debug_assertions)))]
use sha2::{Digest, Sha256};

use crate::update::{UpdatePreferences, UpdateScheduleMode};

#[cfg(any(test, not(debug_assertions)))]
const MAX_RECOVERY_ARTIFACTS: usize = 2;
const APP_IDENTIFIER: &str = "io.github.totoro-qaq.restork";
#[cfg(any(test, not(debug_assertions)))]
const ARCHIVE_DIRECTORY: &str = "verified-updates";
const LEDGER_FILENAME: &str = "update-ledger.json";
const PREFERENCES_FILENAME: &str = "update-preferences.json";

pub struct UpdateStorage {
    root: PathBuf,
}

/// Background discovery is deliberately notification-only. Installing an
/// update is a user action because it can stop an active Core process.
#[cfg(any(test, not(debug_assertions)))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackgroundUpdateAction {
    NotifyOnly,
}

#[cfg(any(test, not(debug_assertions)))]
pub const fn background_update_action() -> BackgroundUpdateAction {
    BackgroundUpdateAction::NotifyOnly
}

impl UpdateStorage {
    pub fn open(app_data_root: &Path) -> Result<Self, &'static str> {
        let parent = app_data_root
            .parent()
            .ok_or("update_storage_unavailable")?
            .canonicalize()
            .map_err(|_| "update_storage_unavailable")?;
        let root = app_data_root
            .canonicalize()
            .map_err(|_| "update_storage_unavailable")?;
        if !root.starts_with(&parent)
            || root.parent() != Some(parent.as_path())
            || root.file_name().and_then(|value| value.to_str()) != Some(APP_IDENTIFIER)
        {
            return Err("update_storage_unavailable");
        }
        let metadata = root.metadata().map_err(|_| "update_storage_unavailable")?;
        if !metadata.is_dir() {
            return Err("update_storage_unavailable");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;

            // SAFETY: getuid has no preconditions and only returns the caller uid.
            if metadata.uid() != unsafe { libc::getuid() } || metadata.mode() & 0o077 != 0 {
                return Err("update_storage_unavailable");
            }
        }
        Ok(Self { root })
    }

    fn ledger_path(&self) -> PathBuf {
        self.root.join(LEDGER_FILENAME)
    }

    fn preferences_path(&self) -> PathBuf {
        self.root.join(PREFERENCES_FILENAME)
    }

    #[cfg(any(test, not(debug_assertions)))]
    fn archive_directory(&self) -> Result<PathBuf, &'static str> {
        private_child_directory(&self.root, ARCHIVE_DIRECTORY)
            .map_err(|_| "update_archive_unavailable")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RecoveryArtifact {
    pub version: String,
    pub target: String,
    pub filename: String,
    pub sha256: String,
    pub verified_at_unix: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
struct UpdateLedger {
    schema_version: u8,
    highest_seen_version: Option<String>,
    recovery_artifacts: Vec<RecoveryArtifact>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PersistedUpdateState {
    schema_version: u8,
    pub preferences: UpdatePreferences,
    pub scheduled_mode: Option<UpdateScheduleMode>,
    pub pending_version: Option<String>,
    pub last_checked_at_unix: Option<u64>,
    #[serde(default)]
    pub launch_count: u32,
    #[serde(default)]
    pub dismissed_version: Option<String>,
}

impl Default for PersistedUpdateState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            preferences: UpdatePreferences::default(),
            scheduled_mode: None,
            pending_version: None,
            last_checked_at_unix: None,
            launch_count: 0,
            dismissed_version: None,
        }
    }
}

impl PersistedUpdateState {
    pub fn new(
        preferences: UpdatePreferences,
        scheduled_mode: Option<UpdateScheduleMode>,
        pending_version: Option<String>,
        last_checked_at_unix: Option<u64>,
        launch_count: u32,
        dismissed_version: Option<String>,
    ) -> Self {
        Self {
            schema_version: 1,
            preferences,
            scheduled_mode,
            pending_version,
            last_checked_at_unix,
            launch_count,
            dismissed_version,
        }
    }
}

pub fn load_update_state(storage: &UpdateStorage) -> PersistedUpdateState {
    let Some(path) = existing_child_file(&storage.root, &storage.preferences_path()) else {
        return PersistedUpdateState::default();
    };
    let Ok(document) = fs::read(path) else {
        return PersistedUpdateState::default();
    };
    if document.len() > 16 * 1024 {
        return PersistedUpdateState::default();
    }
    serde_json::from_slice::<PersistedUpdateState>(&document)
        .ok()
        .filter(|state| state.schema_version == 1)
        .unwrap_or_default()
}

pub fn save_update_state(
    storage: &UpdateStorage,
    state: &PersistedUpdateState,
) -> Result<(), &'static str> {
    let mut document = state.clone();
    document.schema_version = 1;
    let bytes = serde_json::to_vec_pretty(&document).map_err(|_| "update_state_unavailable")?;
    atomic_write(&storage.root, &storage.preferences_path(), &bytes)
        .map_err(|_| "update_state_unavailable")
}

#[cfg(any(test, not(debug_assertions)))]
pub fn accepts_update(
    current: &str,
    candidate: &str,
    target: &str,
    expected_target: &str,
    storage: &UpdateStorage,
) -> bool {
    let (Ok(current), Ok(candidate)) = (Version::parse(current), Version::parse(candidate)) else {
        return false;
    };
    if candidate <= current || target != expected_target || target.is_empty() {
        return false;
    }
    let ledger = read_ledger(storage).unwrap_or_default();
    ledger
        .highest_seen_version
        .as_deref()
        .and_then(|version| Version::parse(version).ok())
        .is_none_or(|highest| candidate >= highest)
}

#[cfg(any(test, not(debug_assertions)))]
pub fn archive_verified_update(
    storage: &UpdateStorage,
    version: &str,
    target: &str,
    bytes: &[u8],
) -> Result<RecoveryArtifact, &'static str> {
    let version = Version::parse(version).map_err(|_| "update_version_invalid")?;
    if !safe_identifier(target, 128) || bytes.is_empty() {
        return Err("update_archive_invalid");
    }
    let directory = storage.archive_directory()?;
    let archive_name = format!(
        "{}.archive",
        hex_digest(format!("{}\0{}", version, target).as_bytes())
    );
    let destination = directory.join(&archive_name);
    atomic_write(&storage.root, &destination, bytes).map_err(|_| "update_archive_unavailable")?;
    let artifact = RecoveryArtifact {
        version: version.to_string(),
        target: target.to_owned(),
        filename: format!("{ARCHIVE_DIRECTORY}/{archive_name}"),
        sha256: hex_digest(bytes),
        verified_at_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs()),
    };
    let mut ledger = read_ledger(storage).unwrap_or_default();
    ledger.schema_version = 1;
    ledger.highest_seen_version = Some(version.to_string());
    ledger
        .recovery_artifacts
        .retain(|existing| existing.version != artifact.version || existing.target != target);
    ledger.recovery_artifacts.push(artifact.clone());
    ledger.recovery_artifacts.sort_by(|left, right| {
        Version::parse(&right.version)
            .ok()
            .cmp(&Version::parse(&left.version).ok())
    });
    let stale = ledger
        .recovery_artifacts
        .iter()
        .skip(MAX_RECOVERY_ARTIFACTS)
        .map(|item| item.filename.clone())
        .collect::<Vec<_>>();
    ledger.recovery_artifacts.truncate(MAX_RECOVERY_ARTIFACTS);
    let document = serde_json::to_vec_pretty(&ledger).map_err(|_| "update_archive_unavailable")?;
    atomic_write(&storage.root, &storage.ledger_path(), &document)
        .map_err(|_| "update_archive_unavailable")?;
    for filename in stale {
        remove_recovery_artifact(storage, &filename);
    }
    Ok(artifact)
}

pub fn recovery_artifacts(storage: &UpdateStorage) -> Vec<RecoveryArtifact> {
    read_ledger(storage)
        .map(|ledger| ledger.recovery_artifacts)
        .unwrap_or_default()
}

#[cfg(not(debug_assertions))]
pub fn verified_update_bytes(
    storage: &UpdateStorage,
    version: &str,
    target: &str,
) -> Result<Vec<u8>, &'static str> {
    const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;
    let artifact = read_ledger(storage)
        .and_then(|ledger| {
            ledger
                .recovery_artifacts
                .into_iter()
                .find(|item| item.version == version && item.target == target)
        })
        .ok_or("update_archive_missing")?;
    let (directory, filename) = artifact
        .filename
        .split_once('/')
        .ok_or("update_archive_invalid")?;
    if directory != ARCHIVE_DIRECTORY || !safe_filename(filename) {
        return Err("update_archive_invalid");
    }
    let directory = storage.archive_directory()?;
    let requested = directory.join(filename);
    let path = requested
        .canonicalize()
        .map_err(|_| "update_archive_missing")?;
    if !path.starts_with(&storage.root) || path.parent() != Some(directory.as_path()) {
        return Err("update_archive_invalid");
    }
    let metadata = path.metadata().map_err(|_| "update_archive_missing")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_UPDATE_BYTES {
        return Err("update_archive_invalid");
    }
    let bytes = fs::read(path).map_err(|_| "update_archive_missing")?;
    if hex_digest(&bytes) != artifact.sha256 {
        return Err("update_archive_tampered");
    }
    Ok(bytes)
}

fn read_ledger(storage: &UpdateStorage) -> Option<UpdateLedger> {
    let path = existing_child_file(&storage.root, &storage.ledger_path())?;
    let document = fs::read(path).ok()?;
    if document.len() > 64 * 1024 {
        return None;
    }
    let ledger: UpdateLedger = serde_json::from_slice(&document).ok()?;
    (ledger.schema_version == 1).then_some(ledger)
}

fn safe_filename(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && !matches!(value, "." | "..")
}

#[cfg(any(test, not(debug_assertions)))]
fn safe_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn atomic_write(root: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("destination has no parent"))?
        .canonicalize()?;
    if !parent.starts_with(root) {
        return Err(std::io::Error::other("destination escaped update storage"));
    }
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| safe_filename(value))
        .ok_or_else(|| std::io::Error::other("destination filename is invalid"))?;
    let destination = parent.join(filename);
    if destination
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(std::io::Error::other("destination is a symlink"));
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        filename,
        std::process::id(),
        nonce
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let commit = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, &destination)
    })();
    if commit.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    commit?;
    #[cfg(not(windows))]
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(windows)]
fn replace_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source = temporary
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    // SAFETY: both arguments are owned, NUL-terminated UTF-16 buffers that
    // remain alive for the duration of the Win32 call.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(any(test, not(debug_assertions)))]
fn private_child_directory(root: &Path, name: &str) -> std::io::Result<PathBuf> {
    if !safe_filename(name) {
        return Err(std::io::Error::other("directory name is invalid"));
    }
    let requested = root.join(name);
    match fs::create_dir(&requested) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let path = requested.canonicalize()?;
    if !path.starts_with(root) || path.parent() != Some(root) {
        return Err(std::io::Error::other("directory escaped update storage"));
    }
    let metadata = path.metadata()?;
    if !metadata.is_dir() {
        return Err(std::io::Error::other(
            "update archive path is not a directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}

fn existing_child_file(root: &Path, requested: &Path) -> Option<PathBuf> {
    let path = requested.canonicalize().ok()?;
    if !path.starts_with(root)
        || path.parent() != Some(root)
        || path.file_name() != requested.file_name()
        || !path.is_file()
    {
        return None;
    }
    Some(path)
}

#[cfg(any(test, not(debug_assertions)))]
fn remove_recovery_artifact(storage: &UpdateStorage, relative: &str) {
    let Some((directory, filename)) = relative.split_once('/') else {
        return;
    };
    if directory != ARCHIVE_DIRECTORY || !safe_filename(filename) || relative.contains("..") {
        return;
    }
    let Ok(directory) = storage.archive_directory() else {
        return;
    };
    let requested = directory.join(filename);
    let Ok(path) = requested.canonicalize() else {
        return;
    };
    if path.starts_with(&storage.root) && path.parent() == Some(directory.as_path()) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(any(test, not(debug_assertions)))]
fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
#[path = "updates_tests.rs"]
mod tests;
