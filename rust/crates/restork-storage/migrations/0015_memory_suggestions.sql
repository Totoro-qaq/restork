CREATE TABLE IF NOT EXISTS memory_suggestions (
    suggestion_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL CHECK (mode IN ('research', 'study', 'work')),
    summary TEXT NOT NULL,
    data_class TEXT NOT NULL CHECK (data_class IN ('public', 'personal', 'confidential')),
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'dismissed', 'expired')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    accepted_memory_id TEXT
);

CREATE INDEX memory_suggestions_pending
    ON memory_suggestions (status, expires_at, created_at DESC);
