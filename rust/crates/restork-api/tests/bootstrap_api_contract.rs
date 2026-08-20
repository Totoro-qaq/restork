use std::{collections::BTreeSet, fs, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use restork_core::auth::PairingAuthority;
use restork_storage::{Database, NewRadarRecord};
use serde_json::{Value, json};
use tower::ServiceExt;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let mut suffix = [0_u8; 12];
        getrandom::fill(&mut suffix).expect("test entropy");
        let suffix = suffix
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("restork-api-bootstrap-{suffix}"));
        fs::create_dir(&path).expect("create test directory");
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
    let body = (!bytes.is_empty()).then(|| serde_json::from_slice(&bytes).expect("JSON response"));
    (status, body)
}

async fn call_idempotent(
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
                .header("content-type", "application/json")
                .header("authorization", authorization)
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
    let body = (!bytes.is_empty()).then(|| serde_json::from_slice(&bytes).expect("JSON response"));
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
        .expect("access token")
        .to_owned();
    (app, format!("Bearer {token}"), directory)
}

#[tokio::test]
async fn bootstrap_returns_one_typed_workspace_projection() {
    let (app, authorization, _directory) = paired_app().await;
    let (status, body) = call(
        app.clone(),
        Method::GET,
        "/v1/bootstrap?timezone=Asia%2FShanghai",
        None,
        Some(&authorization),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let body = body.expect("bootstrap document");
    assert_eq!(body["runs"], json!([]));
    assert_eq!(body["firstRun"]["has_completed_run"], false);
    assert_eq!(body["domains"]["runs"]["state"], "ready");
    assert_eq!(body["domains"]["daily"]["state"], "ready");
    assert_eq!(body["domains"]["sessions"]["state"], "ready");
    assert!(body["workspaceV2"]["dailyContext"]["local_date"].is_string());
    assert!(body["workspaceV2"]["sessions"].is_array());
    let providers = body["workspaceV2"]["providerRegistry"]["items"]
        .as_array()
        .expect("provider registry");
    let deepseek = providers
        .iter()
        .find(|item| item["kind"] == "deepseek")
        .expect("DeepSeek definition");
    let setup_command = deepseek["setup_command"]
        .as_str()
        .expect("installation-aware setup command");
    assert!(setup_command.ends_with(" provider configure deepseek"));
    assert!(body["musicSources"].is_array());
}

#[tokio::test]
async fn bootstrap_keeps_cached_github_and_hacker_news_lanes_together() {
    let (app, authorization, directory) = paired_app().await;
    let database = Database::open(directory.0.join("restork.db")).expect("database");
    database
        .put_daily_cache(
            "radar-config",
            &json!({"enabled": true, "github_discovery": true, "hacker_news": true}),
            "2026-08-11T00:00:00Z",
            "9999-12-31T23:59:59Z",
            "2026-08-11T00:00:00Z",
        )
        .expect("Radar configuration");
    for index in 0..12 {
        let item_id = format!("github-{index}");
        let title = format!("example/project-{index}");
        database
            .upsert_radar(NewRadarRecord {
                item_id: &item_id,
                lane: "trending",
                title: &title,
                source: "github",
                url: "https://github.com/example/project",
                summary: "GitHub fixture",
                score: 10_000.0 - f64::from(index),
                stars_total: Some(10_000 - i64::from(index)),
                published_at: None,
                state: "new",
                data_class: "public",
                occurred_at: "2026-08-11T00:00:00Z",
            })
            .expect("GitHub Radar fixture");
    }
    for index in 0..12 {
        let item_id = format!("hn-{index}");
        let title = format!("Hacker News item {index}");
        database
            .upsert_radar(NewRadarRecord {
                item_id: &item_id,
                lane: "hn",
                title: &title,
                source: "hacker-news",
                url: "https://news.ycombinator.com/item?id=1",
                summary: "Hacker News fixture",
                score: 100.0 - f64::from(index),
                stars_total: None,
                published_at: None,
                state: "new",
                data_class: "public",
                occurred_at: "2026-08-11T00:00:00Z",
            })
            .expect("Hacker News Radar fixture");
    }

    let (status, body) = call(
        app,
        Method::GET,
        "/v1/bootstrap?timezone=Asia%2FShanghai",
        None,
        Some(&authorization),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let items = body.expect("bootstrap document")["radar"]["items"]
        .as_array()
        .expect("Radar items")
        .clone();
    assert!(items.iter().any(|item| item["lane"] == "trending"));
    assert!(items.iter().any(|item| item["lane"] == "hn"));
}

#[tokio::test]
async fn bootstrap_requires_a_paired_read_session() {
    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let app = restork_api::router(authority);
    let (status, _) = call(app, Method::GET, "/v1/bootstrap?timezone=UTC", None, None).await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn public_machine_schema_covers_every_versioned_router_path() {
    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let app = restork_api::router(authority);
    let (status, body) = call(app, Method::GET, "/v1/schema", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let body = body.expect("machine schema");
    let documented = body["routes"]
        .as_array()
        .expect("route list")
        .iter()
        .map(|route| route["path"].as_str().expect("route path").to_owned())
        .collect::<BTreeSet<_>>();

    // Route composition has one explicit owner. Keeping the inventory test on
    // that module lets `lib.rs` remain a composition root rather than a route
    // warehouse while still failing if schema and implementation drift.
    let source = include_str!("../src/routes.rs");
    let implemented = source
        .split(".route(")
        .skip(1)
        .filter_map(|tail| {
            let tail = tail.trim_start();
            let tail = tail.strip_prefix('"')?;
            let (path, _) = tail.split_once('"')?;
            path.starts_with("/v1/").then(|| path.to_owned())
        })
        .collect::<BTreeSet<_>>();

    assert_eq!(documented, implemented);
    assert_eq!(documented.len(), restork_api::API_ROUTES.len());
    assert!(restork_api::API_ROUTES.iter().all(|route| {
        !route.methods.is_empty()
            && route
                .methods
                .iter()
                .all(|method| matches!(*method, "GET" | "POST" | "PUT" | "PATCH" | "DELETE"))
    }));
}

#[tokio::test]
async fn durable_agent_runs_are_created_idempotently_and_listed() {
    let (app, authorization, _directory) = paired_app().await;
    let request = json!({
        "goal": "Summarise the frozen evidence.",
        "mode": "research",
        "provider_profile_id": "deepseek",
        "reasoning_effort": "max",
        "auto_start": false
    });
    let (status, created) = call_idempotent(
        app.clone(),
        Method::POST,
        "/v1/runs",
        request.clone(),
        &authorization,
        "run-create-fixture",
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let created = created.expect("created run");
    assert_eq!(created["replayed"], false);
    assert_eq!(created["started"], false);
    assert_eq!(created["run"]["task_spec"]["data_class"], "public");
    assert_eq!(created["run"]["task_spec"]["reasoning_effort"], "max");
    let run_id = created["run"]["run_id"]
        .as_str()
        .expect("run id")
        .to_owned();

    let (status, replayed) = call_idempotent(
        app.clone(),
        Method::POST,
        "/v1/runs",
        request,
        &authorization,
        "run-create-fixture",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replayed.expect("replay")["replayed"], true);

    let (status, runs) = call(
        app.clone(),
        Method::GET,
        "/v1/runs?limit=12",
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(runs.expect("runs")["runs"][0]["summary"]["run_id"], run_id);

    let (status, run) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/runs/{run_id}"),
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(run.expect("run")["state"], "proposed");

    let (status, invalid) = call_idempotent(
        app,
        Method::POST,
        "/v1/runs",
        json!({
            "goal": "Reject an unsupported per-run reasoning level.",
            "mode": "research",
            "provider_profile_id": "deepseek",
            "reasoning_effort": "low",
            "auto_start": false
        }),
        &authorization,
        "run-create-invalid-reasoning",
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{invalid:?}");
}

#[tokio::test]
async fn proposed_agent_run_can_be_cancelled_before_it_starts() {
    let (app, authorization, _directory) = paired_app().await;
    let request = json!({
        "goal": "Prepare a Study intake that will be abandoned before launch.",
        "mode": "study",
        "provider_profile_id": "deepseek",
        "auto_start": false
    });
    let (status, created) = call_idempotent(
        app.clone(),
        Method::POST,
        "/v1/runs",
        request,
        &authorization,
        "run-cancel-before-start-create",
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let run_id = created.expect("created run")["run"]["run_id"]
        .as_str()
        .expect("run id")
        .to_owned();

    // A proposed run has no live cancellation channel; it is cancelled
    // directly so failed preparation cannot leave a zombie run behind.
    let (status, cancelled) = call_idempotent(
        app.clone(),
        Method::POST,
        &format!("/v1/runs/{run_id}/cancel"),
        json!({}),
        &authorization,
        "run-cancel-before-start",
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(cancelled.expect("cancelled")["state"], "cancelled");

    let (status, run) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/runs/{run_id}"),
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let run = run.expect("run");
    assert_eq!(run["state"], "cancelled");
    assert_eq!(run["stop_reason"], "cancelled_before_start");

    // A terminal run must not be rewritten by a repeated cancellation.
    let (status, _) = call_idempotent(
        app,
        Method::POST,
        &format!("/v1/runs/{run_id}/cancel"),
        json!({}),
        &authorization,
        "run-cancel-before-start-retry",
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

fn reviewed_skill_manifest() -> Value {
    json!({
        "schema_version": 1,
        "id": "ppt-master",
        "version": "1.0.0",
        "provenance": {
            "source": {"kind": "catalog", "catalog_id": "restork-reviewed", "version": "1.0.0"},
            "license": "MIT",
            "content_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "signature": null
        },
        "compatibility": {"minimum_core_version": "0.1.0", "maximum_core_version": null},
        "enabled_profiles": ["safe-mode"],
        "procedure": "skills/ppt.md",
        "prompt_references": [],
        "schema_references": [],
        "template_references": [],
        "requested_permissions": [],
        "display_name": "ppt-master",
        "instructions": "Write slides from the brief."
    })
}

#[tokio::test]
async fn run_skill_ids_are_validated_and_frozen_into_the_manifest() {
    let (app, authorization, _directory) = paired_app().await;
    let (status, preview) = call(
        app.clone(),
        Method::POST,
        "/v1/extensions",
        Some(json!({"package_kind": "skill", "manifest": reviewed_skill_manifest()})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let digest = preview.expect("preview")["preview_digest"]
        .as_str()
        .expect("digest")
        .to_owned();
    let (status, installed) = call(
        app.clone(),
        Method::POST,
        "/v1/extensions",
        Some(json!({
            "package_kind": "skill",
            "manifest": reviewed_skill_manifest(),
            "approved_preview_digest": digest
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let installed = installed.expect("installed");
    assert!(installed["manifest"].get("instructions").is_none());
    assert!(
        !installed
            .to_string()
            .contains("Write slides from the brief.")
    );
    let hash = installed["manifest_hash"]
        .as_str()
        .expect("hash")
        .to_owned();
    let (status, disabled) = call_idempotent(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "goal": "Disabled skills must not bind.",
            "mode": "research",
            "provider_profile_id": "deepseek",
            "auto_start": false,
            "skill_ids": ["ppt-master"]
        }),
        &authorization,
        "run-disabled-skill",
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{disabled:?}");
    let (status, _) = call(
        app.clone(),
        Method::PATCH,
        "/v1/extensions/ppt-master",
        Some(json!({"action": "enable", "expected_hash": hash})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, bootstrap) = call(
        app.clone(),
        Method::GET,
        "/v1/bootstrap?timezone=UTC",
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        !bootstrap.expect("bootstrap")["workspaceV2"]["extensions"]
            .to_string()
            .contains("Write slides from the brief.")
    );

    let (status, created) = call_idempotent(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "goal": "Make a six-slide research update.",
            "mode": "research",
            "provider_profile_id": "deepseek",
            "auto_start": false,
            "skill_ids": ["ppt-master"]
        }),
        &authorization,
        "run-with-skill",
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created:?}");
    let created = created.expect("run");
    assert_eq!(
        created["run"]["task_spec"]["skills"][0]["skill_id"],
        "ppt-master"
    );
    assert_eq!(
        created["run"]["task_spec"]["skills"][0]["manifest_hash"],
        hash
    );
    assert!(
        created["run"]["task_spec"]["skills"][0]
            .get("instructions")
            .is_none()
    );

    let (status, unknown) = call_idempotent(
        app.clone(),
        Method::POST,
        "/v1/runs",
        json!({
            "goal": "Unknown skill should fail.",
            "mode": "research",
            "provider_profile_id": "deepseek",
            "auto_start": false,
            "skill_ids": ["missing-skill"]
        }),
        &authorization,
        "run-unknown-skill",
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{unknown:?}");

    let (status, extra) = call_idempotent(
        app,
        Method::POST,
        "/v1/runs",
        json!({
            "goal": "Unknown fields still fail.",
            "mode": "research",
            "provider_profile_id": "deepseek",
            "auto_start": false,
            "unexpected": true
        }),
        &authorization,
        "run-unknown-field",
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{extra:?}");
}
