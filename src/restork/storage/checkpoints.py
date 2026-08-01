"""Encrypted, expiring restart checkpoints for the agent loop."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, model_validator

from restork.contracts.approval import ApprovalRequest
from restork.contracts.types import DataClass
from restork.providers.base import ChatMessage, ToolCall
from restork.storage.database import connect, initialize
from restork.storage.transient_blobs import TransientBlobStore

CheckpointPhase = Literal["model", "tool", "approval"]


class LoopCheckpoint(BaseModel):
    """Sensitive loop state; the serialized body is never stored in plaintext."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    phase: CheckpointPhase
    messages: tuple[ChatMessage, ...]
    pending_tool_call: ToolCall | None = None
    intent_id: str | None = None
    approval: ApprovalRequest | None = None
    artifacts: tuple[str, ...] = ()

    @model_validator(mode="after")
    def require_phase_payload(self) -> LoopCheckpoint:
        if self.phase == "model" and any(
            value is not None
            for value in (self.pending_tool_call, self.intent_id, self.approval)
        ):
            raise ValueError("model checkpoint cannot carry a pending action")
        if self.phase in {"tool", "approval"} and (
            self.pending_tool_call is None or self.intent_id is None
        ):
            raise ValueError("action checkpoint requires a tool call and intent")
        if self.phase == "approval" and self.approval is None:
            raise ValueError("approval checkpoint requires an approval request")
        if self.phase == "tool" and self.approval is not None:
            raise ValueError("tool checkpoint cannot carry an unconsumed approval")
        return self


class SQLiteCheckpointStore:
    def __init__(
        self,
        connection: sqlite3.Connection,
        blobs: TransientBlobStore,
        *,
        ttl_seconds: int = 3600,
    ) -> None:
        if ttl_seconds < 1:
            raise ValueError("checkpoint TTL must be positive")
        self._connection = connection
        self._blobs = blobs
        self._ttl = timedelta(seconds=ttl_seconds)

    @classmethod
    def create(
        cls,
        path: Path,
        blobs: TransientBlobStore,
        *,
        ttl_seconds: int = 3600,
    ) -> SQLiteCheckpointStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection, blobs, ttl_seconds=ttl_seconds)

    def save(self, run_id: str, checkpoint: LoopCheckpoint) -> None:
        blob_ref = f"checkpoint-{uuid4()}"
        self._blobs.put(
            blob_ref,
            checkpoint.model_dump_json().encode(),
            expires_at=datetime.now(UTC) + self._ttl,
            data_class=DataClass.CONFIDENTIAL,
            run_id=run_id,
        )
        previous = self._connection.execute(
            "SELECT blob_ref FROM run_checkpoints WHERE run_id = ?", (run_id,)
        ).fetchone()
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            self._connection.execute(
                """
                INSERT INTO run_checkpoints (run_id, phase, blob_ref, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(run_id) DO UPDATE SET
                    phase = excluded.phase,
                    blob_ref = excluded.blob_ref,
                    updated_at = excluded.updated_at
                """,
                (run_id, checkpoint.phase, blob_ref, datetime.now(UTC).isoformat()),
            )
        except BaseException:
            self._connection.execute("ROLLBACK")
            self._blobs.delete(blob_ref)
            raise
        else:
            self._connection.execute("COMMIT")
        if previous is not None and previous["blob_ref"] != blob_ref:
            self._blobs.delete(previous["blob_ref"])

    def load(self, run_id: str) -> LoopCheckpoint | None:
        row = self._connection.execute(
            "SELECT blob_ref FROM run_checkpoints WHERE run_id = ?", (run_id,)
        ).fetchone()
        if row is None:
            return None
        payload = self._blobs.get(row["blob_ref"])
        if payload is None:
            self._connection.execute(
                "DELETE FROM run_checkpoints WHERE run_id = ?", (run_id,)
            )
            raise ValueError("run checkpoint expired or was deleted")
        return LoopCheckpoint.model_validate_json(payload)

    def delete(self, run_id: str) -> None:
        row = self._connection.execute(
            "SELECT blob_ref FROM run_checkpoints WHERE run_id = ?", (run_id,)
        ).fetchone()
        self._connection.execute("DELETE FROM run_checkpoints WHERE run_id = ?", (run_id,))
        if row is not None:
            self._blobs.delete(row["blob_ref"])
