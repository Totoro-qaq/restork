"""SQLite connection and idempotent schema initialization."""

from __future__ import annotations

import sqlite3
from pathlib import Path


def connect(path: Path) -> sqlite3.Connection:
    # API handlers may run in a worker thread; stores still serialize mutations with SQLite.
    connection = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS events (
            event_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            seq INTEGER NOT NULL CHECK (seq > 0),
            occurred_at TEXT NOT NULL,
            kind TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            UNIQUE (run_id, seq)
        );

        CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            task_spec_json TEXT,
            mode TEXT NOT NULL,
            state TEXT NOT NULL,
            state_version INTEGER NOT NULL CHECK (state_version >= 0),
            stop_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            schema_version INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS approvals (
            approval_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            decision TEXT NOT NULL,
            request_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS effect_intents (
            intent_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            phase TEXT NOT NULL,
            retry_contract TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS event_snapshots (
            run_id TEXT PRIMARY KEY,
            covered_seq INTEGER NOT NULL CHECK (covered_seq >= 0),
            snapshot_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS idempotency_records (
            operation TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            response_json TEXT NOT NULL,
            PRIMARY KEY (operation, idempotency_key)
        );

        CREATE TABLE IF NOT EXISTS transient_blobs (
            blob_id TEXT PRIMARY KEY,
            run_id TEXT,
            source_id TEXT,
            expires_at TEXT NOT NULL,
            payload BLOB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS run_budgets (
            run_id TEXT PRIMARY KEY,
            budget_json TEXT NOT NULL,
            started_at TEXT NOT NULL,
            steps INTEGER NOT NULL DEFAULT 0,
            retries INTEGER NOT NULL DEFAULT 0,
            tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL NOT NULL DEFAULT 0,
            child_tasks INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS run_checkpoints (
            run_id TEXT PRIMARY KEY,
            phase TEXT NOT NULL,
            blob_ref TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS memory_records (
            memory_id TEXT PRIMARY KEY,
            layer TEXT NOT NULL CHECK (layer = 'episodic'),
            kind TEXT NOT NULL,
            summary TEXT NOT NULL,
            provenance TEXT NOT NULL,
            data_class TEXT NOT NULL CHECK (data_class NOT IN ('secret', 'credential')),
            retention_class TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            expires_at TEXT,
            last_accessed_at TEXT,
            run_id TEXT,
            source_id TEXT,
            content_hash TEXT NOT NULL,
            version INTEGER NOT NULL CHECK (version > 0)
        );

        CREATE INDEX IF NOT EXISTS memory_records_source_id
            ON memory_records (source_id);
        CREATE INDEX IF NOT EXISTS memory_records_retention
            ON memory_records (retention_class, expires_at, last_accessed_at);

        CREATE TABLE IF NOT EXISTS radar_items (
            item_id TEXT PRIMARY KEY,
            lane TEXT NOT NULL,
            title TEXT NOT NULL,
            source TEXT NOT NULL,
            url TEXT NOT NULL,
            summary TEXT NOT NULL,
            score REAL NOT NULL,
            published_at TEXT,
            state TEXT NOT NULL,
            data_class TEXT NOT NULL CHECK (data_class NOT IN ('secret', 'credential')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS radar_items_lane_state
            ON radar_items (lane, state, score, published_at);

        CREATE TABLE IF NOT EXISTS task_write_previews (
            approval_id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            binding TEXT NOT NULL,
            task_id TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            operation TEXT NOT NULL,
            request_json TEXT NOT NULL,
            before_line TEXT NOT NULL,
            after_line TEXT NOT NULL,
            expected_hash TEXT NOT NULL,
            postimage_hash TEXT NOT NULL,
            action_digest TEXT NOT NULL,
            policy_version TEXT NOT NULL,
            nonce TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS task_write_previews_expiry
            ON task_write_previews (expires_at);

        CREATE TABLE IF NOT EXISTS daily_cache (
            cache_key TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS daily_cache_expiry
            ON daily_cache (expires_at);

        CREATE TABLE IF NOT EXISTS research_artifacts (
            artifact_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL UNIQUE,
            artifact_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS research_artifacts_created
            ON research_artifacts (created_at, artifact_id);

        CREATE TABLE IF NOT EXISTS study_sessions (
            run_id TEXT PRIMARY KEY,
            request_hash TEXT NOT NULL,
            request_json TEXT NOT NULL,
            diagnostic_json TEXT NOT NULL,
            diagnostic_submission_hash TEXT,
            artifact_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS study_exercise_rubrics (
            exercise_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            required_terms_json TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES study_sessions (run_id)
        );

        CREATE INDEX IF NOT EXISTS study_exercise_rubrics_run
            ON study_exercise_rubrics (run_id);

        CREATE TABLE IF NOT EXISTS study_attempts (
            attempt_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            exercise_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            binding TEXT NOT NULL,
            answer_hash TEXT NOT NULL,
            correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
            result_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES study_sessions (run_id)
        );

        CREATE INDEX IF NOT EXISTS study_attempts_run_exercise
            ON study_attempts (run_id, exercise_id, created_at);

        CREATE TABLE IF NOT EXISTS study_review_state (
            run_id TEXT NOT NULL,
            exercise_id TEXT NOT NULL,
            due_at TEXT NOT NULL,
            interval_days INTEGER NOT NULL CHECK (interval_days >= 0),
            error_count INTEGER NOT NULL CHECK (error_count >= 0),
            successful_count INTEGER NOT NULL CHECK (successful_count >= 0),
            updated_at TEXT NOT NULL,
            PRIMARY KEY (run_id, exercise_id),
            FOREIGN KEY (run_id) REFERENCES study_sessions (run_id)
        );
        """
    )
    try:
        connection.execute("BEGIN IMMEDIATE")
        transient_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(transient_blobs)")
        }
        if "run_id" not in transient_columns:
            connection.execute("ALTER TABLE transient_blobs ADD COLUMN run_id TEXT")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS transient_blobs_run_id ON transient_blobs (run_id)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS transient_blobs_source_id ON transient_blobs (source_id)"
        )
        run_columns = {row["name"] for row in connection.execute("PRAGMA table_info(runs)")}
        if "task_spec_json" not in run_columns:
            connection.execute("ALTER TABLE runs ADD COLUMN task_spec_json TEXT")
    except BaseException:
        connection.execute("ROLLBACK")
        raise
    else:
        connection.execute("COMMIT")
