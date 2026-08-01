"""Helpers for transaction-local idempotency records."""

from __future__ import annotations

import hashlib
import json
import sqlite3


def mutation_binding(*parts: str) -> str:
    """Return an opaque binding for the exact mutation inputs."""
    encoded = json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def load_idempotent_response(
    connection: sqlite3.Connection,
    *,
    operation: str,
    idempotency_key: str,
    binding: str,
) -> str | None:
    if not idempotency_key:
        raise ValueError("Idempotency-Key is required")
    record = connection.execute(
        """
        SELECT resource_id, response_json FROM idempotency_records
        WHERE operation = ? AND idempotency_key = ?
        """,
        (operation, idempotency_key),
    ).fetchone()
    if record is None:
        return None
    if record["resource_id"] != binding:
        raise ValueError("Idempotency-Key is already bound to another mutation")
    return str(record["response_json"])


def save_idempotent_response(
    connection: sqlite3.Connection,
    *,
    operation: str,
    idempotency_key: str,
    binding: str,
    response_json: str,
) -> None:
    connection.execute(
        """
        INSERT INTO idempotency_records
            (operation, idempotency_key, resource_id, response_json)
        VALUES (?, ?, ?, ?)
        """,
        (operation, idempotency_key, binding, response_json),
    )
