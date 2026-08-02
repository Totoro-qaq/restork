use std::{collections::BTreeSet, fs, path::PathBuf};

use restork_worker::{
    CapabilityManifest, WorkerCommand, WorkerError, WorkerLimits, WorkerRequest, bytes_hash,
};
use serde_json::json;

struct TestDirectory(tempfile::TempDir);

impl TestDirectory {
    fn new() -> Self {
        Self(tempfile::tempdir().expect("temporary directory"))
    }
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_restork-worker-fixture"))
}

fn manifest(timeout_ms: u64, response_bytes: usize) -> CapabilityManifest {
    CapabilityManifest {
        capability_id: "synthetic-worker".to_owned(),
        version: "1.0.0".to_owned(),
        executable_hash: bytes_hash(&fs::read(fixture()).expect("fixture bytes")),
        allowed_relative_paths: BTreeSet::new(),
        network_allowed: false,
        secret_refs: BTreeSet::new(),
        limits: WorkerLimits::bounded(timeout_ms, 64 * 1024, response_bytes).expect("limits"),
    }
}

#[tokio::test]
async fn synthetic_worker_uses_a_bounded_frame_without_ambient_environment() {
    let directory = TestDirectory::new();
    let manifest = manifest(2_000, 64 * 1024);
    let command = WorkerCommand::new(fixture(), Vec::new(), directory.0.path()).expect("command");
    let request = WorkerRequest::new(
        "request-1",
        &manifest,
        json!({"behavior": "echo", "value": "synthetic"}),
    )
    .expect("request");

    let response = command
        .execute(&manifest, &request)
        .await
        .expect("response");
    let artifact = response.artifact.expect("artifact");
    assert_eq!(artifact.payload["echo"]["value"], "synthetic");
    assert_eq!(artifact.payload["home_inherited"], false);
    assert_eq!(artifact.payload["database_inherited"], false);
}

#[tokio::test]
async fn timeout_crash_malformed_and_oversized_workers_fail_closed() {
    let directory = TestDirectory::new();
    let command = WorkerCommand::new(fixture(), Vec::new(), directory.0.path()).expect("command");
    for (behavior, expected, timeout_ms, response_bytes) in [
        ("sleep", WorkerError::Timeout, 100, 64 * 1024),
        ("crash", WorkerError::MalformedResponse, 2_000, 64 * 1024),
        (
            "malformed",
            WorkerError::MalformedResponse,
            2_000,
            64 * 1024,
        ),
        ("oversized", WorkerError::OversizedOutput, 2_000, 1_024),
    ] {
        let manifest = manifest(timeout_ms, response_bytes);
        let request = WorkerRequest::new(
            &format!("request-{behavior}"),
            &manifest,
            json!({"behavior": behavior}),
        )
        .expect("request");
        assert_eq!(command.execute(&manifest, &request).await, Err(expected));
    }
}

#[test]
fn manifests_cannot_grant_network_secrets_or_parent_paths() {
    let mut manifest = manifest(2_000, 1_024);
    manifest.network_allowed = true;
    assert_eq!(manifest.validate(), Err(WorkerError::InvalidManifest));
    manifest.network_allowed = false;
    manifest.secret_refs.insert("keychain:private".to_owned());
    assert_eq!(manifest.validate(), Err(WorkerError::InvalidManifest));
    manifest.secret_refs.clear();
    manifest
        .allowed_relative_paths
        .insert("../private".to_owned());
    assert_eq!(manifest.validate(), Err(WorkerError::InvalidManifest));
}
