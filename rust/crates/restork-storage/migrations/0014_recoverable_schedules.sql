ALTER TABLE schedules ADD COLUMN deleted_at TEXT;

CREATE INDEX schedules_active_page
    ON schedules (deleted_at, updated_at DESC, schedule_id DESC);

CREATE INDEX schedule_runs_page
    ON schedule_runs (schedule_id, created_at DESC, period_key DESC);
