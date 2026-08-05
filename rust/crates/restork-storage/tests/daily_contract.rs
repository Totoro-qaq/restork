use restork_storage::{CalendarIntervalRecord, Database};
use rusqlite::Connection;
use serde_json::json;

struct TestDirectory(tempfile::TempDir);

impl TestDirectory {
    fn new() -> Self {
        Self(tempfile::tempdir().expect("temporary directory"))
    }
}

#[test]
fn optional_daily_sources_are_explicit_bounded_and_clearable() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.path().join("restork.db")).expect("database");
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
        .put_music_snapshot(
            "playlist",
            &json!({"items": [{"item_id": "track-2", "title": "Atomic Song"}]}),
            &json!({"explicit": true, "read_only": true}),
            &json!({"provider": "qqmusic", "playlist_id": "1234567890"}),
            "2026-08-02T12:01:00Z",
        )
        .expect("atomic music snapshot");
    assert_eq!(
        database
            .music_preferences()
            .expect("playlist")
            .expect("stored playlist")
            .preference["items"][0]["title"],
        "Atomic Song"
    );
    let music_source = database
        .daily_source("music")
        .expect("music source")
        .expect("enabled music source");
    assert!(music_source.enabled);
    assert_eq!(music_source.config["provider"], "qqmusic");

    let mail = database
        .put_daily_source(
            "mail",
            true,
            &json!({
                "explicit": true,
                "detail_scope": "unread_count",
                "content_access": false
            }),
            &json!({"refresh_interval_seconds": 15, "read_only": true}),
            "2026-08-02T12:02:00Z",
        )
        .expect("mail source");
    assert!(mail.enabled);
    assert_eq!(mail.consent["detail_scope"], "unread_count");
    assert!(mail.config.get("unread_count").is_none());

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

#[test]
fn mail_source_migration_preserves_existing_daily_configuration() {
    let directory = TestDirectory::new();
    let connection =
        Connection::open(directory.0.path().join("migration.db")).expect("migration database");
    connection
        .execute_batch(
            "CREATE TABLE daily_source_settings (\
                source TEXT PRIMARY KEY CHECK (source IN ('calendar', 'weather', 'music')),\
                enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),\
                consent_json TEXT NOT NULL CHECK (json_valid(consent_json)),\
                config_json TEXT NOT NULL CHECK (json_valid(config_json)),\
                updated_at TEXT NOT NULL\
            );\
            INSERT INTO daily_source_settings VALUES (\
                'weather', 1, '{\"explicit\":true}', '{\"label\":\"Synthetic City\"}',\
                '2026-08-02T12:00:00Z'\
            );",
        )
        .expect("legacy daily source");
    connection
        .execute_batch(include_str!("../migrations/0011_mail_awareness.sql"))
        .expect("mail migration");
    let label: String = connection
        .query_row(
            "SELECT json_extract(config_json, '$.label') FROM daily_source_settings WHERE source = 'weather'",
            [],
            |row| row.get(0),
        )
        .expect("preserved weather source");
    assert_eq!(label, "Synthetic City");
    connection
        .execute(
            "INSERT INTO daily_source_settings VALUES ('mail', 1, '{}', '{}', ?1)",
            ["2026-08-02T12:01:00Z"],
        )
        .expect("mail source accepted");
    assert!(
        connection
            .execute(
                "INSERT INTO daily_source_settings VALUES ('private-inbox', 1, '{}', '{}', ?1)",
                ["2026-08-02T12:02:00Z"],
            )
            .is_err()
    );
}
