use std::{fs, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    body::Body,
    http::{Method, Request, StatusCode, header},
};
use http_body_util::BodyExt;
use restork_core::auth::PairingAuthority;
use restork_storage::{Database, NewEvent, NewRun};
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
        let path = std::env::temp_dir().join(format!("restork-api-sse-{suffix}"));
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
    let body = body.map_or_else(Body::empty, |value| Body::from(value.to_string()));
    let response = app
        .oneshot(request.body(body).expect("request"))
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
async fn storage_backed_sse_replays_snapshot_and_uncovered_events() {
    let directory = TestDirectory::new();
    let database = Arc::new(Database::open(directory.0.join("restork.db")).expect("database"));
    database
        .create_run(NewRun {
            run_id: "run-sse",
            task_id: "task-sse",
            task_spec: &json!({"schema_version": 1}),
            mode: "research",
            state: "completed",
            occurred_at: "2026-08-02T00:00:00Z",
        })
        .expect("run");
    for index in 1..=3 {
        database
            .append_event(NewEvent {
                event_id: &format!("event-{index}"),
                run_id: "run-sse",
                occurred_at: "2026-08-02T00:00:00Z",
                kind: "run.progress",
                metadata: &json!({"index": index}),
            })
            .expect("event");
    }
    database
        .save_snapshot("run-sse", 2, &json!({"phase": "running"}))
        .expect("snapshot");

    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let code = authority.initial_pairing_code();
    let app = restork_api::router_with_storage(authority, Arc::clone(&database));
    let (status, _, body) = call(
        app.clone(),
        Method::POST,
        "/v1/pair",
        Some(json!({"code": code})),
        &[("content-type", "application/json")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = serde_json::from_slice::<Value>(&body).expect("token payload")["access_token"]
        .as_str()
        .expect("token")
        .to_owned();
    let authorization = format!("Bearer {token}");

    let (status, headers, body) = call(
        app.clone(),
        Method::GET,
        "/v1/runs/run-sse/events",
        None,
        &[("authorization", &authorization), ("last-event-id", "1")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(header::CONTENT_TYPE).expect("content type"),
        "text/event-stream; charset=utf-8"
    );
    assert_eq!(
        String::from_utf8(body).expect("SSE"),
        "id: 2\nevent: run.snapshot\ndata: {\"phase\":\"running\"}\n\n\
         id: 3\nevent: run.progress\ndata: {\"index\":3}\n\n"
    );

    let (status, _, body) = call(
        app,
        Method::GET,
        "/v1/runs/run-sse/events?follow=true",
        None,
        &[("authorization", &authorization), ("last-event-id", "2")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        String::from_utf8(body).expect("follow SSE"),
        "id: 3\nevent: run.progress\ndata: {\"index\":3}\n\n"
    );
}
