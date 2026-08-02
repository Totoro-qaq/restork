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
            "restork-api-catalog-{}",
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

async fn call_with_idempotency(
    app: Router,
    method: Method,
    path: &str,
    authorization: &str,
    idempotency_key: &str,
) -> (StatusCode, Option<Value>) {
    let response = app
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", authorization)
                .header("idempotency-key", idempotency_key)
                .body(Body::empty())
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

async fn call_with_body_and_idempotency(
    app: Router,
    method: Method,
    path: &str,
    body: Value,
    authorization: &str,
    idempotency_key: &str,
) -> (StatusCode, Option<Value>) {
    let response = app
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", authorization)
                .header("content-type", "application/json")
                .header("idempotency-key", idempotency_key)
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

async fn paired_app() -> (Router, String, TestDirectory) {
    let directory = TestDirectory::new();
    let database = Arc::new(Database::open(directory.0.join("restork.db")).expect("database"));
    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let code = authority.initial_pairing_code();
    let app = restork_api::router_with_storage(authority, database);
    let (status, body) = call(
        app.clone(),
        Method::POST,
        "/v1/pair",
        Some(json!({"code": code})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = body.expect("token")["access_token"]
        .as_str()
        .expect("token")
        .to_owned();
    (app, format!("Bearer {token}"), directory)
}

fn skill_manifest() -> Value {
    json!({
        "schema_version": 1,
        "id": "synthetic-skill",
        "version": "1.0.0",
        "provenance": {
            "source": {"kind": "catalog", "catalog_id": "restork-reviewed", "version": "1.0.0"},
            "license": "MIT",
            "content_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "signature": null
        },
        "compatibility": {"minimum_core_version": "0.1.0", "maximum_core_version": null},
        "enabled_profiles": ["safe-mode"],
        "procedure": "skills/synthetic.md",
        "prompt_references": [],
        "schema_references": [],
        "template_references": [],
        "requested_permissions": []
    })
}

fn mcp_manifest() -> Value {
    json!({
        "schema_version": 1,
        "id": "paper-mcp",
        "version": "1.0.0",
        "provenance": {
            "source": {"kind": "catalog", "catalog_id": "restork-reviewed", "version": "1.0.0"},
            "license": "MIT",
            "content_hash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "signature": null
        },
        "compatibility": {"minimum_core_version": "0.1.0", "maximum_core_version": null},
        "enabled_profiles": ["research-cloud"],
        "requested_permissions": ["network:papers"],
        "secret_references": [],
        "transport": {
            "kind": "remote_https",
            "endpoint": "https://papers.example.test/mcp",
            "oauth_profile": null
        },
        "sandbox": {
            "max_runtime_ms": 30000,
            "max_output_bytes": 1000000,
            "allow_network": true,
            "allowed_paths": []
        },
        "tools": [{
            "id": "papers.search",
            "name": "Search papers",
            "description": "Search the explicitly granted paper catalog.",
            "input_schema": "schemas/papers-search.json",
            "required_permissions": ["network:papers"]
        }]
    })
}

#[tokio::test]
async fn extension_install_is_validated_quarantined_and_hash_bound_before_enable() {
    let (app, authorization, _directory) = paired_app().await;
    let (status, installed) = call(
        app.clone(),
        Method::POST,
        "/v1/extensions",
        Some(json!({"package_kind": "skill", "manifest": skill_manifest()})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let installed = installed.expect("extension");
    assert_eq!(installed["state"], "quarantined");
    let manifest_hash = installed["manifest_hash"].as_str().expect("hash");

    let (status, _) = call(
        app.clone(),
        Method::PATCH,
        "/v1/extensions/synthetic-skill",
        Some(json!({"action": "enable", "expected_hash": "0".repeat(64)})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, enabled) = call(
        app,
        Method::PATCH,
        "/v1/extensions/synthetic-skill",
        Some(json!({"action": "enable", "expected_hash": manifest_hash})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(enabled.expect("enabled")["state"], "enabled");
}

#[tokio::test]
async fn extension_update_history_and_rollback_are_review_bound() {
    let (app, authorization, _directory) = paired_app().await;
    let first_manifest = skill_manifest();
    let (status, first) = call(
        app.clone(),
        Method::POST,
        "/v1/extensions",
        Some(json!({"package_kind": "skill", "manifest": first_manifest})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let first_hash = first.expect("first")["manifest_hash"]
        .as_str()
        .expect("first hash")
        .to_owned();
    let mut second_manifest = skill_manifest();
    second_manifest["version"] = json!("2.0.0");
    second_manifest["provenance"]["content_hash"] = json!("d".repeat(64));
    let (status, second) = call(
        app.clone(),
        Method::POST,
        "/v1/extensions",
        Some(json!({"package_kind": "skill", "manifest": second_manifest})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let second_hash = second.expect("second")["manifest_hash"]
        .as_str()
        .expect("second hash")
        .to_owned();

    let (status, history) = call(
        app.clone(),
        Method::GET,
        "/v1/extensions/synthetic-skill/revisions?limit=10",
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        history.expect("history")["items"]
            .as_array()
            .expect("items")
            .len(),
        2
    );

    let (status, rollback) = call_with_body_and_idempotency(
        app,
        Method::POST,
        "/v1/extensions/synthetic-skill/rollback",
        json!({"expected_hash": second_hash, "target_hash": first_hash}),
        &authorization,
        "rollback-synthetic-v1",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rollback = rollback.expect("rollback");
    assert_eq!(rollback["state"], "review_required");
    assert_eq!(rollback["extension"]["state"], "quarantined");
}

#[tokio::test]
async fn tool_discovery_preview_digest_and_execution_audit_are_frozen_to_the_session() {
    let (app, authorization, _directory) = paired_app().await;
    let (status, installed) = call(
        app.clone(),
        Method::POST,
        "/v1/extensions",
        Some(json!({"package_kind": "mcp", "manifest": mcp_manifest()})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let hash = installed.expect("extension")["manifest_hash"]
        .as_str()
        .expect("hash")
        .to_owned();
    let (status, _) = call(
        app.clone(),
        Method::PATCH,
        "/v1/extensions/paper-mcp",
        Some(json!({"action": "enable", "expected_hash": hash})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = call(
        app.clone(),
        Method::PUT,
        "/v1/configuration-profiles/research-cloud",
        Some(json!({
            "expected_revision": null,
            "profile": {
                "profile_id": "research-cloud",
                "version": 1,
                "name": "Research Cloud",
                "provider_profile_id": "deepseek-main",
                "prompt_manifest_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "enabled_skill_ids": [],
                "allowed_tools": ["papers.search"],
                "memory_namespace": "research-cloud",
                "maximum_data_class": "public",
                "include_display_name_in_prompt": false
            }
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        Some(json!({"title": "Paper review", "profile_id": "research-cloud", "locale": "en"})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let session_id = session.expect("session")["session_id"]
        .as_str()
        .expect("session id")
        .to_owned();

    let (status, search) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/sessions/{session_id}/tools/search?q=papers&limit=10"),
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let search = search.expect("search");
    assert_eq!(search["items"].as_array().expect("items").len(), 1);
    assert_eq!(search["items"][0]["tool_id"], "papers.search");

    let (status, preview) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/sessions/{session_id}/tool-call-preview"),
        Some(json!({"tool_id": "papers.search", "input": {"query": "Rust agents"}})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let preview = preview.expect("preview");
    assert_eq!(preview["execution_started"], false);
    assert_eq!(preview["state"], "review_required");
    assert_eq!(preview["resolved_call"]["real_tool_id"], "papers.search");
    let digest = preview["call_digest"].as_str().expect("call digest");

    let (status, execution) = call_with_body_and_idempotency(
        app.clone(),
        Method::POST,
        &format!("/v1/sessions/{session_id}/tool-calls"),
        json!({
            "tool_id": "papers.search",
            "input": {"query": "Rust agents"},
            "call_digest": digest
        }),
        &authorization,
        "papers-search-1",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{execution:?}");
    let execution = execution.expect("execution");
    assert_eq!(execution["state"], "failed");
    assert_eq!(execution["error_code"], "unsupported_transport");
    let execution_id = execution["execution_id"].as_str().expect("execution id");
    let (status, stored) = call(
        app,
        Method::GET,
        &format!("/v1/tool-executions/{execution_id}"),
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stored.expect("stored execution")["call_digest"], digest);
}

#[tokio::test]
async fn schedules_are_dst_aware_optimistic_and_model_jobs_remain_drafts() {
    let (app, authorization, _directory) = paired_app().await;
    let safe = json!({
        "schedule_id": "schedule-health",
        "timezone": "Asia/Shanghai",
        "recurrence": {"kind": "daily", "hour": 9, "minute": 0},
        "missed_run_policy": "create_draft",
        "job": {"kind": "deterministic", "job": "health.check"}
    });
    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/schedules",
        Some(safe),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let created = created.expect("schedule");
    assert_eq!(created["revision"], 1);
    assert_eq!(created["state"], "active");

    let unsafe_model = json!({
        "schedule_id": "schedule-unsafe",
        "timezone": "UTC",
        "recurrence": {"kind": "daily", "hour": 9, "minute": 0},
        "missed_run_policy": "create_draft",
        "job": {"kind": "model_draft", "profile_id": "research-cloud", "requested_effect": "vault.write"}
    });
    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/schedules",
        Some(unsafe_model),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (status, paused) = call(
        app,
        Method::PATCH,
        "/v1/schedules/schedule-health",
        Some(json!({"action": "pause", "expected_revision": 1})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let paused = paused.expect("paused");
    assert_eq!(paused["revision"], 2);
    assert_eq!(paused["state"], "paused");
    assert!(paused["next_run_at"].is_null());
}

#[tokio::test]
async fn manual_schedule_runs_are_idempotent_and_removal_is_revision_bound() {
    let (app, authorization, _directory) = paired_app().await;
    let schedule = json!({
        "schedule_id": "schedule-manual",
        "timezone": "UTC",
        "recurrence": {"kind": "daily", "hour": 9, "minute": 0},
        "missed_run_policy": "skip",
        "job": {"kind": "deterministic", "job": "health.check"}
    });
    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/schedules",
        Some(schedule),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created.expect("schedule")["revision"], 1);

    let (status, first) = call_with_idempotency(
        app.clone(),
        Method::POST,
        "/v1/schedules/schedule-manual/run",
        &authorization,
        "manual-run-1",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first.expect("first")["replayed"], false);
    let (status, replay) = call_with_idempotency(
        app.clone(),
        Method::POST,
        "/v1/schedules/schedule-manual/run",
        &authorization,
        "manual-run-1",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay.expect("replay")["replayed"], true);

    let (status, _) = call(
        app.clone(),
        Method::DELETE,
        "/v1/schedules/schedule-manual?expected_revision=2",
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(
        app,
        Method::DELETE,
        "/v1/schedules/schedule-manual?expected_revision=1",
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}
