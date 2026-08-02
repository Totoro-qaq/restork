use std::{fs, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use restork_core::auth::PairingAuthority;
use restork_storage::Database;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let mut suffix = [0_u8; 12];
        getrandom::fill(&mut suffix).expect("entropy");
        let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "restork-api-automation-{}",
            suffix
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ));
        fs::create_dir(&path).expect("directory");
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

async fn call(
    app: Router,
    method: Method,
    path: &str,
    body: Option<Value>,
    authorization: Option<&str>,
) -> (StatusCode, Option<Value>) {
    let mut request = Request::builder().method(method).uri(path);
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    if let Some(authorization) = authorization {
        request = request.header("authorization", authorization);
    }
    let response = app
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let body = (!bytes.is_empty()).then(|| serde_json::from_slice(&bytes).expect("JSON"));
    (status, body)
}

async fn paired_app() -> (Router, String, TestDirectory) {
    let directory = TestDirectory::new();
    let database = Arc::new(Database::open(directory.0.join("restork.db")).expect("database"));
    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let code = authority.initial_pairing_code();
    let app = restork_api::router_with_storage(authority, database);
    let (_, body) = call(
        app.clone(),
        Method::POST,
        "/v1/pair",
        Some(json!({"code": code})),
        None,
    )
    .await;
    let token = body.expect("token")["access_token"]
        .as_str()
        .expect("token")
        .to_owned();
    (app, format!("Bearer {token}"), directory)
}

async fn call_idempotent(
    app: Router,
    path: &str,
    body: Value,
    authorization: &str,
) -> (StatusCode, Option<Value>) {
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(path)
                .header("content-type", "application/json")
                .header("authorization", authorization)
                .header("idempotency-key", "restore-checkpoint-fixture")
                .body(Body::from(body.to_string()))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let body = (!bytes.is_empty()).then(|| serde_json::from_slice(&bytes).expect("JSON"));
    (status, body)
}

fn checkpoint(path: &str) -> Value {
    json!({
        "checkpoint_id": "checkpoint:1",
        "run_id": "run:1",
        "files": [{
            "relative_path": path,
            "content_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "byte_count": 12
        }],
        "maximum_files": 10,
        "maximum_bytes": 1024,
        "expires_at": "2026-09-02T00:00:00Z"
    })
}

#[tokio::test]
async fn checkpoints_are_bounded_and_restore_requires_a_pre_rollback_checkpoint() {
    let (app, authorization, directory) = paired_app().await;
    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/checkpoints",
        Some(checkpoint("../private.md")),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let target_root = directory.0.join("effect-root");
    fs::create_dir_all(target_root.join("Notes")).expect("effect root");
    fs::write(target_root.join("Notes/synthetic.md"), b"before\n").expect("current file");
    let before_content = b"before\n";
    let before_hash = Sha256::digest(before_content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut before = checkpoint("Notes/synthetic.md");
    before["checkpoint_id"] = json!("checkpoint:before-rollback");
    before["files"][0]["content_hash"] = json!(before_hash);
    before["files"][0]["byte_count"] = json!(before_content.len());
    before["files"][0]["content_base64"] = json!("YmVmb3JlCg==");
    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/checkpoints",
        Some(before),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let content = b"hello world\n";
    let content_hash = Sha256::digest(content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut recoverable = checkpoint("Notes/synthetic.md");
    recoverable["files"][0]["content_hash"] = json!(content_hash);
    recoverable["files"][0]["content_base64"] = json!("aGVsbG8gd29ybGQK");
    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/checkpoints",
        Some(recoverable),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created.expect("checkpoint")["total_bytes"], 12);

    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/checkpoints/checkpoint:1/restore-preview",
        Some(json!({"paths": null, "pre_rollback_checkpoint": ""})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (status, preview) = call(
        app.clone(),
        Method::POST,
        "/v1/checkpoints/checkpoint:1/restore-preview",
        Some(json!({
            "paths": ["Notes/synthetic.md"],
            "pre_rollback_checkpoint": "checkpoint:before-rollback",
            "target_root": target_root.to_string_lossy()
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let preview = preview.expect("preview");
    assert_eq!(preview["ready_to_apply"], true);
    assert_eq!(preview["files"].as_array().expect("files").len(), 1);
    let preview_hash = preview["preview_hash"]
        .as_str()
        .expect("preview hash")
        .to_owned();

    fs::write(
        target_root.join("Notes/synthetic.md"),
        b"changed after preview\n",
    )
    .expect("change current file");
    let (status, _) = call_idempotent(
        app.clone(),
        "/v1/checkpoints/checkpoint:1/restore",
        json!({
            "paths": ["Notes/synthetic.md"],
            "pre_rollback_checkpoint": "checkpoint:before-rollback",
            "target_root": target_root.to_string_lossy(),
            "expected_preview_hash": preview_hash.clone()
        }),
        &authorization,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        fs::read(target_root.join("Notes/synthetic.md")).expect("unchanged conflicting file"),
        b"changed after preview\n"
    );
    fs::write(target_root.join("Notes/synthetic.md"), before_content).expect("reset current file");

    let (status, restored) = call_idempotent(
        app,
        "/v1/checkpoints/checkpoint:1/restore",
        json!({
            "paths": ["Notes/synthetic.md"],
            "pre_rollback_checkpoint": "checkpoint:before-rollback",
            "target_root": target_root.to_string_lossy(),
            "expected_preview_hash": preview_hash
        }),
        &authorization,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let restored = restored.expect("restored content");
    assert_eq!(restored["integrity_verified"], true);
    assert_eq!(restored["effect_applied"], true);
    assert!(restored["files"][0].get("content_base64").is_none());
    assert_eq!(
        fs::read(target_root.join("Notes/synthetic.md")).expect("restored file"),
        content
    );
}

#[tokio::test]
async fn evaluation_freezes_versions_and_private_trajectories_never_enter_public_exports() {
    let (app, authorization, _directory) = paired_app().await;
    let (status, evaluation) = call(
        app,
        Method::POST,
        "/v1/evaluations",
        Some(json!({
            "evaluation_id": "evaluation:1",
            "suite_id": "suite:synthetic",
            "model_ref": "model@sha256:aaaaaaaa",
            "prompt_ref": "prompt@sha256:bbbbbbbb",
            "skill_ref": "skill@sha256:cccccccc",
            "tool_manifest_ref": "tools@sha256:dddddddd",
            "policy_ref": "policy@sha256:eeeeeeee",
            "fixture_ref": "fixtures@sha256:ffffffff",
            "result": {"passed": 4, "failed": 0},
            "contains_private_trajectories": true
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let evaluation = evaluation.expect("evaluation");
    assert_eq!(
        evaluation["manifest"]["public_export_includes_private_trajectory"],
        false
    );
    assert_eq!(
        evaluation["manifest_hash"].as_str().expect("hash").len(),
        64
    );
}

#[tokio::test]
async fn delegated_subtasks_can_only_reduce_parent_authority_and_cannot_write_or_recurse() {
    let (app, authorization, _directory) = paired_app().await;
    let request = |depth: u8, tools: Value| {
        json!({
            "subtask_id": "subtask:1",
            "parent_run_id": "run:parent",
            "depth": depth,
            "source_refs": ["source:a"],
            "allowed_tools": tools,
            "budget": {"model_turns": 2, "tool_calls": 1, "tokens": 2000, "wall_time_ms": 10000},
            "parent_sources": ["source:a", "source:b"],
            "parent_tools": ["vault.search", "vault.write"],
            "parent_budget": {"model_turns": 8, "tool_calls": 6, "tokens": 20000, "wall_time_ms": 60000}
        })
    };
    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/subtasks",
        Some(request(2, json!(["vault.search"]))),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/subtasks",
        Some(request(1, json!(["vault.write"]))),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, subtask) = call(
        app.clone(),
        Method::POST,
        "/v1/subtasks",
        Some(request(1, json!(["vault.search"]))),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let spec = &subtask.expect("subtask")["spec"];
    assert_eq!(spec["can_approve_effects"], false);
    assert_eq!(spec["can_write_memory"], false);
    assert_eq!(spec["can_delegate"], false);

    let (status, _) = call_idempotent(
        app.clone(),
        "/v1/subtasks/subtask:1/execute",
        json!({}),
        &authorization,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let response = app
        .oneshot(
            Request::builder()
                .method(Method::DELETE)
                .uri("/v1/subtasks/subtask:1")
                .header("authorization", authorization)
                .header("idempotency-key", "cancel-subtask-fixture")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes(),
    )
    .expect("JSON");
    assert_eq!(body["state"], "cancelled");
}
