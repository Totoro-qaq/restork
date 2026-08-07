use std::{fs, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use restork_core::auth::PairingAuthority;
use restork_storage::{Database, NewRun};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let mut suffix = [0_u8; 12];
        getrandom::fill(&mut suffix).expect("entropy");
        let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "restork-api-deliverables-{}",
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

async fn call_raw(
    app: Router,
    method: Method,
    path: &str,
    body: Value,
    authorization: &str,
    idempotency_key: &str,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
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
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes()
        .to_vec();
    (status, headers, bytes)
}

async fn paired_app() -> (Router, String, TestDirectory) {
    let (app, token, directory, _) = paired_app_with_database().await;
    (app, token, directory)
}

async fn paired_app_with_database() -> (Router, String, TestDirectory, Arc<Database>) {
    let directory = TestDirectory::new();
    let database = Arc::new(Database::open(directory.0.join("restork.db")).expect("database"));
    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let code = authority.initial_pairing_code();
    let app = restork_api::router_with_storage(authority, database.clone());
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
    (app, format!("Bearer {token}"), directory, database)
}

fn ledger(source_kind: &str, verification: &str) -> Value {
    json!({
        "period": {
            "start": "2026-08-01T00:00:00Z",
            "end_exclusive": "2026-08-02T00:00:00Z",
            "timezone": "Asia/Shanghai"
        },
        "sources": [{
            "source_id": "source:1",
            "kind": source_kind,
            "locator": "synthetic/1",
            "content_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "observed_at": "2026-08-01T12:00:00Z",
            "verification": verification
        }],
        "facts": [{
            "fact_id": "fact:1",
            "kind": "completion",
            "statement": "The synthetic contract test passed.",
            "source_refs": ["source:1"]
        }]
    })
}

#[tokio::test]
async fn report_composition_requires_grounded_evidence_and_keeps_markdown_draft_history() {
    let (app, authorization, _directory) = paired_app().await;
    let invalid = json!({
        "report_id": "report:invalid",
        "revision": 1,
        "kind": "daily",
        "title": "Invalid",
        "language": "en-US",
        "ledger": ledger("conversation", "unverified"),
        "entries": [{
            "entry_id": "entry:1",
            "section": "completed",
            "text": "Unsupported completion.",
            "fact_refs": ["fact:1"]
        }]
    });
    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/deliverables/reports",
        Some(invalid),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let valid = json!({
        "report_id": "report:daily",
        "revision": 1,
        "kind": "daily",
        "title": "Daily report",
        "language": "en-US",
        "ledger": ledger("run_event", "verified"),
        "entries": [{
            "entry_id": "entry:1",
            "section": "completed",
            "text": "The synthetic contract test passed.",
            "fact_refs": ["fact:1"]
        }]
    });
    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/deliverables/reports",
        Some(valid),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let created = created.expect("report");
    assert_eq!(created["state"], "draft");
    assert!(
        created["artifact"]["markdown"]
            .as_str()
            .expect("markdown")
            .contains("[^fact:1]")
    );

    let (status, history) = call(
        app,
        Method::GET,
        "/v1/deliverables?limit=20",
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
        1
    );
}

#[tokio::test]
async fn deck_composition_rejects_traversal_and_freezes_an_outline_for_review() {
    let (app, authorization, _directory) = paired_app().await;
    let base = |local_ref: &str| {
        json!({
            "deck_id": "deck:weekly",
            "revision": 1,
            "language": "en-US",
            "audience": {"audience_id": "team", "purpose": "Review", "expertise": "Engineering"},
            "theme": {
                "theme_id": "restork-print",
                "version": 1,
                "content_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            },
            "ledger": ledger("validated_artifact", "verified"),
            "assets": [{
                "asset_id": "asset:1",
                "content_hash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                "media_type": "image/png",
                "local_ref": local_ref
            }],
            "claims": [{
                "claim_id": "claim:1",
                "text": "The synthetic contract test passed.",
                "fact_refs": ["fact:1"]
            }],
            "slides": [{
                "slide_id": "slide:1",
                "role": "evidence",
                "action_title": "The contract is verified",
                "claim_refs": ["claim:1"],
                "speaker_notes": [],
                "visuals": [{"kind": "image", "alt_text": "Synthetic evidence", "asset_ref": "asset:1"}]
            }]
        })
    };
    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/deliverables/decks",
        Some(base("../private.png")),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (status, created) = call(
        app,
        Method::POST,
        "/v1/deliverables/decks",
        Some(base("assets/synthetic.png")),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let created = created.expect("deck");
    assert_eq!(created["state"], "outline_review");
    assert_eq!(
        created["artifact"]["outline_digest"]
            .as_str()
            .expect("digest")
            .len(),
        64
    );
}

#[tokio::test]
async fn dashboard_report_marks_manual_claims_and_can_freeze_a_deck_outline_from_the_report() {
    let (app, authorization, _directory) = paired_app().await;
    let (status, report) = call(
        app.clone(),
        Method::POST,
        "/v1/deliverables/reports/manual",
        Some(json!({
            "report_id": "report:manual",
            "revision": 1,
            "kind": "daily",
            "title": "Daily reflection",
            "language": "en-US",
            "timezone": "Asia/Shanghai",
            "entries": [{
                "section": "completed",
                "text": "I completed the local synthetic review."
            }]
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let report = report.expect("report");
    assert_eq!(
        report["artifact"]["entries"][0]["verification"],
        "self_asserted"
    );
    assert!(
        report["artifact"]["markdown"]
            .as_str()
            .expect("markdown")
            .contains("self-asserted")
    );

    let (status, deck) = call(
        app.clone(),
        Method::POST,
        "/v1/deliverables/decks/from-report",
        Some(json!({
            "deck_id": "deck:manual",
            "revision": 1,
            "report_id": "report:manual",
            "report_revision": 1,
            "language": "en-US",
            "audience": {
                "audience_id": "team",
                "purpose": "Daily review",
                "expertise": "Engineering"
            }
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let deck = deck.expect("deck");
    assert_eq!(deck["state"], "outline_review");
    assert_eq!(
        deck["artifact"]["slides"].as_array().expect("slides").len(),
        2
    );
    assert_eq!(
        deck["artifact"]["slides"][1]["citation_refs"][0],
        "source:validated-report"
    );

    let (status, preview) = call(
        app.clone(),
        Method::POST,
        "/v1/deliverables/deck:manual/1/render-preview",
        Some(json!({"format": "pptx"})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let preview = preview.expect("render preview");
    assert_eq!(preview["state"], "review_required");
    assert_eq!(preview["manifest"]["macro_free"], true);
    let artifact_hash = preview["manifest"]["artifact_hash"]
        .as_str()
        .expect("artifact hash");
    let (status, headers, bytes) = call_raw(
        app.clone(),
        Method::POST,
        "/v1/deliverables/deck:manual/1/render",
        json!({"format": "pptx", "expected_artifact_hash": artifact_hash}),
        &authorization,
        "render-deck-manual-pptx",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(bytes.starts_with(b"PK\x03\x04"));
    assert_eq!(
        headers
            .get("x-restork-artifact-sha256")
            .and_then(|value| value.to_str().ok()),
        Some(artifact_hash)
    );
    assert_eq!(
        headers
            .get("x-restork-idempotent-replay")
            .and_then(|value| value.to_str().ok()),
        Some("false")
    );
    let (status, replay_headers, replay_bytes) = call_raw(
        app,
        Method::POST,
        "/v1/deliverables/deck:manual/1/render",
        json!({"format": "pptx", "expected_artifact_hash": artifact_hash}),
        &authorization,
        "render-deck-manual-pptx",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay_bytes, bytes);
    assert_eq!(
        replay_headers
            .get("x-restork-idempotent-replay")
            .and_then(|value| value.to_str().ok()),
        Some("true")
    );
}

async fn spawn_mock_ollama(content: &str) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("address").port();
    let payload = json!({
        "message": {"role": "assistant", "content": content},
        "done": true,
        "done_reason": "stop",
        "prompt_eval_count": 42,
        "eval_count": 24
    })
    .to_string();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut chunk = [0_u8; 8_192];
        let mut request = Vec::new();
        loop {
            let read = socket.read(&mut chunk).await.expect("read");
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") || request.len() > 64 * 1024 {
                break;
            }
        }
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            payload.len(),
            payload
        );
        socket.write_all(response.as_bytes()).await.expect("write");
    });
    format!("http://127.0.0.1:{port}")
}

async fn configure_ollama_profile(app: &Router, authorization: &str, base_url: &str) {
    let (status, body) = call(
        app.clone(),
        Method::PUT,
        "/v1/provider-profiles/ollama",
        Some(json!({
            "provider": {
                "profile_id": "ollama",
                "version": 1,
                "display_name": "Mock Ollama",
                "kind": "ollama",
                "base_url": base_url,
                "model": "mock-model",
                "secret_ref": null,
                "fallback": "disabled",
                "reasoning": {"effort": "auto", "max_tokens": null}
            },
            "expected_revision": null
        })),
        Some(authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "profile stored: {body:?}");
}

fn seed_run(database: &Database, run_id: &str, state: &str, title: Option<&str>) {
    let occurred_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("timestamp");
    let task_spec = match title {
        Some(title) => json!({"goal": title}),
        None => json!({}),
    };
    database
        .create_run(NewRun {
            run_id,
            task_id: &format!("task-{run_id}"),
            task_spec: &task_spec,
            mode: "study",
            state,
            occurred_at: &occurred_at,
        })
        .expect("run");
}

#[tokio::test]
async fn ai_drafted_report_freezes_model_entries_with_run_evidence() {
    let (app, authorization, _directory, database) = paired_app_with_database().await;
    seed_run(&database, "run-1", "succeeded", Some("整理学习笔记"));
    seed_run(&database, "run-2", "failed", None);
    let base_url = spawn_mock_ollama(
        "{\"entries\":[{\"section\":\"summary\",\"text\":\"本周完成一次学习整理\",\"fact_refs\":[\"fact:run:run-1\"]},{\"section\":\"blockers\",\"text\":\"一个运行失败\",\"fact_refs\":[\"fact:run:run-2\"]}]}",
    )
    .await;
    configure_ollama_profile(&app, &authorization, &base_url).await;

    let (status, body) = call(
        app.clone(),
        Method::POST,
        "/v1/deliverables/reports/ai-draft",
        Some(json!({
            "report_id": "report:ai",
            "revision": 1,
            "kind": "daily",
            "title": "AI 日报",
            "language": "zh-CN",
            "timezone": "Asia/Shanghai",
            "provider_profile_id": "ollama"
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body:?}");
    let artifact = &body.expect("record")["artifact"];
    let entries = artifact["entries"].as_array().expect("entries");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["section"], "summary");
    assert_eq!(entries[0]["fact_refs"], json!(["fact:run:run-1"]));
    let markdown = artifact["markdown"].as_str().expect("markdown");
    assert!(markdown.contains("本周完成一次学习整理"));
    assert!(markdown.contains("一个运行失败"));
    assert!(
        entries
            .iter()
            .all(|entry| entry["verification"] == "verified")
    );
}

#[tokio::test]
async fn ai_drafted_report_rejects_invalid_model_json() {
    let (app, authorization, _directory, database) = paired_app_with_database().await;
    seed_run(&database, "run-1", "succeeded", None);
    let base_url = spawn_mock_ollama("这不是 JSON").await;
    configure_ollama_profile(&app, &authorization, &base_url).await;

    let (status, body) = call(
        app.clone(),
        Method::POST,
        "/v1/deliverables/reports/ai-draft",
        Some(json!({
            "report_id": "report:ai-bad",
            "revision": 1,
            "kind": "daily",
            "title": "AI 日报",
            "language": "zh-CN",
            "timezone": "Asia/Shanghai",
            "provider_profile_id": "ollama"
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(
        body.expect("error")["detail"]
            .as_str()
            .expect("detail")
            .contains("not valid report JSON")
    );
}

#[tokio::test]
async fn ai_drafted_report_rejects_unknown_fact_references() {
    let (app, authorization, _directory, database) = paired_app_with_database().await;
    seed_run(&database, "run-1", "succeeded", None);
    let base_url = spawn_mock_ollama(
        "{\"entries\":[{\"section\":\"summary\",\"text\":\"编造的事实\",\"fact_refs\":[\"fact:run:ghost\"]}]}",
    )
    .await;
    configure_ollama_profile(&app, &authorization, &base_url).await;

    let (status, body) = call(
        app.clone(),
        Method::POST,
        "/v1/deliverables/reports/ai-draft",
        Some(json!({
            "report_id": "report:ai-ghost",
            "revision": 1,
            "kind": "daily",
            "title": "AI 日报",
            "language": "zh-CN",
            "timezone": "Asia/Shanghai",
            "provider_profile_id": "ollama"
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(
        body.expect("error")["detail"]
            .as_str()
            .expect("detail")
            .contains("unknown facts")
    );
}

#[tokio::test]
async fn ai_drafted_report_requires_recent_activity() {
    let (app, authorization, _directory, _database) = paired_app_with_database().await;
    let base_url = spawn_mock_ollama("{\"entries\":[]}").await;
    configure_ollama_profile(&app, &authorization, &base_url).await;

    let (status, body) = call(
        app.clone(),
        Method::POST,
        "/v1/deliverables/reports/ai-draft",
        Some(json!({
            "report_id": "report:ai-empty",
            "revision": 1,
            "kind": "weekly",
            "title": "AI 周报",
            "language": "zh-CN",
            "timezone": "Asia/Shanghai",
            "provider_profile_id": "ollama"
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        body.expect("error")["detail"]
            .as_str()
            .expect("detail")
            .contains("no recent activity")
    );
}
