CREATE TABLE personal_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
    version INTEGER NOT NULL CHECK (version > 0),
    updated_at TEXT NOT NULL
);

CREATE TABLE daily_source_settings (
    source TEXT PRIMARY KEY CHECK (source IN ('calendar', 'weather', 'music')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    consent_json TEXT NOT NULL CHECK (json_valid(consent_json)),
    config_json TEXT NOT NULL CHECK (json_valid(config_json)),
    updated_at TEXT NOT NULL
);

CREATE TABLE calendar_intervals (
    interval_id TEXT PRIMARY KEY,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    availability TEXT NOT NULL,
    details_json TEXT NOT NULL CHECK (json_valid(details_json)),
    source_kind TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    observed_at TEXT NOT NULL
);

CREATE INDEX calendar_intervals_start ON calendar_intervals (starts_at, interval_id);

CREATE TABLE music_preferences (
    preference_id TEXT PRIMARY KEY,
    preference_json TEXT NOT NULL CHECK (json_valid(preference_json)),
    imported_at TEXT NOT NULL
);
