use std::{fs, path::PathBuf};

use restork_storage::{CalendarIntervalRecord, Database};
use serde_json::json;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let mut suffix = [0_u8; 12];
        getrandom::fill(&mut suffix).expect("test entropy");
        let name = suffix
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = std::env::temp_dir().join(format!("restork-daily-storage-{name}"));
        fs::create_dir(&path).expect("test directory");
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn optional_daily_sources_are_explicit_bounded_and_clearable() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.join("restork.db")).expect("database");
    assert!(database.daily_source("weather").expect("source").is_none());

    let weather = database
        .put_daily_source(
            "weather",
            true,
            &json!({"mode": "manual_query", "explicit": true}),
            &json!({"label": "Synthetic City", "latitude": 0.0, "longitude": 0.0}),
            "2026-08-02T12:00:00Z",
        )
        .expect("weather source");
    assert!(weather.enabled);
    assert_eq!(weather.config["label"], "Synthetic City");

    database
        .replace_calendar_intervals(&[CalendarIntervalRecord {
            interval_id: "calendar-fixture".to_owned(),
            starts_at: "2026-08-03T01:00:00Z".to_owned(),
            ends_at: "2026-08-03T02:00:00Z".to_owned(),
            availability: "busy".to_owned(),
            details: json!({"title": "Busy", "all_day": false, "redacted": true}),
            source_kind: "ics".to_owned(),
            source_revision: "fixture".to_owned(),
            observed_at: "2026-08-02T12:00:00Z".to_owned(),
        }])
        .expect("calendar import");
    let intervals = database
        .calendar_intervals_after("2026-08-02T00:00:00Z", 10)
        .expect("calendar page");
    assert_eq!(intervals.len(), 1);
    assert_eq!(intervals[0].details["title"], "Busy");

    database
        .put_music_preferences(
            "playlist",
            &json!({"items": [{"item_id": "track-1", "title": "Synthetic Song"}]}),
            "2026-08-02T12:00:00Z",
        )
        .expect("playlist");
    assert!(database.music_preferences().expect("playlist").is_some());
    database.clear_music_preferences().expect("clear playlist");
    assert!(database.music_preferences().expect("playlist").is_none());

    database
        .put_daily_cache(
            "weather-current",
            &json!({"configured": true}),
            "2026-08-02T12:00:00Z",
            "2026-08-02T12:15:00Z",
            "2026-08-02T12:00:00Z",
        )
        .expect("cache");
    assert!(
        database
            .daily_cache("weather-current")
            .expect("cache")
            .is_some()
    );
    database
        .clear_daily_cache("weather-current")
        .expect("clear cache");
    assert!(
        database
            .daily_cache("weather-current")
            .expect("cache")
            .is_none()
    );
}
