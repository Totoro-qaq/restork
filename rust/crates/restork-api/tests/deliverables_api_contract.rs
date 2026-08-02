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
        let path = std::env::temp_dir().join(format!(
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
        app,
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
}
