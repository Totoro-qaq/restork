use restork_storage::{Database, NewMcpExecution, NewSession};
use serde_json::json;

struct TestDirectory(tempfile::TempDir);

impl TestDirectory {
    fn new() -> Self {
        Self(tempfile::tempdir().expect("temporary directory"))
    }
}

#[test]
fn extensions_start_quarantined_and_activation_binds_the_reviewed_hash() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.path().join("restork.db")).expect("database");
    let installed = database
        .install_extension(
            "synthetic-skill",
            "skill",
            &json!({"schema_version": 1, "id": "synthetic-skill"}),
            "2026-08-02T00:00:00Z",
        )
        .expect("install");
    assert_eq!(installed.state, "quarantined");
    assert!(
        database
            .set_extension_state(
                "synthetic-skill",
                &"0".repeat(64),
                "enabled",
                "2026-08-02T00:01:00Z",
            )
            .is_err()
    );
    let enabled = database
        .set_extension_state(
            "synthetic-skill",
            &installed.manifest_hash,
            "enabled",
            "2026-08-02T00:01:00Z",
        )
        .expect("enable reviewed extension");
    assert_eq!(enabled.state, "enabled");
}

#[test]
fn extension_updates_keep_history_and_rollback_requires_a_new_review() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.path().join("restork.db")).expect("database");
    let first = database
        .install_extension(
            "synthetic-skill",
            "skill",
            &json!({"schema_version": 1, "id": "synthetic-skill", "version": "1.0.0"}),
            "2026-08-02T00:00:00Z",
        )
        .expect("first revision");
    database
        .set_extension_state(
            "synthetic-skill",
            &first.manifest_hash,
            "enabled",
            "2026-08-02T00:01:00Z",
        )
        .expect("enable first revision");
    let second = database
        .install_extension(
            "synthetic-skill",
            "skill",
            &json!({"schema_version": 1, "id": "synthetic-skill", "version": "2.0.0"}),
            "2026-08-02T00:02:00Z",
        )
        .expect("stage update");
    assert_eq!(second.state, "quarantined");
    let history = database
        .extension_revisions("synthetic-skill", 10)
        .expect("revision history");
    assert_eq!(history.len(), 2);
    assert!(
        history
            .iter()
            .any(|revision| revision.manifest_hash == first.manifest_hash)
    );

    let rollback = database
        .rollback_extension(
            "synthetic-skill",
            &second.manifest_hash,
            &first.manifest_hash,
            "2026-08-02T00:03:00Z",
        )
        .expect("stage rollback");
    assert_eq!(rollback.manifest_hash, first.manifest_hash);
    assert_eq!(rollback.state, "quarantined");
}

#[test]
fn mcp_execution_is_idempotent_and_terminal_result_is_durable() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.path().join("restork.db")).expect("database");
    database
        .create_session(NewSession {
            session_id: "session-mcp",
            title: "MCP audit",
            profile_id: "safe-mode",
            locale: Some("en"),
            occurred_at: "2026-08-02T00:00:00Z",
        })
        .expect("session");
    let resolved = json!({"real_tool_id": "papers.search", "input": {"query": "agents"}});
    let created = database
        .create_mcp_execution(&NewMcpExecution {
            execution_id: "mcp-fixture",
            session_id: "session-mcp",
            idempotency_key: "papers-search-1",
            tool_id: "papers.search",
            package_id: "paper-mcp",
            package_hash: &"a".repeat(64),
            catalog_fingerprint: &"b".repeat(64),
            call_digest: &"c".repeat(64),
            resolved_call: &resolved,
            started_at: "2026-08-02T00:01:00Z",
        })
        .expect("execution");
    assert!(!created.replayed);
    let failed = database
        .complete_mcp_execution(
            "mcp-fixture",
            "failed",
            None,
            Some("unsupported_transport"),
            "2026-08-02T00:02:00Z",
        )
        .expect("terminal execution");
    assert_eq!(failed.error_code.as_deref(), Some("unsupported_transport"));
}

#[test]
fn deliverables_keep_revisions_and_schedules_use_optimistic_updates() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.path().join("restork.db")).expect("database");
    for revision in 1..=2 {
        database
            .save_deliverable(
                "report-synthetic",
                "daily_report",
                revision,
                &json!({"revision": revision, "facts": []}),
                "draft",
                &format!("2026-08-02T00:0{revision}:00Z"),
            )
            .expect("save deliverable revision");
    }
    let deliverables = database
        .deliverables_page(None, 10)
        .expect("deliverable history");
    assert_eq!(deliverables.items.len(), 2);

    let schedule = json!({"schedule_id": "schedule-synthetic", "timezone": "UTC"});
    let first = database
        .put_schedule(
            "schedule-synthetic",
            &schedule,
            None,
            "active",
            Some("2026-08-03T00:00:00Z"),
            "2026-08-02T00:00:00Z",
        )
        .expect("create schedule");
    assert_eq!(first.revision, 1);
    assert!(
        database
            .put_schedule(
                "schedule-synthetic",
                &schedule,
                Some(0),
                "paused",
                None,
                "2026-08-02T00:01:00Z",
            )
            .is_err()
    );
    let paused = database
        .put_schedule(
            "schedule-synthetic",
            &schedule,
            Some(1),
            "paused",
            None,
            "2026-08-02T00:01:00Z",
        )
        .expect("pause schedule");
    assert_eq!(paused.revision, 2);
    assert_eq!(paused.state, "paused");
}

#[test]
fn schedules_are_soft_deleted_restored_and_keep_paginated_run_history() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.path().join("restork.db")).expect("database");
    let document = json!({
        "schedule_id": "schedule-recoverable",
        "name": "Recoverable health check",
        "timezone": "UTC"
    });
    let created = database
        .put_schedule(
            "schedule-recoverable",
            &document,
            None,
            "active",
            Some("2026-08-03T00:00:00Z"),
            "2026-08-02T00:00:00Z",
        )
        .expect("create schedule");
    for index in 1..=3 {
        database
            .record_schedule_run(
                "schedule-recoverable",
                &format!("manual:{index}"),
                None,
                &json!({"state": "completed", "index": index}),
                &format!("2026-08-02T00:0{index}:00Z"),
            )
            .expect("record run");
    }

    let deleted = database
        .soft_delete_schedule(
            "schedule-recoverable",
            created.revision,
            "2026-08-02T00:10:00Z",
        )
        .expect("soft delete");
    assert!(deleted.deleted_at.is_some());
    assert_eq!(deleted.revision, 2);
    assert!(
        database
            .schedules_page(None, 10)
            .expect("active schedules")
            .items
            .is_empty()
    );
    assert!(
        database
            .due_schedules("2026-08-04T00:00:00Z", 10)
            .expect("due schedules")
            .is_empty()
    );
    let trash = database
        .deleted_schedules_page(None, 10)
        .expect("schedule trash");
    assert_eq!(trash.items.len(), 1);

    let first_runs = database
        .schedule_runs_page("schedule-recoverable", None, 2)
        .expect("first runs page");
    assert_eq!(first_runs.items.len(), 2);
    let second_runs = database
        .schedule_runs_page("schedule-recoverable", first_runs.next.as_ref(), 2)
        .expect("second runs page");
    assert_eq!(second_runs.items.len(), 1);

    let restored = database
        .restore_schedule(
            "schedule-recoverable",
            deleted.revision,
            Some("2026-08-05T00:00:00Z"),
            "2026-08-02T00:11:00Z",
        )
        .expect("restore");
    assert!(restored.deleted_at.is_none());
    assert_eq!(restored.revision, 3);
    assert_eq!(
        restored.next_run_at.as_deref(),
        Some("2026-08-05T00:00:00Z")
    );
    assert_eq!(
        database
            .schedule_runs_page("schedule-recoverable", None, 10)
            .expect("preserved history")
            .items
            .len(),
        3
    );
}

#[test]
fn model_schedule_runs_are_claimed_before_work_and_completed_with_compare_and_swap() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.path().join("restork.db")).expect("database");
    database
        .put_schedule(
            "schedule-claimed",
            &json!({"schedule_id": "schedule-claimed", "timezone": "UTC"}),
            None,
            "active",
            Some("2026-08-03T00:00:00Z"),
            "2026-08-02T00:00:00Z",
        )
        .expect("schedule");
    let claim = json!({"state": "running", "claim_token": "claim-1"});
    let first = database
        .claim_schedule_run(
            "schedule-claimed",
            "scheduled:fixture",
            &claim,
            "2026-08-02T00:01:00Z",
        )
        .expect("claim");
    assert!(!first.replayed);
    let duplicate = database
        .claim_schedule_run(
            "schedule-claimed",
            "scheduled:fixture",
            &json!({"state": "running", "claim_token": "claim-2"}),
            "2026-08-02T00:01:01Z",
        )
        .expect("duplicate claim");
    assert!(duplicate.replayed);
    assert_eq!(duplicate.result["claim_token"], "claim-1");

    let completed = database
        .complete_schedule_run(
            "schedule-claimed",
            "scheduled:fixture",
            &claim,
            &json!({"state": "draft_created", "provider_call": true}),
        )
        .expect("complete claim");
    assert_eq!(completed.result["state"], "draft_created");
    assert!(
        database
            .complete_schedule_run(
                "schedule-claimed",
                "scheduled:fixture",
                &claim,
                &json!({"state": "failed"}),
            )
            .is_err()
    );
}

#[test]
fn scheduler_advance_does_not_overwrite_a_newer_pause_or_edit() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.path().join("restork.db")).expect("database");
    let created = database
        .put_schedule(
            "schedule-cas",
            &json!({"schedule_id": "schedule-cas", "timezone": "UTC"}),
            None,
            "active",
            Some("2026-08-03T00:00:00Z"),
            "2026-08-02T00:00:00Z",
        )
        .expect("schedule");
    database
        .put_schedule(
            "schedule-cas",
            &created.schedule,
            Some(created.revision),
            "paused",
            None,
            "2026-08-02T00:02:00Z",
        )
        .expect("pause");

    let advanced = database
        .advance_schedule(
            "schedule-cas",
            created.revision,
            created.next_run_at.as_deref(),
            Some("2026-08-04T00:00:00Z"),
            "2026-08-02T00:03:00Z",
        )
        .expect("bounded advance");
    assert!(!advanced);
    let stored = database
        .schedule("schedule-cas")
        .expect("lookup")
        .expect("stored");
    assert_eq!(stored.state, "paused");
    assert_eq!(stored.revision, 2);
}

#[test]
fn deliverable_exports_are_hash_bound_audited_and_idempotent() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.path().join("restork.db")).expect("database");
    database
        .save_deliverable(
            "deck-synthetic",
            "deck",
            1,
            &json!({"revision": 1}),
            "outline_review",
            "2026-08-02T00:00:00Z",
        )
        .expect("save deck");
    let manifest = json!({
        "renderer_id": "restork-native",
        "artifact_hash": "a".repeat(64),
        "approval": {"approved": true}
    });
    let first = database
        .record_deliverable_export(
            "export:synthetic",
            "deck-synthetic",
            1,
            "pptx",
            &manifest,
            &"a".repeat(64),
            "render-synthetic-1",
            "2026-08-02T00:01:00Z",
        )
        .expect("record export");
    assert!(!first.replayed);
    let replay = database
        .record_deliverable_export(
            "export:synthetic",
            "deck-synthetic",
            1,
            "pptx",
            &manifest,
            &"a".repeat(64),
            "render-synthetic-1",
            "2026-08-02T00:02:00Z",
        )
        .expect("replay export");
    assert!(replay.replayed);
    assert!(
        database
            .record_deliverable_export(
                "export:other",
                "deck-synthetic",
                1,
                "pdf",
                &manifest,
                &"a".repeat(64),
                "render-synthetic-1",
                "2026-08-02T00:03:00Z",
            )
            .is_err()
    );
}

#[test]
fn subtasks_enforce_parent_concurrency_and_terminal_cancellation() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.path().join("restork.db")).expect("database");
    for index in 1..=3 {
        database
            .save_subtask(
                &format!("subtask:{index}"),
                "run:parent",
                &json!({"objective": format!("bounded {index}")}),
                &format!("{index}").repeat(64),
                "2026-08-02T00:00:00Z",
            )
            .expect("save subtask");
    }
    database
        .claim_subtask("subtask:1", "2026-08-02T00:01:00Z")
        .expect("claim first");
    database
        .claim_subtask("subtask:2", "2026-08-02T00:01:01Z")
        .expect("claim second");
    assert!(
        database
            .claim_subtask("subtask:3", "2026-08-02T00:01:02Z")
            .is_err()
    );
    let cancelled = database
        .cancel_subtask("subtask:1", "2026-08-02T00:02:00Z")
        .expect("cancel running child");
    assert_eq!(cancelled.state, "cancelled");
    database
        .claim_subtask("subtask:3", "2026-08-02T00:02:01Z")
        .expect("claim after slot release");
    let timed_out = database
        .complete_subtask(
            "subtask:3",
            "timed_out",
            &json!({"error_code": "timeout"}),
            "2026-08-02T00:03:00Z",
        )
        .expect("record timeout");
    assert_eq!(timed_out.state, "timed_out");
}
