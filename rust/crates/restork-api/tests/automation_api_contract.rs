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
    let (app, authorization, _directory) = paired_app().await;
    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/checkpoints",
        Some(checkpoint("../private.md")),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/checkpoints",
        Some(checkpoint("Notes/synthetic.md")),
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
        app,
        Method::POST,
        "/v1/checkpoints/checkpoint:1/restore-preview",
        Some(json!({
            "paths": ["Notes/synthetic.md"],
            "pre_rollback_checkpoint": "checkpoint:before-rollback"
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        preview.expect("preview")["files"]
            .as_array()
            .expect("files")
            .len(),
        1
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
        app,
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
}
