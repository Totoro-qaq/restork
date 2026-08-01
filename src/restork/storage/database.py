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
