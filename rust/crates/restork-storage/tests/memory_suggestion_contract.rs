use restork_storage::{Database, NewMemorySuggestion, NewRun};
use serde_json::json;

fn open_db() -> (tempfile::TempDir, Database) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = Database::open(directory.path().join("restork.db")).expect("open database");
    (directory, database)
}

fn create_completed_run(database: &Database, run_id: &str) {
    database
        .create_run(NewRun {
            run_id,
            task_id: "task-summary",
            task_spec: &json!({"goal": "Compare two papers", "data_class": "personal"}),
            mode: "research",
            state: "completed",
            occurred_at: "2026-08-13T00:00:00Z",
        })
        .expect("create run");
}

fn suggestion<'a>(run_id: &'a str, expires_at: &'a str) -> NewMemorySuggestion<'a> {
    NewMemorySuggestion {
        suggestion_id: "run-summary-aaaaaaaaaaaaaaaaaaaaaaaa",
        run_id,
        mode: "research",
        summary: "The papers disagree on identification.",
        data_class: "personal",
        content_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        created_at: "2026-08-13T00:00:00Z",
        expires_at,
    }
}

#[test]
fn accepting_a_run_summary_writes_episodic_memory_only() {
    let (_directory, database) = open_db();
    create_completed_run(&database, "run-summary-accept");
    database
        .offer_memory_suggestion(suggestion("run-summary-accept", "2026-08-14T00:00:00Z"))
        .expect("offer");

    let before = database.memory_counts().expect("counts");
    assert_eq!(before.get("episodic").copied().unwrap_or(0), 0);
    assert_eq!(before.get("profile").copied().unwrap_or(0), 0);

    let record = database
        .accept_memory_suggestion(
            "run-summary-accept",
            "run-summary-mem-1",
            "2026-08-13T01:00:00Z",
        )
        .expect("accept");
    assert_eq!(record.layer, "episodic");
    assert_eq!(record.kind, "run_summary");
    assert_eq!(record.provenance, "user");
    assert_eq!(record.retention_class, "session");

    let after = database.memory_counts().expect("counts");
    assert_eq!(after.get("episodic").copied().unwrap_or(0), 1);
    assert_eq!(after.get("profile").copied().unwrap_or(0), 0);
    assert!(
        database
            .pending_memory_suggestion("run-summary-accept", "2026-08-13T01:00:00Z")
            .expect("pending")
            .is_none()
    );
}

#[test]
fn expired_suggestions_are_discarded_and_cannot_be_accepted() {
    let (_directory, database) = open_db();
    create_completed_run(&database, "run-summary-expire");
    database
        .offer_memory_suggestion(suggestion("run-summary-expire", "2026-08-13T00:00:00Z"))
        .expect("offer");

    assert!(
        database
            .pending_memory_suggestion("run-summary-expire", "2026-08-13T00:00:01Z")
            .expect("expired")
            .is_none()
    );
    assert!(
        database
            .accept_memory_suggestion(
                "run-summary-expire",
                "run-summary-mem-expired",
                "2026-08-13T00:00:01Z",
            )
            .is_err()
    );
    assert_eq!(
        database
            .memory_counts()
            .expect("counts")
            .get("episodic")
            .copied()
            .unwrap_or(0),
        0
    );
}

#[test]
fn dismissing_a_suggestion_does_not_create_memory() {
    let (_directory, database) = open_db();
    create_completed_run(&database, "run-summary-dismiss");
    database
        .offer_memory_suggestion(suggestion("run-summary-dismiss", "2026-08-14T00:00:00Z"))
        .expect("offer");
    database
        .dismiss_memory_suggestion("run-summary-dismiss", "2026-08-13T01:00:00Z")
        .expect("dismiss");
    assert_eq!(
        database
            .memory_counts()
            .expect("counts")
            .get("episodic")
            .copied()
            .unwrap_or(0),
        0
    );
}
