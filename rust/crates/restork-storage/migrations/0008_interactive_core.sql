CREATE TABLE context_previews (
    preview_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL UNIQUE,
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    data_class TEXT NOT NULL,
    byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
    estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_operation_id TEXT
);

CREATE INDEX context_previews_expiry ON context_previews (expires_at, preview_id);

CREATE TABLE conversation_operations (
    operation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL UNIQUE,
    user_message_id TEXT NOT NULL UNIQUE REFERENCES session_messages(message_id) ON DELETE CASCADE,
    assistant_message_id TEXT REFERENCES session_messages(message_id) ON DELETE SET NULL,
    state TEXT NOT NULL CHECK (state IN (
        'queued', 'preparing', 'streaming', 'validating', 'cancel_requested',
        'completed', 'cancelled', 'failed'
    )),
    phase TEXT NOT NULL,
    context_preview_hash TEXT,
    provider_binding_json TEXT NOT NULL CHECK (json_valid(provider_binding_json)),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX conversation_operations_session
    ON conversation_operations (session_id, created_at DESC, operation_id DESC);
CREATE INDEX conversation_operations_state
    ON conversation_operations (state, updated_at, operation_id);

CREATE TABLE operation_events (
    operation_id TEXT NOT NULL REFERENCES conversation_operations(operation_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    occurred_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    PRIMARY KEY (operation_id, sequence)
);

CREATE TABLE native_calendar_connections (
    connection_id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    backend TEXT NOT NULL,
    state TEXT NOT NULL,
    detail_scope TEXT NOT NULL,
    config_json TEXT NOT NULL CHECK (json_valid(config_json)),
    updated_at TEXT NOT NULL
);
