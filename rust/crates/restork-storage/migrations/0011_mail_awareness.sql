ALTER TABLE daily_source_settings RENAME TO daily_source_settings_before_mail;

CREATE TABLE daily_source_settings (
    source TEXT PRIMARY KEY CHECK (source IN ('calendar', 'weather', 'music', 'mail')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    consent_json TEXT NOT NULL CHECK (json_valid(consent_json)),
    config_json TEXT NOT NULL CHECK (json_valid(config_json)),
    updated_at TEXT NOT NULL
);

INSERT INTO daily_source_settings (source, enabled, consent_json, config_json, updated_at)
SELECT source, enabled, consent_json, config_json, updated_at
FROM daily_source_settings_before_mail;

DROP TABLE daily_source_settings_before_mail;
