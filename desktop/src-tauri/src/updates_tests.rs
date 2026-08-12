use std::fs;

use tempfile::TempDir;

use super::{
    APP_IDENTIFIER, ARCHIVE_DIRECTORY, BackgroundUpdateAction, RecoveryArtifact, UpdateLedger,
    UpdateStorage, accepts_update, archive_verified_update, background_update_action,
    recovery_artifacts,
};

fn storage(directory: &TempDir) -> UpdateStorage {
    let root = directory.path().join(APP_IDENTIFIER);
    fs::create_dir(&root).expect("app data directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("private permissions");
    }
    UpdateStorage::open(&root).expect("trusted update storage")
}

#[test]
fn background_update_discovery_never_installs_silently() {
    assert_eq!(
        background_update_action(),
        BackgroundUpdateAction::NotifyOnly
    );
}

#[test]
fn update_policy_rejects_downgrade_replay_and_wrong_target() {
    let directory = TempDir::new().expect("temporary directory");
    let storage = storage(&directory);
    assert!(accepts_update(
        "0.1.2",
        "0.1.3",
        "darwin-aarch64",
        "darwin-aarch64",
        &storage
    ));
    archive_verified_update(&storage, "0.1.4", "darwin-aarch64", b"verified").expect("archive");
    assert!(!accepts_update(
        "0.1.2",
        "0.1.3",
        "darwin-aarch64",
        "darwin-aarch64",
        &storage
    ));
    assert!(!accepts_update(
        "0.1.2",
        "0.1.5",
        "windows-x86_64",
        "darwin-aarch64",
        &storage
    ));
    assert!(!accepts_update(
        "0.1.2",
        "0.1.2",
        "darwin-aarch64",
        "darwin-aarch64",
        &storage
    ));
}

#[test]
fn verified_installers_are_hash_bound_and_bounded_for_recovery() {
    let directory = TempDir::new().expect("temporary directory");
    let storage = storage(&directory);
    for version in ["0.1.3", "0.1.4", "0.1.5"] {
        archive_verified_update(&storage, version, "linux-x86_64", version.as_bytes())
            .expect("archive");
    }
    let recovery = recovery_artifacts(&storage);
    assert_eq!(recovery.len(), 2);
    assert_eq!(recovery[0].version, "0.1.5");
    assert_eq!(recovery[0].sha256.len(), 64);
    assert!(recovery[0].filename.starts_with("verified-updates/"));
    assert_eq!(
        fs::read_dir(storage.root.join(ARCHIVE_DIRECTORY))
            .expect("archive directory")
            .count(),
        2
    );
}

#[cfg(unix)]
#[test]
fn update_storage_rejects_a_symlinked_application_root() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let directory = TempDir::new().expect("temporary directory");
    let real = directory.path().join("real");
    fs::create_dir(&real).expect("real directory");
    fs::set_permissions(&real, fs::Permissions::from_mode(0o700)).expect("private permissions");
    let link = directory.path().join(APP_IDENTIFIER);
    symlink(&real, &link).expect("symlink fixture");

    assert!(UpdateStorage::open(&link).is_err());
}

#[test]
fn a_tampered_recovery_ledger_cannot_delete_outside_update_storage() {
    let directory = TempDir::new().expect("temporary directory");
    let storage = storage(&directory);
    let victim = directory.path().join("preserve.txt");
    fs::write(&victim, b"preserve").expect("victim fixture");
    let ledger = UpdateLedger {
        schema_version: 1,
        highest_seen_version: Some("0.1.5".to_owned()),
        recovery_artifacts: vec![
            RecoveryArtifact {
                version: "0.1.5".to_owned(),
                target: "linux-x86_64".to_owned(),
                filename: "verified-updates/existing.archive".to_owned(),
                sha256: "a".repeat(64),
                verified_at_unix: 1,
            },
            RecoveryArtifact {
                version: "0.1.3".to_owned(),
                target: "linux-x86_64".to_owned(),
                filename: "../../preserve.txt".to_owned(),
                sha256: "b".repeat(64),
                verified_at_unix: 1,
            },
        ],
    };
    fs::write(
        storage.ledger_path(),
        serde_json::to_vec(&ledger).expect("ledger JSON"),
    )
    .expect("ledger fixture");

    archive_verified_update(&storage, "0.1.6", "linux-x86_64", b"new verified archive")
        .expect("archive update");

    assert_eq!(fs::read(victim).expect("victim retained"), b"preserve");
}
