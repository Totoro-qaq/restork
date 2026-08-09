CREATE TABLE local_todos (
    task_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    priority TEXT CHECK (priority IS NULL OR priority IN ('P0', 'P1', 'P2', 'P3')),
    due_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
    origin TEXT NOT NULL CHECK (origin IN ('user', 'model')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE INDEX local_todos_status_updated
    ON local_todos (deleted_at, status, updated_at DESC, task_id);
