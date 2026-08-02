CREATE TABLE extension_packages (
    package_id TEXT PRIMARY KEY,
    package_kind TEXT NOT NULL CHECK (package_kind IN ('skill', 'mcp', 'plugin')),
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    manifest_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('quarantined', 'enabled', 'disabled')),
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX extension_packages_page ON extension_packages (updated_at DESC, package_id DESC);

CREATE TABLE extension_audit_events (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id TEXT NOT NULL REFERENCES extension_packages(package_id),
    event_kind TEXT NOT NULL,
    detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
    occurred_at TEXT NOT NULL
);

CREATE INDEX extension_audit_page
    ON extension_audit_events (package_id, audit_id DESC);
