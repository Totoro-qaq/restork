"""SQLite connection and idempotent schema initialization."""

from __future__ import annotations

import sqlite3
from pathlib import Path


def connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path, isolation_level=None)
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
        """
    )
