use chrono::{Duration, Utc};
use restork_automation::{MissedRunPolicy, Recurrence, ScheduleJob, ScheduleSpec};
use restork_storage::Database;
use restorkd::run_due_schedules_once;

struct TestDirectory(tempfile::TempDir);

impl TestDirectory {
    fn new() -> Self {
        Self(tempfile::tempdir().expect("temporary directory"))
    }
}

#[tokio::test]
async fn due_jobs_are_idempotent_advanced_and_never_gain_an_external_effect() {
    let directory = TestDirectory::new();
    let storage = Database::open(directory.0.path().join("restork.db")).expect("database");
    let now = Utc::now();
    let schedule = ScheduleSpec::new(
        "schedule-health",
        "UTC",
        Recurrence::Daily { hour: 9, minute: 0 },
        MissedRunPolicy::CreateDraft,
        ScheduleJob::Deterministic {
            job: "health.check".into(),
        },
    )
    .expect("schedule");
    storage
        .put_schedule(
            &schedule.schedule_id,
            &serde_json::to_value(&schedule).expect("json"),
            None,
            "active",
            Some(&(now - Duration::minutes(1)).to_rfc3339()),
            &(now - Duration::minutes(2)).to_rfc3339(),
        )
        .expect("store schedule");

    assert_eq!(
        run_due_schedules_once(&storage, now)
            .await
            .expect("scheduler"),
        1
    );
    assert_eq!(
        run_due_schedules_once(&storage, now)
            .await
            .expect("replay pass"),
        0
    );
    let period_key = format!("scheduled:{}", (now - Duration::minutes(1)).timestamp());
    let run = storage
        .schedule_run("schedule-health", &period_key)
        .expect("lookup")
        .expect("run");
    assert_eq!(run.result["state"], "completed");
    assert_eq!(run.result["external_effect"], false);
    let updated = storage
        .schedule("schedule-health")
        .expect("lookup")
        .expect("schedule");
    assert_eq!(updated.state, "active");
    assert!(updated.next_run_at.expect("next") > now.to_rfc3339());
}
