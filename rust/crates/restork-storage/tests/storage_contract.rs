use std::{fs, path::PathBuf, sync::Arc, thread};

use restork_storage::{
    Database, NewEvent, NewLocalTodo, NewRadarRecord, NewRun, NewXCocreationDraft,
};
use rusqlite::Connection;
use serde_json::json;

struct TestDirectory(tempfile::TempDir);

impl TestDirectory {
    fn new(_label: &str) -> Self {
        Self(tempfile::tempdir().expect("temporary directory"))
    }

    fn database(&self) -> PathBuf {
        self.0.path().join("restork.db")
    }
}

#[test]
fn rust_database_creates_the_frozen_v1_tables_and_migration_ledger() {
    let directory = TestDirectory::new("schema");
    let database = Database::open(directory.database()).expect("open database");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = fs::metadata(database.path())
            .expect("database metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    assert_eq!(database.schema_version().expect("schema version"), 16);
    let history = database.migration_history().expect("migration history");
    assert_eq!(
        history
            .iter()
            .map(|migration| (migration.version, migration.name.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (1, "v1_schema_adoption"),
            (2, "idempotency_binding"),
            (3, "personal_daily"),
            (4, "conversation_workspace"),
            (5, "extension_center"),
            (6, "deliverables"),
            (7, "automation_recovery"),
            (8, "interactive_core"),
            (9, "extension_runtime"),
            (10, "artifact_recovery"),
            (11, "mail_awareness"),
            (12, "radar_star_history"),
            (13, "local_todos"),
            (14, "recoverable_schedules"),
            (15, "memory_suggestions"),
            (16, "x_cocreation"),
        ]
    );
    assert_ne!(history[0].checksum, history[1].checksum);
    let tables = database.table_names().expect("table names");
    for required in [
        "runs",
        "events",
        "approvals",
        "effect_intents",
        "event_snapshots",
        "idempotency_records",
        "run_budgets",
        "run_checkpoints",
        "memory_records",
        "memory_suggestions",
        "conversation_turns",
        "personal_settings",
        "sessions",
        "session_messages",
        "configuration_profiles",
        "provider_profiles",
        "prompt_revisions",
        "extension_packages",
        "deliverables",
        "recovery_checkpoints",
        "schedules",
        "evaluation_batches",
        "subtasks",
        "context_previews",
        "conversation_operations",
        "operation_events",
        "native_calendar_connections",
        "schema_migrations",
    ] {
        assert!(tables.contains(required), "missing {required}");
    }
}

#[test]
fn x_cocreation_drafts_record_manual_publication_and_prune_expired_evidence() {
    let directory = TestDirectory::new("x-cocreation");
    let database = Database::open(directory.database()).expect("open database");
    for (item_id, occurred_at) in [
        ("x-2082263717916586117", "2026-08-20T09:00:00Z"),
        ("x-2070000000000000000", "2026-07-01T09:00:00Z"),
    ] {
        database
            .upsert_radar(NewRadarRecord {
                item_id,
                lane: "x",
                title: "@OpenAI",
                source: "X · independently verified",
                url: &format!("https://x.com/OpenAI/status/{}", &item_id[2..]),
                summary: "A verified public release note.",
                score: 1.0,
                stars_total: None,
                published_at: Some(occurred_at),
                state: "topic",
                data_class: "public",
                occurred_at,
            })
            .expect("store X evidence");
    }

    let artifact = json!({
        "schema_version": 1,
        "category": "开发判断",
        "title": "Why reviewed writes are worth one more step",
        "evidence_ids": ["x-2082263717916586117"],
        "variants": [
            {"label": "A", "body": "Start from the change, not the announcement.", "first_reply": "Source: https://x.com/OpenAI/status/2082263717916586117"},
            {"label": "B", "body": "A preview is part of the product, not ceremony.", "first_reply": "Source: https://x.com/OpenAI/status/2082263717916586117"},
            {"label": "C", "body": "Local-first still needs a visible write boundary.", "first_reply": "Source: https://x.com/OpenAI/status/2082263717916586117"}
        ],
        "image_directions": ["Annotated approval boundary", "Evidence-to-note flow"]
    });
    let draft = database
        .save_x_cocreation_draft(NewXCocreationDraft {
            draft_id: "x-draft-1",
            artifact: &artifact,
            state: "draft",
            occurred_at: "2026-08-24T09:00:00Z",
        })
        .expect("save X draft");
    assert_eq!(draft.artifact["variants"].as_array().map(Vec::len), Some(3));

    let published = database
        .record_x_cocreation_publication(
            "x-draft-1",
            "Start with the concrete change.",
            "Source: https://x.com/OpenAI/status/2082263717916586117",
            None,
            &["opening".to_owned(), "length".to_owned()],
            &draft.updated_at,
            "2026-08-24T10:00:00Z",
        )
        .expect("record manual publication");
    assert_eq!(published.state, "published");
    assert_eq!(published.final_url, None);
    assert_eq!(
        database.x_voice_observation_counts().expect("voice counts")["opening"],
        1
    );

    let deleted = database
        .delete_expired_x_evidence("2026-07-25T00:00:00Z")
        .expect("prune expired X evidence");
    assert_eq!(deleted, 1);
    let remaining = database.radar_items(100, 0).expect("remaining Radar items");
    assert!(
        remaining
            .iter()
            .any(|item| item.item_id == "x-2082263717916586117")
    );
    assert!(
        !remaining
            .iter()
            .any(|item| item.item_id == "x-2070000000000000000")
    );
}

#[test]
fn vault_switch_revokes_unconsumed_authority_but_keeps_audit_history() {
    let directory = TestDirectory::new("vault-switch-authority");
    let database = Database::open(directory.database()).expect("open database");
    database
        .save_approval(
            "approval-pending",
            "run-pending",
            "2026-08-10T00:00:00Z",
            &json!({"tool": "vault.write"}),
        )
        .expect("pending approval");
    database
        .save_approval(
            "approval-approved",
            "run-approved",
            "2026-08-10T00:00:00Z",
            &json!({"tool": "vault.write"}),
        )
        .expect("approved approval");
    database
        .decide_approval("approval-approved", "approved")
        .expect("approve");

    assert_eq!(
        database
            .invalidate_vault_bound_authority()
            .expect("invalidate authority"),
        2
    );
    assert_eq!(
        database
            .approval("approval-pending")
            .expect("pending audit")
            .expect("pending record")
            .decision,
        "rejected"
    );
    assert_eq!(
        database
            .approval("approval-approved")
            .expect("approved audit")
            .expect("approved record")
            .decision,
        "rejected"
    );
}

#[test]
fn event_append_is_monotonic_replayable_and_keyset_paginated() {
    let directory = TestDirectory::new("events");
    let database = Database::open(directory.database()).expect("open database");
    database
        .create_run(NewRun {
            run_id: "run-1",
            task_id: "task-1",
            task_spec: &json!({"schema_version": 1, "goal": "synthetic"}),
            mode: "research",
            state: "created",
            occurred_at: "2026-08-02T00:00:00Z",
        })
        .expect("create run");

    for index in 1..=3 {
        let stored = database
            .append_event(NewEvent {
                event_id: &format!("event-{index}"),
                run_id: "run-1",
                occurred_at: "2026-08-02T00:00:00Z",
                kind: "run.progress",
                metadata: &json!({"index": index}),
            })
            .expect("append event");
        assert_eq!(stored.sequence, index);
    }

    let first = database.events_after("run-1", 0, 2).expect("first page");
    assert_eq!(first.items.len(), 2);
    assert_eq!(first.items[0].sequence, 1);
    assert_eq!(first.next_after, Some(2));
    let second = database
        .events_after("run-1", first.next_after.expect("cursor"), 2)
        .expect("second page");
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.items[0].metadata, json!({"index": 3}));
    assert_eq!(second.next_after, None);
}

#[test]
fn idempotency_binding_replays_exactly_and_rejects_reuse() {
    let directory = TestDirectory::new("idempotency");
    let database = Database::open(directory.database()).expect("open database");
    let response = json!({"run_id": "run-1"});

    let first = database
        .record_idempotent("runs.create", "request-1", "binding-a", &response)
        .expect("record response");
    let replay = database
        .record_idempotent("runs.create", "request-1", "binding-a", &response)
        .expect("replay response");

    assert!(!first.replayed);
    assert!(replay.replayed);
    assert_eq!(replay.response, response);
    assert!(
        database
            .record_idempotent("runs.create", "request-1", "binding-b", &response)
            .is_err()
    );
}

#[test]
fn migration_creates_a_consistent_backup_and_is_idempotent_on_reopen() {
    let directory = TestDirectory::new("migration-backup");
    let path = directory.database();
    let legacy = Connection::open(&path).expect("legacy database");
    legacy
        .execute_batch(
            "CREATE TABLE legacy_marker (value TEXT NOT NULL);\n\
             INSERT INTO legacy_marker VALUES ('before-migration');",
        )
        .expect("legacy fixture");
    drop(legacy);

    let migrated = Database::open(&path).expect("migrate database");
    let backup = migrated
        .migration_backup()
        .expect("pre-migration backup")
        .to_path_buf();
    assert!(backup.is_file());
    let backup_connection = Connection::open(backup).expect("open backup");
    let marker: String = backup_connection
        .query_row("SELECT value FROM legacy_marker", [], |row| row.get(0))
        .expect("backup marker");
    assert_eq!(marker, "before-migration");
    drop(migrated);

    let reopened = Database::open(&path).expect("reopen migrated database");
    assert!(reopened.migration_backup().is_none());
    assert_eq!(reopened.migration_history().expect("history").len(), 15);
}

#[test]
fn future_corrupt_and_drifted_databases_fail_closed() {
    let future = TestDirectory::new("future-schema");
    let connection = Connection::open(future.database()).expect("future database");
    connection
        .pragma_update(None, "user_version", 99)
        .expect("future version");
    drop(connection);
    assert!(Database::open(future.database()).is_err());

    let corrupt = TestDirectory::new("corrupt-schema");
    fs::write(corrupt.database(), b"not a sqlite database").expect("corrupt fixture");
    assert!(Database::open(corrupt.database()).is_err());

    let drift = TestDirectory::new("migration-drift");
    let path = drift.database();
    drop(Database::open(&path).expect("initial database"));
    let connection = Connection::open(&path).expect("open migrated database");
    connection
        .execute(
            "UPDATE schema_migrations SET checksum = 'changed' WHERE version = 1",
            [],
        )
        .expect("mutate fixture");
    drop(connection);
    assert!(Database::open(path).is_err());
}

#[test]
fn known_pre_release_trailing_newline_checksums_remain_compatible() {
    let directory = TestDirectory::new("legacy-checksums");
    let path = directory.database();
    drop(Database::open(&path).expect("initial database"));
    let connection = Connection::open(&path).expect("open migrated database");
    for (version, checksum) in [
        (
            3,
            "97581e498ba21a4e921ba3829d06be87f9cc22a711e564072b133343be554f0a",
        ),
        (
            5,
            "5b123f947c66bf0e9fa381c61de1fdd32394758953659cd6477c4e60b1af8256",
        ),
        (
            7,
            "c708cd1c349f281ecbe342bc8b4b5d3eebb5104e3bbd15fc1c54bec0bf85d3fb",
        ),
        (
            8,
            "1bd1046039d2e6be8f10fe35a9d99255419c57ae12ee9f048faf7f7666df0acd",
        ),
        (
            11,
            "f3d6ceeacb7a24dea769f54ec1899d71848b58be7fc6c4926ee4c465dba70c33",
        ),
    ] {
        connection
            .execute(
                "UPDATE schema_migrations SET checksum = ?1 WHERE version = ?2",
                (checksum, version),
            )
            .expect("install legacy checksum fixture");
    }
    drop(connection);

    Database::open(path).expect("known equivalent migration history should open");
}

#[test]
fn concurrent_event_append_allocates_each_sequence_exactly_once() {
    let directory = TestDirectory::new("concurrent-events");
    let database = Arc::new(Database::open(directory.database()).expect("open database"));
    database
        .create_run(NewRun {
            run_id: "run-concurrent",
            task_id: "task-concurrent",
            task_spec: &json!({"schema_version": 1}),
            mode: "work",
            state: "running",
            occurred_at: "2026-08-02T00:00:00Z",
        })
        .expect("create run");

    let workers = (0..8)
        .map(|worker| {
            let database = Arc::clone(&database);
            thread::spawn(move || {
                for item in 0..10 {
                    let event_id = format!("event-{worker}-{item}");
                    database
                        .append_event(NewEvent {
                            event_id: &event_id,
                            run_id: "run-concurrent",
                            occurred_at: "2026-08-02T00:00:00Z",
                            kind: "run.progress",
                            metadata: &json!({"worker": worker, "item": item}),
                        })
                        .expect("append concurrent event");
                }
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().expect("join worker");
    }

    let page = database
        .events_after("run-concurrent", 0, 100)
        .expect("all events");
    assert_eq!(page.items.len(), 80);
    assert_eq!(
        page.items
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        (1..=80).collect::<Vec<_>>()
    );
}

#[test]
fn replay_window_uses_a_newer_snapshot_and_never_replays_covered_events() {
    let directory = TestDirectory::new("snapshot-replay");
    let database = Database::open(directory.database()).expect("open database");
    database
        .create_run(NewRun {
            run_id: "run-snapshot",
            task_id: "task-snapshot",
            task_spec: &json!({"schema_version": 1}),
            mode: "research",
            state: "running",
            occurred_at: "2026-08-02T00:00:00Z",
        })
        .expect("create run");
    for index in 1..=4 {
        database
            .append_event(NewEvent {
                event_id: &format!("snapshot-event-{index}"),
                run_id: "run-snapshot",
                occurred_at: "2026-08-02T00:00:00Z",
                kind: "run.progress",
                metadata: &json!({"index": index}),
            })
            .expect("append event");
    }
    database
        .save_snapshot("run-snapshot", 3, &json!({"phase": "running"}))
        .expect("save snapshot");

    let replay = database
        .replay_window("run-snapshot", 1, 100)
        .expect("replay window");
    assert_eq!(replay.snapshot.expect("snapshot").covered_sequence, 3);
    assert_eq!(
        replay
            .events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        vec![4]
    );

    let replay = database
        .replay_window("run-snapshot", 3, 100)
        .expect("cursor after snapshot");
    assert!(replay.snapshot.is_none());
    assert_eq!(replay.events[0].sequence, 4);
    assert!(
        database
            .save_snapshot("run-snapshot", 2, &json!({}))
            .is_err()
    );
}

#[test]
fn persisted_contract_documents_must_be_json_objects() {
    let directory = TestDirectory::new("object-documents");
    let database = Database::open(directory.database()).expect("open database");
    assert!(
        database
            .create_run(NewRun {
                run_id: "run-invalid-spec",
                task_id: "task-invalid-spec",
                task_spec: &json!(["not", "an", "object"]),
                mode: "work",
                state: "created",
                occurred_at: "2026-08-02T00:00:00Z",
            })
            .is_err()
    );

    database
        .create_run(NewRun {
            run_id: "run-object-documents",
            task_id: "task-object-documents",
            task_spec: &json!({"schema_version": 1}),
            mode: "work",
            state: "running",
            occurred_at: "2026-08-02T00:00:00Z",
        })
        .expect("create valid run");
    assert!(
        database
            .append_event(NewEvent {
                event_id: "event-invalid-metadata",
                run_id: "run-object-documents",
                occurred_at: "2026-08-02T00:00:01Z",
                kind: "run.progress",
                metadata: &json!("not an object"),
            })
            .is_err()
    );
    database
        .append_event(NewEvent {
            event_id: "event-valid-metadata",
            run_id: "run-object-documents",
            occurred_at: "2026-08-02T00:00:02Z",
            kind: "run.progress",
            metadata: &json!({"phase": "running"}),
        })
        .expect("append valid event");
    assert!(
        database
            .save_snapshot("run-object-documents", 1, &json!(["not", "an", "object"]))
            .is_err()
    );
}

#[test]
fn radar_lane_cleanup_removes_legacy_and_only_prunes_unreviewed_items() {
    let directory = TestDirectory::new("radar-cleanup");
    let database = Database::open(directory.database()).expect("open database");
    for (item_id, lane, state) in [
        ("legacy-star", "my_stars", "new"),
        ("old-trending", "trending", "new"),
        ("saved-trending", "trending", "read_later"),
    ] {
        database
            .upsert_radar(NewRadarRecord {
                item_id,
                lane,
                title: item_id,
                source: "fixture",
                url: "https://example.com/radar",
                summary: "fixture",
                score: 1.0,
                stars_total: None,
                published_at: None,
                state,
                data_class: "public",
                occurred_at: "2026-08-08T00:00:00Z",
            })
            .expect("store Radar fixture");
    }

    assert_eq!(
        database
            .delete_radar_lane("my_stars")
            .expect("legacy cleanup"),
        1
    );
    assert_eq!(
        database
            .delete_new_radar_lane("trending")
            .expect("fresh feed cleanup"),
        1
    );
    let remaining = database.radar_items(10, 0).expect("remaining Radar items");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].item_id, "saved-trending");
}

#[test]
fn radar_accepts_verified_x_evidence_and_preserves_saved_topics() {
    let directory = TestDirectory::new("radar-x-evidence");
    let database = Database::open(directory.database()).expect("open database");
    let stored = database
        .upsert_radar(NewRadarRecord {
            item_id: "x-2082263717916586117",
            lane: "x",
            title: "@OpenAI",
            source: "X · independently verified",
            url: "https://x.com/OpenAI/status/2082263717916586117",
            summary: "We quietly released the open-source Codex Security CLI.",
            score: 1_785_000_000.0,
            stars_total: None,
            published_at: Some("2026-07-29T00:35:31Z"),
            state: "new",
            data_class: "public",
            occurred_at: "2026-08-23T00:00:00Z",
        })
        .expect("store verified X evidence");

    assert_eq!(stored.lane, "x");
    let saved = database
        .update_radar_state(&stored.item_id, "topic", "2026-08-23T00:01:00Z")
        .expect("save topic");
    assert_eq!(saved.state, "topic");
    assert_eq!(
        database
            .delete_stale_new_radar_lane("x", "2026-08-23T00:02:00Z")
            .expect("prune stale X candidates"),
        0,
        "saved topics must survive a Radar refresh",
    );
}

#[test]
fn radar_star_history_reports_only_real_daily_and_weekly_deltas() {
    let directory = TestDirectory::new("radar-star-history");
    let database = Database::open(directory.database()).expect("open database");
    let store = |stars_total, occurred_at| {
        database
            .upsert_radar(NewRadarRecord {
                item_id: "github-project",
                lane: "trending",
                title: "example/project",
                source: "github",
                url: "https://github.com/example/project",
                summary: "fixture",
                score: stars_total as f64,
                stars_total: Some(stars_total),
                published_at: None,
                state: "new",
                data_class: "public",
                occurred_at,
            })
            .expect("store Radar snapshot")
    };

    let first = store(100, "2026-08-01T00:00:00Z");
    assert_eq!(first.stars_total, Some(100));
    assert_eq!(first.stars_daily, None);
    assert_eq!(first.stars_weekly, None);

    let second = store(112, "2026-08-02T00:00:00Z");
    assert_eq!(second.stars_daily, Some(12));
    assert_eq!(second.stars_weekly, None);

    let eighth = store(180, "2026-08-08T00:00:00Z");
    assert_eq!(eighth.stars_daily, None);
    assert_eq!(eighth.stars_weekly, Some(80));
}

#[test]
fn local_todos_are_editable_and_soft_deleted() {
    let directory = TestDirectory::new("local-todos");
    let database = Database::open(directory.database()).expect("open database");
    let created = database
        .put_local_todo(
            NewLocalTodo {
                task_id: "todo-local-1",
                title: "Review the experiment",
                details: "Check the two failed cases.",
                priority: Some("P1"),
                due_at: Some("2026-08-09T00:00:00Z"),
                status: "open",
                origin: "user",
                occurred_at: "2026-08-08T09:00:00Z",
            },
            None,
        )
        .expect("create local Todo");
    assert_eq!(database.local_todo_count().expect("count Todos"), 1);
    let updated = database
        .put_local_todo(
            NewLocalTodo {
                task_id: &created.task_id,
                title: "Review the experiment results",
                details: "Check the two failed cases.",
                priority: Some("P0"),
                due_at: created.due_at.as_deref(),
                status: "completed",
                origin: &created.origin,
                occurred_at: "2026-08-08T10:00:00Z",
            },
            Some(&created.updated_at),
        )
        .expect("edit local Todo");
    assert_eq!(updated.status, "completed");
    assert_eq!(updated.priority.as_deref(), Some("P0"));

    database
        .delete_local_todo(&updated.task_id, &updated.updated_at)
        .expect("soft delete local Todo");
    assert_eq!(database.local_todo_count().expect("count Todos"), 0);
    assert!(database.local_todos(10, 0).expect("list Todos").is_empty());
    let deleted = database
        .deleted_local_todos(10, 0)
        .expect("list deleted Todos");
    assert_eq!(deleted.len(), 1);
    assert!(deleted[0].deleted_at.is_some());
    let connection = Connection::open(directory.database()).expect("inspect database");
    let deleted_at: Option<String> = connection
        .query_row(
            "SELECT deleted_at FROM local_todos WHERE task_id='todo-local-1'",
            [],
            |row| row.get(0),
        )
        .expect("soft-deleted row remains");
    assert!(deleted_at.is_some());
    drop(connection);

    let restored = database
        .restore_local_todo(&deleted[0].task_id, &deleted[0].updated_at)
        .expect("restore local Todo");
    assert_eq!(restored.title, "Review the experiment results");
    assert!(restored.deleted_at.is_none());
    assert_eq!(database.local_todo_count().expect("count restored"), 1);
    assert_eq!(database.local_todos(10, 0).expect("list restored").len(), 1);
}
