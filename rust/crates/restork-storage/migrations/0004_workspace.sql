CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    version INTEGER NOT NULL CHECK (version > 0),
    locale TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
);

CREATE INDEX sessions_updated ON sessions (updated_at DESC, session_id DESC);

CREATE TABLE session_messages (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    context_json TEXT NOT NULL CHECK (json_valid(context_json)),
    data_class TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (session_id, sequence)
);

CREATE INDEX session_messages_page ON session_messages (session_id, sequence DESC);

CREATE VIRTUAL TABLE session_messages_fts USING fts5(
    content,
    content='session_messages',
    content_rowid='rowid',
    tokenize='unicode61'
);

CREATE TRIGGER session_messages_ai AFTER INSERT ON session_messages BEGIN
    INSERT INTO session_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER session_messages_ad AFTER DELETE ON session_messages BEGIN
    INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER session_messages_au AFTER UPDATE ON session_messages BEGIN
    INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
    INSERT INTO session_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE configuration_profiles (
    profile_id TEXT PRIMARY KEY,
    profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
    revision INTEGER NOT NULL CHECK (revision > 0),
    builtin INTEGER NOT NULL CHECK (builtin IN (0, 1)),
    updated_at TEXT NOT NULL
);

CREATE TABLE provider_profiles (
    provider_id TEXT PRIMARY KEY,
    provider_json TEXT NOT NULL CHECK (json_valid(provider_json)),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TEXT NOT NULL
);

CREATE TABLE prompt_revisions (
    prompt_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    prompt_json TEXT NOT NULL CHECK (json_valid(prompt_json)),
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (prompt_id, version)
);

CREATE TABLE active_prompts (
    prompt_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    activated_at TEXT NOT NULL,
    FOREIGN KEY (prompt_id, version) REFERENCES prompt_revisions(prompt_id, version)
);

CREATE TABLE diagnostic_runs (
    diagnostic_id TEXT PRIMARY KEY,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    redacted INTEGER NOT NULL CHECK (redacted = 1),
    created_at TEXT NOT NULL
);

CREATE TABLE runtime_metrics (
    metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT,
    metric_name TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    observed_at TEXT NOT NULL
);

CREATE INDEX runtime_metrics_page ON runtime_metrics (observed_at DESC, metric_id DESC);
