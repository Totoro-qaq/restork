use std::{fs, path::PathBuf};

use restork_storage::{Database, NewMcpExecution, NewSession};
use serde_json::json;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let mut suffix = [0_u8; 12];
        getrandom::fill(&mut suffix).expect("entropy");
        let path = std::env::temp_dir().join(format!(
            "restork-catalog-{}",
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

#[test]
fn extensions_start_quarantined_and_activation_binds_the_reviewed_hash() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.join("restork.db")).expect("database");
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
    let database = Database::open(directory.0.join("restork.db")).expect("database");
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
    let database = Database::open(directory.0.join("restork.db")).expect("database");
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
    let database = Database::open(directory.0.join("restork.db")).expect("database");
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
fn deliverable_exports_are_hash_bound_audited_and_idempotent() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.join("restork.db")).expect("database");
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
    let database = Database::open(directory.0.join("restork.db")).expect("database");
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
