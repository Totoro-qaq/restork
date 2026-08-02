use std::{fs, path::PathBuf};

use restork_storage::Database;
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
