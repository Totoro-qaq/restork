use std::{fs, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use restork_core::auth::PairingAuthority;
use restork_storage::{Database, NewMemorySuggestion, NewRun};
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
            .join(format!("restork-run-summary-{suffix}"));
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
    idempotency_key: Option<&str>,
) -> (StatusCode, Option<Value>) {
    let mut request = Request::builder().method(method).uri(path);
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    if let Some(authorization) = authorization {
        request = request.header("authorization", authorization);
    }
    if let Some(idempotency_key) = idempotency_key {
        request = request.header("idempotency-key", idempotency_key);
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
    let parsed = if bytes.is_empty() {
        None
    } else {
        serde_json::from_slice(&bytes).ok()
    };
    (status, parsed)
}

async fn paired_app() -> (Router, String, TestDirectory, Arc<Database>) {
    let directory = TestDirectory::new();
    let database = Arc::new(Database::open(directory.0.join("restork.db")).expect("database"));
    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let code = authority.initial_pairing_code();
    let app = restork_api::router_with_storage(authority, database.clone());
    let (status, body) = call(
        app.clone(),
        Method::POST,
        "/v1/pair",
        Some(json!({"code": code})),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = body.expect("token")["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();
    (app, format!("Bearer {token}"), directory, database)
}

fn seed_suggestion(database: &Database, run_id: &str, mode: &str, summary: &str) {
    database
        .create_run(NewRun {
            run_id,
            task_id: "task-summary",
            task_spec: &json!({"goal": "Compare two papers", "data_class": "personal"}),
            mode,
            state: "completed",
            occurred_at: "2026-08-13T00:00:00Z",
        })
        .expect("create run");
    let hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    database
        .offer_memory_suggestion(NewMemorySuggestion {
            suggestion_id: &format!("run-summary-{run_id}"),
            run_id,
            mode,
            summary,
            data_class: "personal",
            content_hash: hash,
            created_at: "2026-08-13T00:00:00Z",
            expires_at: "2026-08-14T00:00:00Z",
        })
        .expect("offer");
}

#[tokio::test]
async fn run_summary_is_opt_in_episodic_and_never_profile() {
    let (app, authorization, _directory, database) = paired_app().await;
    seed_suggestion(
        &database,
        "run-summary-http",
        "research",
        "The papers disagree on identification.",
    );

    let (status, missing) = call(
        app.clone(),
        Method::GET,
        "/v1/runs/run-missing/summary-suggestion",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(missing.is_none());

    let (status, pending) = call(
        app.clone(),
        Method::GET,
        "/v1/runs/run-summary-http/summary-suggestion",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let pending = pending.expect("pending suggestion");
    assert_eq!(pending["summary"], "The papers disagree on identification.");
    assert_eq!(pending["mode"], "research");

    let (status, bootstrap) = call(
        app.clone(),
        Method::GET,
        "/v1/bootstrap",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        bootstrap.expect("bootstrap")["pendingRunSummaries"][0]["run_id"],
        "run-summary-http"
    );

    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/runs/run-summary-http/summary-suggestion/accept",
        Some(json!({})),
        Some(&authorization),
        Some("run-summary-accept"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let created = created.expect("episodic memory");
    assert_eq!(created["layer"], "episodic");
    assert_eq!(created["kind"], "run_summary");
    assert_eq!(created["provenance"], "user");

    let (status, memory) = call(
        app.clone(),
        Method::GET,
        "/v1/memory?limit=20",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let memory = memory.expect("memory page");
    assert_eq!(memory["counts"]["episodic"], 1);
    assert_eq!(memory["counts"]["profile"], 0);
    assert_eq!(memory["records"][0]["kind"], "run_summary");

    let (status, _) = call(
        app,
        Method::GET,
        "/v1/runs/run-summary-http/summary-suggestion",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn dismissed_run_summary_does_not_create_memory() {
    let (app, authorization, _directory, database) = paired_app().await;
    seed_suggestion(
        &database,
        "run-summary-dismiss",
        "study",
        "Learn the loop · What is a quorum?",
    );

    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/runs/run-summary-dismiss/summary-suggestion/dismiss",
        Some(json!({})),
        Some(&authorization),
        Some("run-summary-dismiss"),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, memory) = call(
        app,
        Method::GET,
        "/v1/memory?limit=20",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(memory.expect("memory page")["counts"]["episodic"], 0);
}
