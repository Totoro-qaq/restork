use restork_storage::{Database, NewRun};
use serde_json::json;

#[test]
fn completed_run_fact_comes_from_durable_run_history() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = Database::open(directory.path().join("restork.db")).expect("open database");
    let task_spec = json!({"goal": "learn the workflow"});

    assert!(!database.has_completed_run().expect("empty history"));

    database
        .create_run(NewRun {
            run_id: "run-proposed",
            task_id: "task-proposed",
            task_spec: &task_spec,
            mode: "research",
            state: "proposed",
            occurred_at: "2026-08-11T00:00:00Z",
        })
        .expect("create proposed run");
    assert!(!database.has_completed_run().expect("proposed history"));

    database
        .create_run(NewRun {
            run_id: "run-completed",
            task_id: "task-completed",
            task_spec: &task_spec,
            mode: "study",
            state: "completed",
            occurred_at: "2026-08-11T00:01:00Z",
        })
        .expect("create completed run");
    assert!(database.has_completed_run().expect("completed history"));
}
