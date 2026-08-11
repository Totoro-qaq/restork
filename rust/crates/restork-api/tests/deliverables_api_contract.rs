use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use restork_automation::{
    MissedRunPolicy, Recurrence, ScheduleJob, ScheduleSpec, ScheduledReportKind,
};
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
            "theme_id": "restork-ocean",
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
    assert_eq!(deck["artifact"]["theme"]["theme_id"], "restork-ocean");
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

#[tokio::test]
async fn model_presentation_accepts_a_user_brief_theme_and_slide_count_without_a_report() {
    let (app, authorization, _directory, _database) = paired_app_with_database().await;
    let model_draft = json!({
        "slides": [
            {"role":"agenda","action_title":"今天要讲清楚什么","fact_refs":["fact:brief"],"speaker_notes":["先交代这份演示的目标。"]},
            {"role":"evidence","action_title":"把研究结论变成下一步行动","fact_refs":["fact:brief"],"speaker_notes":["说明用户提供的研究目标。"]},
            {"role":"comparison","action_title":"选择方案时看什么","fact_refs":["fact:brief"],"speaker_notes":["围绕目标比较可选路径。"]},
            {"role":"timeline","action_title":"接下来怎么推进","fact_refs":["fact:brief"],"speaker_notes":["给出可以执行的顺序。"]},
            {"role":"conclusion","action_title":"需要团队确认的事项","fact_refs":["fact:brief"],"speaker_notes":["以明确的决定收尾。"]}
        ]
    }).to_string();
    let base_url = spawn_mock_ollama(&model_draft).await;
    configure_ollama_profile(&app, &authorization, &base_url).await;

    let (status, body) = call(
        app,
        Method::POST,
        "/v1/deliverables/decks/draft",
        Some(json!({
            "deck_id": "deck:brief",
            "revision": 1,
            "title": "研究结论与下一步",
            "report": null,
            "brief": "把今天的研究结论整理成一份可以直接向团队讲解的演示稿。",
            "slide_count": 6,
            "theme_id": "restork-midnight",
            "provider_profile_id": "ollama",
            "language": "zh-CN",
            "audience": {
                "audience_id": "team",
                "purpose": "同步研究结论并确定下一步",
                "expertise": "混合"
            }
        })),
        Some(&authorization),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED, "body: {body:?}");
    let record = body.expect("deck record");
    assert_eq!(record["state"], "outline_review");
    assert_eq!(record["artifact"]["theme"]["theme_id"], "restork-midnight");
    let slides = record["artifact"]["slides"].as_array().expect("slides");
    assert_eq!(slides.len(), 6, "title plus five model slides");
    assert_eq!(slides[2]["action_title"], "把研究结论变成下一步行动");
    assert_eq!(
        record["artifact"]["claims"]["claim:model:0"]["verification"],
        "self_asserted"
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

async fn spawn_delayed_counting_ollama(content: &str) -> (String, Arc<AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("address").port();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&calls);
    let payload = json!({
        "message": {"role": "assistant", "content": content},
        "done": true,
        "done_reason": "stop",
        "prompt_eval_count": 42,
        "eval_count": 24
    })
    .to_string();
    tokio::spawn(async move {
        for _ in 0..2 {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            observed.fetch_add(1, Ordering::SeqCst);
            let payload = payload.clone();
            tokio::spawn(async move {
                let mut chunk = [0_u8; 8_192];
                let mut request = Vec::new();
                loop {
                    let read = socket.read(&mut chunk).await.expect("read");
                    if read == 0 {
                        return;
                    }
                    request.extend_from_slice(&chunk[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n")
                        || request.len() > 64 * 1024
                    {
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    payload.len(),
                    payload
                );
                socket.write_all(response.as_bytes()).await.expect("write");
            });
        }
    });
    (format!("http://127.0.0.1:{port}"), calls)
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
    seed_run_with_class(database, run_id, state, title, "public");
}

fn seed_run_with_class(
    database: &Database,
    run_id: &str,
    state: &str,
    title: Option<&str>,
    data_class: &str,
) {
    let occurred_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("timestamp");
    let task_spec = match title {
        Some(title) => json!({"goal": title, "data_class": data_class}),
        None => json!({"data_class": data_class}),
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
async fn scheduled_model_work_creates_only_an_idempotent_local_draft() {
    let (app, authorization, _directory, database) = paired_app_with_database().await;
    seed_run(
        &database,
        "run-scheduled",
        "succeeded",
        Some("完成自动化回归"),
    );
    let base_url = spawn_mock_ollama(
        "{\"entries\":[{\"section\":\"completed\",\"text\":\"自动化回归已完成\",\"fact_refs\":[\"fact:run:run-scheduled\"]}]}",
    )
    .await;
    configure_ollama_profile(&app, &authorization, &base_url).await;
    let schedule = ScheduleSpec::new(
        "schedule-model-report",
        "Asia/Shanghai",
        Recurrence::Daily { hour: 9, minute: 0 },
        MissedRunPolicy::CreateDraft,
        ScheduleJob::ModelDraft {
            provider_profile_id: "ollama".to_owned(),
            report_kind: ScheduledReportKind::DailyReport,
            title: "AI 日报".to_owned(),
            language: "zh-CN".to_owned(),
            focus: "只总结有运行证据的完成事项".to_owned(),
            network_access_confirmed: true,
        },
    )
    .expect("schedule");
    let occurrence_key = "scheduled:fixture";

    let first =
        restork_api::execute_scheduled_model_draft(&database, &schedule, occurrence_key, false)
            .await;
    assert_eq!(first["state"], "draft_created");
    assert_eq!(first["provider_call"], true);
    assert_eq!(first["network_effect"], true);
    let deliverable_id = first["deliverable_id"].as_str().expect("deliverable id");
    let deliverable = database
        .deliverable(deliverable_id, 1)
        .expect("lookup")
        .expect("draft");
    assert_eq!(deliverable.state, "draft");

    let replay =
        restork_api::execute_scheduled_model_draft(&database, &schedule, occurrence_key, false)
            .await;
    assert_eq!(replay["state"], "draft_created");
    assert_eq!(replay["replayed"], true);
}

#[tokio::test]
async fn concurrent_manual_model_runs_claim_before_the_paid_provider_call() {
    let (app, authorization, _directory, database) = paired_app_with_database().await;
    seed_run(
        &database,
        "run-concurrent-source",
        "succeeded",
        Some("完成并发自动化回归"),
    );
    let (base_url, calls) = spawn_delayed_counting_ollama(
        "{\"entries\":[{\"section\":\"completed\",\"text\":\"并发自动化回归已完成\",\"fact_refs\":[\"fact:run:run-concurrent-source\"]}]}",
    )
    .await;
    configure_ollama_profile(&app, &authorization, &base_url).await;
    let (status, body) = call(
        app.clone(),
        Method::POST,
        "/v1/schedules",
        Some(json!({
            "schedule_id": "schedule-concurrent-model",
            "name": "并发模型日报",
            "timezone": "Asia/Shanghai",
            "recurrence": {"kind": "daily", "hour": 9, "minute": 0},
            "missed_run_policy": "create_draft",
            "job": {
                "kind": "model_draft",
                "provider_profile_id": "ollama",
                "report_kind": "daily_report",
                "title": "AI 日报",
                "language": "zh-CN",
                "focus": "只总结有运行证据的完成事项",
                "network_access_confirmed": true
            }
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "schedule: {body:?}");

    let first = call_raw(
        app.clone(),
        Method::POST,
        "/v1/schedules/schedule-concurrent-model/run",
        json!({}),
        &authorization,
        "same-paid-occurrence",
    );
    let second = call_raw(
        app,
        Method::POST,
        "/v1/schedules/schedule-concurrent-model/run",
        json!({}),
        &authorization,
        "same-paid-occurrence",
    );
    let ((first_status, _, first_body), (second_status, _, second_body)) =
        tokio::join!(first, second);
    assert_eq!(first_status, StatusCode::OK);
    assert_eq!(second_status, StatusCode::OK);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let results = [first_body, second_body]
        .map(|body| serde_json::from_slice::<Value>(&body).expect("run JSON"));
    assert!(
        results
            .iter()
            .any(|result| result["result"]["state"] == "draft_created")
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

#[tokio::test]
async fn ai_drafted_report_never_sends_non_public_run_facts() {
    let (app, authorization, _directory, database) = paired_app_with_database().await;
    seed_run_with_class(
        &database,
        "run-confidential",
        "succeeded",
        Some("客户代号与私密交付"),
        "confidential",
    );
    let base_url = spawn_mock_ollama("{\"entries\":[]}").await;
    configure_ollama_profile(&app, &authorization, &base_url).await;

    let (status, body) = call(
        app.clone(),
        Method::POST,
        "/v1/deliverables/reports/ai-draft",
        Some(json!({
            "report_id": "report:ai-private",
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
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        body.expect("error")["detail"]
            .as_str()
            .expect("detail")
            .contains("marked public")
    );
}
