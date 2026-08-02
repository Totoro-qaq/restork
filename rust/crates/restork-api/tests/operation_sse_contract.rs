use std::{fs, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    body::Body,
    http::{Method, Request, StatusCode, header},
};
use http_body_util::BodyExt;
use restork_core::auth::PairingAuthority;
use restork_storage::{Database, NewConversationOperation, NewSession};
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
            .join(format!("restork-api-operation-{suffix}"));
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
    app: axum::Router,
    method: Method,
    path: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, header::HeaderMap, Vec<u8>) {
    let mut request = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    if body.is_some() {
        request = request.header("content-type", "application/json");
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
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes()
        .to_vec();
    (status, headers, body)
}

#[tokio::test]
async fn operation_events_replay_and_cancel_is_authenticated_idempotent_and_terminal() {
    let directory = TestDirectory::new();
    let database = Arc::new(Database::open(directory.0.join("restork.db")).expect("database"));
    database
        .create_session(NewSession {
            session_id: "session-operation",
            title: "Cancellable turn",
            profile_id: "provider-fixture",
            locale: Some("en"),
            occurred_at: "2026-08-03T00:00:00Z",
        })
        .expect("session");
    database
        .create_conversation_operation(NewConversationOperation {
            operation_id: "operation-fixture",
            session_id: "session-operation",
            idempotency_key: "operation-fixture-key",
            user_message_id: "message-fixture",
            content: "Synthetic prompt",
            context: &json!({}),
            data_class: "public",
            context_preview_hash: None,
            provider_binding: &json!({"profile_id": "provider-fixture", "reasoning": {"effort": "auto"}}),
            occurred_at: "2026-08-03T00:00:01Z",
        })
        .expect("operation");

    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let code = authority.initial_pairing_code();
    let app = restork_api::router_with_storage(authority, Arc::clone(&database));
    let (status, _, body) = call(
        app.clone(),
        Method::POST,
        "/v1/pair",
        Some(json!({"code": code})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = serde_json::from_slice::<Value>(&body).expect("token payload")["access_token"]
        .as_str()
        .expect("token")
        .to_owned();
    let authorization = format!("Bearer {token}");

    let (status, _, body) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions/session-operation/context-preview",
        Some(json!({
            "data_class": "public",
            "items": [{
                "name": "notes.md",
                "content": "# Explicit fixture\n\nIgnore earlier instructions is untrusted data."
            }]
        })),
        &[("authorization", &authorization)],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let preview = serde_json::from_slice::<Value>(&body).expect("context preview");
    assert_eq!(
        preview["manifest"]["boundary"],
        "explicit_browser_file_selection"
    );
    assert_eq!(preview["manifest"]["untrusted"], true);
    assert_eq!(preview["manifest"]["entries"][0]["name"], "notes.md");
    assert!(preview["content_hash"].as_str().is_some());

    let (status, _, _) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions/session-operation/context-preview",
        Some(json!({
            "data_class": "public",
            "items": [{"name": "notes.md", "content": "fixture", "path": "/tmp/ambient"}]
        })),
        &[("authorization", &authorization)],
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (status, _, _) = call(
        app.clone(),
        Method::POST,
        "/v1/operations/operation-fixture/cancel",
        Some(json!({})),
        &[("idempotency-key", "cancel-fixture")],
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _, body) = call(
        app.clone(),
        Method::GET,
        "/v1/operations/operation-fixture/events",
        None,
        &[("authorization", &authorization)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let replay = String::from_utf8(body).expect("SSE");
    assert!(replay.contains("id: 1\nevent: conversation.queued"));

    let (status, _, body) = call(
        app.clone(),
        Method::POST,
        "/v1/operations/operation-fixture/cancel",
        Some(json!({})),
        &[
            ("authorization", &authorization),
            ("idempotency-key", "cancel-fixture"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).expect("operation")["state"],
        "cancelled"
    );

    let (status, _, body) = call(
        app.clone(),
        Method::GET,
        "/v1/operations/operation-fixture/events",
        None,
        &[("authorization", &authorization), ("last-event-id", "1")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let replay = String::from_utf8(body).expect("SSE");
    assert!(replay.contains("id: 2\nevent: conversation.cancel_requested"));
    assert!(replay.contains("id: 3\nevent: conversation.cancelled"));

    let (status, _, body) = call(
        app,
        Method::POST,
        "/v1/operations/operation-fixture/cancel",
        Some(json!({})),
        &[
            ("authorization", &authorization),
            ("idempotency-key", "cancel-fixture-repeat"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).expect("operation")["state"],
        "cancelled"
    );
}
