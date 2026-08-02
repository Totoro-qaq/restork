use std::{fs, path::PathBuf};

use chrono::{Duration, Utc};
use restork_automation::{MissedRunPolicy, Recurrence, ScheduleJob, ScheduleSpec};
use restork_storage::Database;
use restorkd::run_due_schedules_once;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let mut suffix = [0_u8; 12];
        getrandom::fill(&mut suffix).expect("entropy");
        let path = std::env::temp_dir().join(format!(
            "restork-scheduler-{}",
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
fn due_jobs_are_idempotent_advanced_and_never_gain_an_external_effect() {
    let directory = TestDirectory::new();
    let storage = Database::open(directory.0.join("restork.db")).expect("database");
    let now = Utc::now();
    let schedule = ScheduleSpec::new(
        "schedule-draft",
        "UTC",
        Recurrence::Daily { hour: 9, minute: 0 },
        MissedRunPolicy::CreateDraft,
        ScheduleJob::ModelDraft {
            profile_id: "research-cloud".into(),
            requested_effect: None,
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

    assert_eq!(run_due_schedules_once(&storage, now).expect("scheduler"), 1);
    assert_eq!(
        run_due_schedules_once(&storage, now).expect("replay pass"),
        0
    );
    let period_key = format!("scheduled:{}", (now - Duration::minutes(1)).timestamp());
    let run = storage
        .schedule_run("schedule-draft", &period_key)
        .expect("lookup")
        .expect("run");
    assert_eq!(run.result["state"], "draft_created");
    assert_eq!(run.result["external_effect"], false);
    let updated = storage
        .schedule("schedule-draft")
        .expect("lookup")
        .expect("schedule");
    assert_eq!(updated.state, "active");
    assert!(updated.next_run_at.expect("next") > now.to_rfc3339());
}
