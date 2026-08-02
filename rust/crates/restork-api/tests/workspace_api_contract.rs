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
        getrandom::fill(&mut suffix).expect("test entropy");
        let suffix = suffix
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = std::env::temp_dir().join(format!("restork-api-workspace-{suffix}"));
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
async fn personal_settings_and_zero_configuration_daily_context_are_available() {
    let (app, authorization, _directory) = paired_app().await;
    let (status, daily) = call(
        app.clone(),
        Method::GET,
        "/v1/daily/context",
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let daily = daily.expect("daily context");
    assert!(daily["local_date"].as_str().is_some());
    assert!(daily["local_time"].as_str().is_some());

    let (status, _) = call(
        app.clone(),
        Method::PUT,
        "/v1/settings/personal",
        Some(json!({
            "expected_version": null,
            "settings": {"display_name": "Synthetic User", "unknown": true}
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (status, stored) = call(
        app.clone(),
        Method::PUT,
        "/v1/settings/personal",
        Some(json!({
            "expected_version": null,
            "settings": {"display_name": "Synthetic User", "locale": "zh-CN", "theme": "light"}
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stored.expect("settings")["version"], 1);

    let (status, loaded) = call(
        app,
        Method::GET,
        "/v1/settings/personal",
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        loaded.expect("settings")["settings"]["display_name"],
        "Synthetic User"
    );
}

#[tokio::test]
async fn global_sessions_are_paginated_searchable_and_create_tool_free_proposals() {
    let (app, authorization, _directory) = paired_app().await;
    let (status, session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        Some(json!({"title": "Research inbox", "profile_id": "safe-mode", "locale": "en"})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let session_id = session.expect("session")["session_id"]
        .as_str()
        .expect("session id")
        .to_owned();

    let (status, message) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/sessions/{session_id}/messages"),
        Some(json!({
            "content": "Investigate durable event replay",
            "context": {},
            "data_class": "public"
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(message.expect("message")["sequence"], 1);

    let (status, page) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/sessions/{session_id}/messages?after=0&limit=20"),
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page.expect("messages")["items"][0]["role"], "user");

    let (status, hits) = call(
        app.clone(),
        Method::GET,
        "/v1/sessions/search?q=durable%20event&limit=10",
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hits.expect("hits")["items"][0]["session_id"], session_id);

    let (status, export) = call(
        app.clone(),
        Method::GET,
        &format!("/v1/sessions/{session_id}/export"),
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let export = export.expect("session export");
    assert_eq!(export["schema_version"], 1);
    assert_eq!(export["secret_values_included"], false);
    assert_eq!(export["messages"].as_array().map(Vec::len), Some(1));
    assert!(
        export["note"]
            .as_str()
            .expect("privacy note")
            .contains("private")
    );

    let (status, proposal) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/sessions/{session_id}/proposals"),
        Some(json!({"mode": "research", "goal": "Verify replay behavior", "data_class": "public"})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let proposal = proposal.expect("proposal");
    assert_eq!(proposal["status"], "review_required");
    assert_eq!(proposal["requested_tools"], json!([]));
    assert_eq!(proposal["sources"], json!([]));
    assert_eq!(
        proposal["intake_boundary"],
        json!({
            "network_access": false,
            "file_access": false,
            "provider_access": false,
            "tool_access": false
        })
    );

    let (status, cloud_session) = call(
        app.clone(),
        Method::POST,
        "/v1/sessions",
        Some(json!({"title": "Direct cloud", "profile_id": "deepseek", "locale": "en"})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let cloud_session_id = cloud_session.expect("cloud session")["session_id"]
        .as_str()
        .expect("cloud session id")
        .to_owned();
    let (status, denial) = call(
        app,
        Method::POST,
        &format!("/v1/sessions/{cloud_session_id}/messages"),
        Some(json!({
            "content": "This must remain local",
            "context": {},
            "data_class": "personal"
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(
        denial.expect("policy denial")["detail"]
            .as_str()
            .expect("message")
            .contains("public-only")
    );
}
