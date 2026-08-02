use std::{fs, path::PathBuf, sync::Arc, thread};

use restork_storage::{Database, NewEvent, NewRun};
use rusqlite::Connection;
use serde_json::json;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new(label: &str) -> Self {
        let mut suffix = [0_u8; 12];
        getrandom::fill(&mut suffix).expect("test entropy");
        let suffix = suffix
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = std::env::temp_dir().join(format!("restork-{label}-{suffix}"));
        fs::create_dir(&path).expect("create test directory");
        Self(path)
    }

    fn database(&self) -> PathBuf {
        self.0.join("restork.db")
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn rust_database_creates_the_frozen_v1_tables_and_migration_ledger() {
    let directory = TestDirectory::new("schema");
    let database = Database::open(directory.database()).expect("open database");

    assert_eq!(database.schema_version().expect("schema version"), 7);
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
        "schema_migrations",
    ] {
        assert!(tables.contains(required), "missing {required}");
    }
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
    assert_eq!(reopened.migration_history().expect("history").len(), 7);
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
