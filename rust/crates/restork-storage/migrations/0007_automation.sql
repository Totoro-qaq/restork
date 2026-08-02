CREATE TABLE recovery_checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    run_id TEXT,
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    manifest_hash TEXT NOT NULL,
    total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
    created_at TEXT NOT NULL,
    expires_at TEXT
);

CREATE INDEX recovery_checkpoints_page
    ON recovery_checkpoints (created_at DESC, checkpoint_id DESC);

CREATE TABLE schedules (
    schedule_id TEXT PRIMARY KEY,
    schedule_json TEXT NOT NULL CHECK (json_valid(schedule_json)),
    revision INTEGER NOT NULL CHECK (revision > 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'paused')),
    next_run_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE INDEX schedules_due ON schedules (state, next_run_at, schedule_id);

CREATE TABLE schedule_runs (
    schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id),
    period_key TEXT NOT NULL,
    run_id TEXT,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (schedule_id, period_key)
);

CREATE TABLE evaluation_batches (
    evaluation_id TEXT PRIMARY KEY,
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    manifest_hash TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    contains_private_trajectories INTEGER NOT NULL CHECK (contains_private_trajectories IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE TABLE subtasks (
    subtask_id TEXT PRIMARY KEY,
    parent_run_id TEXT NOT NULL,
    spec_json TEXT NOT NULL CHECK (json_valid(spec_json)),
    spec_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX subtasks_parent_page ON subtasks (parent_run_id, created_at, subtask_id);
