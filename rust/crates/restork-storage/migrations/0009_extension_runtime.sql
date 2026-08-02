CREATE TABLE extension_package_revisions (
    package_id TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    package_kind TEXT NOT NULL CHECK (package_kind IN ('skill', 'mcp', 'plugin')),
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    state TEXT NOT NULL CHECK (state IN ('quarantined', 'enabled', 'disabled', 'superseded')),
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (package_id, manifest_hash)
);

INSERT INTO extension_package_revisions
    (package_id, manifest_hash, package_kind, manifest_json, state, installed_at, updated_at)
SELECT package_id, manifest_hash, package_kind, manifest_json, state, installed_at, updated_at
FROM extension_packages;

CREATE INDEX extension_revision_history
    ON extension_package_revisions (package_id, installed_at DESC, manifest_hash DESC);

CREATE TABLE mcp_executions (
    execution_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    idempotency_key TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    package_id TEXT NOT NULL,
    package_hash TEXT NOT NULL,
    catalog_fingerprint TEXT NOT NULL,
    call_digest TEXT NOT NULL,
    resolved_call_json TEXT NOT NULL CHECK (json_valid(resolved_call_json)),
    state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled')),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    error_code TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (session_id, idempotency_key)
);

CREATE INDEX mcp_execution_history
    ON mcp_executions (session_id, started_at DESC, execution_id DESC);
