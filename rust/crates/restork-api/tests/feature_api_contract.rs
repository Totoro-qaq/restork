use std::{fs, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode},
};
use futures_util::StreamExt;
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
        let path =
            PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("restork-features-{suffix}"));
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
    let body = (!bytes.is_empty()).then(|| serde_json::from_slice(&bytes).expect("JSON response"));
    (status, body)
}

async fn paired_app() -> (Router, String, TestDirectory, PathBuf) {
    let directory = TestDirectory::new();
    let vault = directory.0.join("vault");
    fs::create_dir(&vault).expect("Vault fixture");
    let database = Arc::new(Database::open(directory.0.join("restork.db")).expect("database"));
    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let code = authority.initial_pairing_code();
    let app = restork_api::router_with_runtime(authority, database, Some(vault.clone()));
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
    (app, format!("Bearer {token}"), directory, vault)
}

#[tokio::test]
async fn radar_configuration_uses_public_github_discovery_without_an_account() {
    let (app, authorization, _directory, _vault) = paired_app().await;
    let (status, body) = call(
        app,
        Method::PUT,
        "/v1/radar/config",
        Some(json!({
            "enabled": true,
            "github_discovery": true,
            "hacker_news": false
        })),
        Some(&authorization),
        Some("radar-public-discovery"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let body = body.expect("Radar configuration");
    assert_eq!(body["github_discovery"], true);
    assert!(body.get("github_user").is_none());
}

#[tokio::test]
async fn local_todos_are_editable_paginated_soft_deleted_and_restorable() {
    let (app, authorization, _directory, _vault) = paired_app().await;
    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/tasks/local",
        Some(json!({
            "title": "Review the experiment",
            "details": "Check the two failed cases.",
            "priority": "P1",
            "due_at": "2026-08-10T00:00:00Z",
            "origin": "user"
        })),
        Some(&authorization),
        Some("todo-contract-create"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let created = created.expect("created Todo");
    let task_id = created["task_id"].as_str().expect("task id").to_owned();
    let created_at = created["updated_at"]
        .as_str()
        .expect("created revision")
        .to_owned();

    let (status, updated) = call(
        app.clone(),
        Method::PATCH,
        &format!("/v1/tasks/local/{task_id}"),
        Some(json!({
            "title": "Review the experiment results",
            "details": "Check the two failed cases.",
            "priority": "P0",
            "due_at": "2026-08-10T00:00:00Z",
            "completed": true,
            "expected_updated_at": created_at
        })),
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let updated = updated.expect("updated Todo");
    let updated_at = updated["updated_at"]
        .as_str()
        .expect("updated revision")
        .to_owned();

    let (status, _) = call(
        app.clone(),
        Method::DELETE,
        &format!("/v1/tasks/local/{task_id}"),
        Some(json!({"expected_updated_at": updated_at})),
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, deleted) = call(
        app.clone(),
        Method::GET,
        "/v1/tasks/local/deleted?limit=1",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let deleted = deleted.expect("deleted Todo page");
    assert_eq!(deleted["tasks"][0]["task_id"], task_id);
    assert!(deleted["tasks"][0]["deleted_at"].is_string());
    let deleted_revision = deleted["tasks"][0]["updated_at"]
        .as_str()
        .expect("deleted revision")
        .to_owned();

    let (status, restored) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/tasks/local/{task_id}/restore"),
        Some(json!({"expected_updated_at": deleted_revision})),
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(restored.expect("restored Todo")["deleted_at"].is_null());

    let (status, page) = call(
        app,
        Method::GET,
        "/v1/tasks?limit=1",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let page = page.expect("Todo page");
    assert_eq!(page["tasks"][0]["task_id"], task_id);
    assert_eq!(page["tasks"][0]["text"], "Review the experiment results");
}

#[tokio::test]
async fn vault_browser_lists_searches_and_previews_only_safe_markdown_notes() {
    let (app, authorization, _directory, vault) = paired_app().await;
    fs::create_dir(vault.join("Projects")).expect("nested Vault folder");
    fs::create_dir(vault.join(".obsidian")).expect("Obsidian settings folder");
    fs::write(
        vault.join("Projects/Agent Notes.md"),
        "# Agent Notes\n\nA reviewable local-first workflow.\n",
    )
    .expect("Markdown fixture");
    fs::write(vault.join("ignore.txt"), "local-first").expect("non-Markdown fixture");
    fs::write(vault.join(".obsidian/private.md"), "local-first").expect("hidden fixture");
    // cobsidian 写入事务留下的备份目录同样不得出现在知识库列表/搜索里
    let transaction = vault.join(".cobsidian/transactions/47e4d0d309d434c5f4cc");
    fs::create_dir_all(&transaction).expect("cobsidian transaction folder");
    fs::write(
        transaction.join("before.md"),
        "A reviewable local-first workflow backup.\n",
    )
    .expect("cobsidian backup fixture");

    let (status, listed) = call(
        app.clone(),
        Method::GET,
        "/v1/vault/files?limit=20",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let listed = listed.expect("Vault list");
    assert_eq!(listed["configured"], true);
    assert_eq!(listed["total"], 1);
    assert_eq!(
        listed["items"][0]["relative_path"],
        "Projects/Agent Notes.md"
    );

    let (status, searched) = call(
        app.clone(),
        Method::GET,
        "/v1/vault/search?q=reviewable%20workflow&limit=10",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        searched.expect("Vault search")["items"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );

    let (status, preview) = call(
        app.clone(),
        Method::GET,
        "/v1/vault/note?path=Projects%2FAgent%20Notes.md",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let preview = preview.expect("Vault preview");
    assert_eq!(preview["relative_path"], "Projects/Agent Notes.md");
    assert_eq!(preview["output_is_untrusted"], true);
    assert_eq!(preview["sha256"].as_str().map(str::len), Some(64));

    let (status, _) = call(
        app,
        Method::GET,
        "/v1/vault/note?path=..%2Foutside.md",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn vault_event_stream_reports_external_markdown_changes_without_note_contents() {
    let (app, authorization, _directory, vault) = paired_app().await;
    fs::write(vault.join("watched.md"), "before").expect("watched fixture");
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/v1/vault/events")
                .header("authorization", authorization)
                .header("accept", "text/event-stream")
                .body(Body::empty())
                .expect("event request"),
        )
        .await
        .expect("event response");
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.into_body().into_data_stream();
    let ready = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("ready timeout")
        .expect("ready frame")
        .expect("ready bytes");
    assert!(String::from_utf8_lossy(&ready).contains("event: vault.ready"));

    fs::write(vault.join("watched.md"), "after with private body text")
        .expect("external Vault edit");
    let changed = tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let bytes = stream
                .next()
                .await
                .expect("change frame")
                .expect("change bytes");
            let frame = String::from_utf8_lossy(&bytes).into_owned();
            if frame.contains("event: vault.changed") {
                break frame;
            }
        }
    })
    .await
    .expect("change timeout");
    assert!(changed.contains("watched.md"));
    assert!(!changed.contains("private body text"));
}

#[tokio::test]
async fn available_tools_reflect_vault_and_provider_capability() {
    let (app, authorization, _directory, _vault) = paired_app().await;
    for (id, base_url) in [
        ("deepseek-main", "https://api.deepseek.com"),
        ("glm-main", "https://open.bigmodel.cn/api/paas/v4"),
    ] {
        let (status, _) = call(
            app.clone(),
            Method::PUT,
            &format!("/v1/provider-profiles/{id}"),
            Some(json!({
                "expected_revision": null,
                "provider": {
                    "profile_id": id,
                    "version": 1,
                    "display_name": id,
                    "kind": if id == "deepseek-main" { "deepseek" } else { "glm" },
                    "base_url": base_url,
                    "model": "synthetic",
                    "secret_ref": "keychain:synthetic",
                    "fallback": "disabled"
                }
            })),
            Some(&authorization),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    let (status, deepseek) = call(
        app.clone(),
        Method::GET,
        "/v1/tools/available?provider_profile_id=deepseek-main",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let deepseek = deepseek.expect("deepseek tools");
    let tools = deepseek["tools"].as_array().expect("tools array");
    for expected in ["vault_search", "source_read", "vault_write", "web_search"] {
        assert!(
            tools.iter().any(|tool| tool == expected),
            "missing {expected}"
        );
    }
    assert_eq!(deepseek["web_search_supported"], true);
    let x_status = deepseek["x_search_status"]
        .as_str()
        .expect("X search status");
    assert!(matches!(
        x_status,
        "ready" | "not_installed" | "login_required"
    ));
    assert_eq!(deepseek["x_search_supported"], x_status == "ready");
    assert_eq!(
        tools.iter().any(|tool| tool == "x_search"),
        x_status == "ready"
    );

    // GLM 等非原生联网供应商在 Grok CLI 就绪时复用本机联网能力；
    // 未安装或未登录时仍保留 Vault 工具并诚实报告不可用。
    let (status, glm) = call(
        app.clone(),
        Method::GET,
        "/v1/tools/available?provider_profile_id=glm-main",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let glm = glm.expect("glm tools");
    let grok_ready = x_status == "ready";
    assert_eq!(glm["web_search_supported"], grok_ready);
    assert_eq!(
        glm["web_search_backend"],
        if grok_ready {
            "grok_cli"
        } else {
            "unavailable"
        }
    );
    assert_eq!(glm["x_search_status"], deepseek["x_search_status"]);
    let tools = glm["tools"].as_array().expect("tools array");
    assert!(tools.iter().any(|tool| tool == "vault_search"));
    assert_eq!(tools.iter().any(|tool| tool == "web_search"), grok_ready);

    let (status, _) = call(
        app,
        Method::GET,
        "/v1/tools/available?provider_profile_id=missing",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn memory_retention_cas_export_and_source_purge_are_enforced() {
    let (app, authorization, _directory, _vault) = paired_app().await;
    let (status, expired) = call(
        app.clone(),
        Method::POST,
        "/v1/memory",
        Some(json!({
            "memory_id": "expired-cache",
            "kind": "observation",
            "summary": "This cache is already expired",
            "data_class": "personal",
            "retention_class": "cache",
            "expires_at": "2020-01-01T00:00:00Z",
            "source_id": "source-expired"
        })),
        Some(&authorization),
        Some("memory-expired"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(expired.expect("expired memory")["retention_class"], "cache");

    let (status, created) = call(
        app.clone(),
        Method::POST,
        "/v1/memory",
        Some(json!({
            "memory_id": "durable-preference",
            "kind": "preference",
            "summary": "Prefer concise evidence cards",
            "data_class": "personal",
            "retention_class": "durable",
            "expires_at": null,
            "source_id": "source-user"
        })),
        Some(&authorization),
        Some("memory-durable"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let created = created.expect("durable memory");
    let content_hash = created["content_hash"]
        .as_str()
        .expect("content hash")
        .to_owned();

    let (status, page) = call(
        app.clone(),
        Method::GET,
        "/v1/memory?limit=20",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let records = page.expect("memory page")["records"]
        .as_array()
        .expect("records")
        .clone();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["memory_id"], "durable-preference");

    let (status, conflict) = call(
        app.clone(),
        Method::PATCH,
        "/v1/memory/durable-preference",
        Some(json!({
            "summary": "Prefer compact evidence cards",
            "expected_content_hash": "0".repeat(64),
            "data_class": "personal"
        })),
        Some(&authorization),
        Some("memory-stale-correction"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(
        conflict.expect("CAS conflict")["detail"]
            .as_str()
            .expect("detail")
            .contains("changed")
    );

    let (status, corrected) = call(
        app.clone(),
        Method::PATCH,
        "/v1/memory/durable-preference",
        Some(json!({
            "summary": "Prefer compact evidence cards",
            "expected_content_hash": content_hash,
            "data_class": "personal"
        })),
        Some(&authorization),
        Some("memory-valid-correction"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(corrected.expect("corrected memory")["version"], 2);

    let (status, exported) = call(
        app.clone(),
        Method::POST,
        "/v1/memory/export",
        Some(json!({"layers": ["episodic"]})),
        Some(&authorization),
        Some("memory-export"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(exported.expect("memory export")["record_count"], 1);

    let (status, purged) = call(
        app.clone(),
        Method::POST,
        "/v1/memory/purge-source",
        Some(json!({"source_id": "source-user"})),
        Some(&authorization),
        Some("memory-purge-source"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(purged.expect("purge result")["deleted_records"], 1);

    let (status, search) = call(
        app,
        Method::GET,
        "/v1/search?q=evidence&limit=10",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        search.expect("search results")["items"]
            .as_array()
            .expect("items")
            .is_empty()
    );
}

#[tokio::test]
async fn markdown_task_write_requires_a_matching_single_use_approval() {
    let (app, authorization, _directory, vault) = paired_app().await;
    let (status, preview) = call(
        app.clone(),
        Method::POST,
        "/v1/tasks/quick-capture/preview",
        Some(json!({"text": "Review the release evidence", "priority": "P1"})),
        Some(&authorization),
        Some("task-capture-preview"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let preview = preview.expect("task preview");
    let approval_id = preview["approval"]["approval_id"]
        .as_str()
        .expect("approval id")
        .to_owned();

    let (status, _) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/tasks/approvals/{approval_id}/apply"),
        Some(json!({})),
        Some(&authorization),
        Some("task-apply-before-approval"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(!vault.join("Restork Tasks.md").exists());

    let (status, approved) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/approvals/{approval_id}"),
        Some(json!({"decision": "approve", "decided_by": "contract-test"})),
        Some(&authorization),
        Some("task-approve"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(approved.expect("approval")["decision"], "approved");

    let (status, applied) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/tasks/approvals/{approval_id}/apply"),
        Some(json!({})),
        Some(&authorization),
        Some("task-apply"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(applied.expect("apply result")["applied"], true);
    let note = fs::read_to_string(vault.join("Restork Tasks.md")).expect("task note");
    assert!(note.contains("- [ ] Review the release evidence #todo [priority:: P1]"));

    let (status, _) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/tasks/approvals/{approval_id}/apply"),
        Some(json!({})),
        Some(&authorization),
        Some("task-apply-replay"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, tasks) = call(
        app.clone(),
        Method::GET,
        "/v1/tasks?limit=20",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let tasks = tasks.expect("task page");
    assert!(
        tasks["tasks"][0]["text"]
            .as_str()
            .expect("task text")
            .starts_with("Review the release evidence #todo")
    );
    assert_eq!(tasks["tasks"][0]["fields"]["priority"], "P1");

    let (status, radar) = call(
        app,
        Method::GET,
        "/v1/radar",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(radar.expect("Radar state")["configured"], false);
}

#[tokio::test]
async fn study_note_preview_writes_validated_artifact_to_the_vault() {
    let directory = TestDirectory::new();
    let vault = directory.0.join("vault");
    fs::create_dir(&vault).expect("Vault fixture");
    let database = Arc::new(Database::open(directory.0.join("restork.db")).expect("database"));
    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let code = authority.initial_pairing_code();
    let app = restork_api::router_with_runtime(authority, database.clone(), Some(vault.clone()));
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
    let authorization = format!("Bearer {token}");

    let run_id = "run-study-note";
    let note_path = "Restork Study - Agent-Harness-总览.md";
    let markdown = "# Restork Study: Agent Harness 总览\n\n> Generated by Restork Study · Readiness: ready\n\n## Learning path\n1. **Harness 是什么** — 说清控制层\n\n## Exercises\n- [active_recall] harness 和 loop 的区别 — concept: harness\n";
    let artifact = json!({
        "artifact_id": "study-artifact-test",
        "run_id": run_id,
        "note_preview": {
            "action": "create",
            "relative_path": note_path,
            "expected_hash": null,
            "markdown_hash": "0123456789abcdef",
            "markdown": markdown,
        }
    });
    database
        .save_study_session(
            run_id,
            &"a".repeat(64),
            &json!({"objective": "Agent Harness 总览"}),
            &json!({"questions": []}),
            Some(&artifact),
            "2026-08-08T00:00:00Z",
        )
        .expect("seed Study session");

    // Unknown runs have no Study session to mirror.
    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/study/runs/run-missing/note/preview",
        Some(json!({})),
        Some(&authorization),
        Some("study-note-preview-missing"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, preview) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/study/runs/{run_id}/note/preview"),
        Some(json!({})),
        Some(&authorization),
        Some("study-note-preview"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let preview = preview.expect("study note preview");
    assert_eq!(preview["relative_path"], note_path);
    assert_eq!(preview["approval"]["action_kind"], "vault_write");
    assert_eq!(preview["approval"]["decision"], "pending");
    let approval_id = preview["approval"]["approval_id"]
        .as_str()
        .expect("approval id")
        .to_owned();

    // The write stays gated: apply before approval is rejected and nothing lands.
    let (status, _) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/tasks/approvals/{approval_id}/apply"),
        Some(json!({})),
        Some(&authorization),
        Some("study-note-apply-before-approval"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(!vault.join(note_path).exists());

    let (status, approved) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/approvals/{approval_id}"),
        Some(json!({"decision": "approve", "decided_by": "contract-test"})),
        Some(&authorization),
        Some("study-note-approve"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(approved.expect("approval")["decision"], "approved");

    let (status, applied) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/tasks/approvals/{approval_id}/apply"),
        Some(json!({})),
        Some(&authorization),
        Some("study-note-apply"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(applied.expect("apply result")["applied"], true);
    let note = fs::read_to_string(vault.join(note_path)).expect("study note");
    assert!(note.contains("# Restork Study: Agent Harness 总览"));
    assert!(note.contains("## Learning path"));

    // Approvals are single-use; replaying the apply is rejected.
    let (status, _) = call(
        app.clone(),
        Method::POST,
        &format!("/v1/tasks/approvals/{approval_id}/apply"),
        Some(json!({})),
        Some(&authorization),
        Some("study-note-apply-replay"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Artifacts from before note previews existed degrade to a clear 422.
    database
        .save_study_session(
            "run-study-legacy",
            &"b".repeat(64),
            &json!({"objective": "Legacy"}),
            &json!({"questions": []}),
            Some(&json!({"artifact_id": "study-artifact-legacy"})),
            "2026-08-08T00:00:00Z",
        )
        .expect("seed legacy Study session");
    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/study/runs/run-study-legacy/note/preview",
        Some(json!({})),
        Some(&authorization),
        Some("study-note-preview-legacy"),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}
