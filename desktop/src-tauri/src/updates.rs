use std::{fs, path::Path};

#[cfg(all(any(test, not(debug_assertions)), not(windows)))]
use std::fs::File;
#[cfg(any(test, not(debug_assertions)))]
use std::{
    fs::OpenOptions,
    io::Write,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(any(test, not(debug_assertions)))]
use semver::Version;
use serde::{Deserialize, Serialize};
#[cfg(any(test, not(debug_assertions)))]
use sha2::{Digest, Sha256};

#[cfg(any(test, not(debug_assertions)))]
const MAX_RECOVERY_ARTIFACTS: usize = 2;

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

#[cfg(any(test, not(debug_assertions)))]
pub fn accepts_update(
    current: &str,
    candidate: &str,
    target: &str,
    expected_target: &str,
    ledger_path: &Path,
) -> bool {
    let (Ok(current), Ok(candidate)) = (Version::parse(current), Version::parse(candidate)) else {
        return false;
    };
    if candidate <= current || target != expected_target || target.is_empty() {
        return false;
    }
    let ledger = read_ledger(ledger_path).unwrap_or_default();
    ledger
        .highest_seen_version
        .as_deref()
        .and_then(|version| Version::parse(version).ok())
        .is_none_or(|highest| candidate >= highest)
}

#[cfg(any(test, not(debug_assertions)))]
pub fn archive_verified_update(
    cache_root: &Path,
    ledger_path: &Path,
    version: &str,
    target: &str,
    filename: &str,
    bytes: &[u8],
) -> Result<RecoveryArtifact, &'static str> {
    let version = Version::parse(version).map_err(|_| "update_version_invalid")?;
    if target.is_empty() || target.len() > 128 || !safe_filename(filename) || bytes.is_empty() {
        return Err("update_archive_invalid");
    }
    let directory = cache_root
        .join("verified-updates")
        .join(version.to_string());
    create_private_directory(&directory).map_err(|_| "update_archive_unavailable")?;
    let destination = directory.join(filename);
    atomic_write(&destination, bytes).map_err(|_| "update_archive_unavailable")?;
    let artifact = RecoveryArtifact {
        version: version.to_string(),
        target: target.to_owned(),
        filename: destination.to_string_lossy().into_owned(),
        sha256: hex_digest(bytes),
        verified_at_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs()),
    };
    let mut ledger = read_ledger(ledger_path).unwrap_or_default();
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
    ledger.recovery_artifacts.truncate(MAX_RECOVERY_ARTIFACTS);
    let document = serde_json::to_vec_pretty(&ledger).map_err(|_| "update_archive_unavailable")?;
    if let Some(parent) = ledger_path.parent() {
        create_private_directory(parent).map_err(|_| "update_archive_unavailable")?;
    }
    atomic_write(ledger_path, &document).map_err(|_| "update_archive_unavailable")?;
    Ok(artifact)
}

pub fn recovery_artifacts(ledger_path: &Path) -> Vec<RecoveryArtifact> {
    read_ledger(ledger_path)
        .map(|ledger| ledger.recovery_artifacts)
        .unwrap_or_default()
}

fn read_ledger(path: &Path) -> Option<UpdateLedger> {
    let document = fs::read(path).ok()?;
    if document.len() > 64 * 1024 {
        return None;
    }
    let ledger: UpdateLedger = serde_json::from_slice(&document).ok()?;
    (ledger.schema_version == 1).then_some(ledger)
}

#[cfg(any(test, not(debug_assertions)))]
fn safe_filename(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && !matches!(value, "." | "..")
}

#[cfg(any(test, not(debug_assertions)))]
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let temporary = path.with_extension(format!("{}.{}.tmp", std::process::id(), nonce));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    replace_file(&temporary, path)?;
    #[cfg(not(windows))]
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(all(any(test, not(debug_assertions)), not(windows)))]
fn replace_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(all(any(test, not(debug_assertions)), windows))]
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
fn create_private_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(any(test, not(debug_assertions)))]
fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::{fs, time::SystemTime};

    use super::{accepts_update, archive_verified_update, recovery_artifacts};

    fn directory() -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("restork-update-{suffix}"));
        fs::create_dir(&path).expect("directory");
        path
    }

    #[test]
    fn update_policy_rejects_downgrade_replay_and_wrong_target() {
        let root = directory();
        let ledger = root.join("ledger.json");
        assert!(accepts_update(
            "0.1.2",
            "0.1.3",
            "darwin-aarch64",
            "darwin-aarch64",
            &ledger
        ));
        archive_verified_update(
            &root,
            &ledger,
            "0.1.4",
            "darwin-aarch64",
            "Restork.app.tar.gz",
            b"verified",
        )
        .expect("archive");
        assert!(!accepts_update(
            "0.1.2",
            "0.1.3",
            "darwin-aarch64",
            "darwin-aarch64",
            &ledger
        ));
        assert!(!accepts_update(
            "0.1.2",
            "0.1.5",
            "windows-x86_64",
            "darwin-aarch64",
            &ledger
        ));
        assert!(!accepts_update(
            "0.1.2",
            "0.1.2",
            "darwin-aarch64",
            "darwin-aarch64",
            &ledger
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn verified_installers_are_hash_bound_and_bounded_for_recovery() {
        let root = directory();
        let ledger = root.join("ledger.json");
        for version in ["0.1.3", "0.1.4", "0.1.5"] {
            archive_verified_update(
                &root,
                &ledger,
                version,
                "linux-x86_64",
                &format!("Restork-{version}.AppImage"),
                version.as_bytes(),
            )
            .expect("archive");
        }
        let recovery = recovery_artifacts(&ledger);
        assert_eq!(recovery.len(), 2);
        assert_eq!(recovery[0].version, "0.1.5");
        assert_eq!(recovery[0].sha256.len(), 64);
        let _ = fs::remove_dir_all(root);
    }
}
