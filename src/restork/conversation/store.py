"""Parameterized SQLite persistence for idempotent run-scoped conversations."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from restork.contracts.types import DataClass, Mode
from restork.conversation.models import ConversationMessage, ConversationTurn
from restork.storage.database import connect, initialize


class SQLiteConversationStore:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def create(cls, path: Path) -> SQLiteConversationStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection)

    def begin_turn(
        self,
        *,
        run_id: str,
        mode: Mode,
        content: str,
        data_class: DataClass,
        prompt_id: str,
        prompt_version: str,
        prompt_hash: str,
        idempotency_key: str,
        binding: str,
    ) -> ConversationTurn:
        if not content.strip() or "\x00" in content or len(content) > 16_000:
            raise ValueError("conversation input must be non-empty, NUL-free, and bounded")
        if not 1 <= len(idempotency_key) <= 256:
            raise ValueError("conversation idempotency key must be between 1 and 256 characters")
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            existing = self._connection.execute(
                "SELECT * FROM conversation_turns WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            if existing is not None:
                if existing["binding"] != binding:
                    raise ValueError(
                        "idempotency key was reused for another conversation message"
                    )
                turn = _turn_from_row(existing)
                if turn.assistant is None:
                    raise RuntimeError(
                        "the previous conversation attempt has an unknown outcome"
                    )
                self._connection.execute("COMMIT")
                return turn
            row = self._connection.execute(
                """
                SELECT COALESCE(MAX(sequence), 0) AS sequence
                FROM conversation_turns WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            sequence = int(row["sequence"]) + 1
            timestamp = datetime.now(UTC)
            turn_id = f"turn-{uuid4()}"
            user_id = f"message-{uuid4()}"
            self._connection.execute(
                """
                INSERT INTO conversation_turns (
                    turn_id, run_id, sequence, mode, user_message_id, user_content,
                    assistant_message_id, assistant_content, data_class, prompt_id,
                    prompt_version, prompt_hash, dropped_messages,
                    estimated_context_tokens, total_tokens, created_at, completed_at,
                    idempotency_key, binding
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 0, 0, NULL, ?, NULL, ?, ?)
                """,
                (
                    turn_id,
                    run_id,
                    sequence,
                    mode.value,
                    user_id,
                    content,
                    data_class.value,
                    prompt_id,
                    prompt_version,
                    prompt_hash,
                    timestamp.isoformat(),
                    idempotency_key,
                    binding,
                ),
            )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return self.get(turn_id)

    def complete_turn(
        self,
        turn_id: str,
        *,
        content: str,
        dropped_messages: int,
        estimated_context_tokens: int,
        total_tokens: int,
    ) -> ConversationTurn:
        if not content.strip() or "\x00" in content or len(content) > 32_000:
            raise ValueError("conversation answer must be non-empty, NUL-free, and bounded")
        timestamp = datetime.now(UTC)
        cursor = self._connection.execute(
            """
            UPDATE conversation_turns SET
                assistant_message_id = ?, assistant_content = ?, dropped_messages = ?,
                estimated_context_tokens = ?, total_tokens = ?, completed_at = ?
            WHERE turn_id = ? AND assistant_content IS NULL
            """,
            (
                f"message-{uuid4()}",
                content,
                dropped_messages,
                estimated_context_tokens,
                total_tokens,
                timestamp.isoformat(),
                turn_id,
            ),
        )
        if cursor.rowcount != 1:
            raise ValueError("conversation turn is already complete or missing")
        return self.get(turn_id)

    def get(self, turn_id: str) -> ConversationTurn:
        row = self._connection.execute(
            "SELECT * FROM conversation_turns WHERE turn_id = ?", (turn_id,)
        ).fetchone()
        if row is None:
            raise KeyError(turn_id)
        return _turn_from_row(row)

    def completed_for_context(
        self, run_id: str, *, limit: int = 80
    ) -> tuple[ConversationTurn, ...]:
        rows = self._connection.execute(
            """
            SELECT * FROM conversation_turns
            WHERE run_id = ? AND assistant_content IS NOT NULL
            ORDER BY sequence DESC LIMIT ?
            """,
            (run_id, limit),
        ).fetchall()
        rows.reverse()
        return tuple(_turn_from_row(row) for row in rows)

    def latest_page(
        self, run_id: str, *, before_sequence: int | None = None, limit: int = 30
    ) -> tuple[ConversationTurn, ...]:
        if not 1 <= limit <= 101:
            raise ValueError("conversation page limit must be between 1 and 101")
        if before_sequence is None:
            rows = self._connection.execute(
                """
                SELECT * FROM conversation_turns WHERE run_id = ?
                ORDER BY sequence DESC LIMIT ?
                """,
                (run_id, limit),
            ).fetchall()
        else:
            if before_sequence < 1:
                raise ValueError("conversation cursor must be positive")
            rows = self._connection.execute(
                """
                SELECT * FROM conversation_turns WHERE run_id = ? AND sequence < ?
                ORDER BY sequence DESC LIMIT ?
                """,
                (run_id, before_sequence, limit),
            ).fetchall()
        rows.reverse()
        return tuple(_turn_from_row(row) for row in rows)


def _turn_from_row(row: sqlite3.Row) -> ConversationTurn:
    created_at = datetime.fromisoformat(row["created_at"])
    data_class = DataClass(row["data_class"])
    user = ConversationMessage(
        message_id=row["user_message_id"],
        run_id=row["run_id"],
        turn_sequence=row["sequence"],
        role="user",
        content=row["user_content"],
        created_at=created_at,
        data_class=data_class,
    )
    assistant = None
    if row["assistant_content"] is not None:
        assistant = ConversationMessage(
            message_id=row["assistant_message_id"],
            run_id=row["run_id"],
            turn_sequence=row["sequence"],
            role="assistant",
            content=row["assistant_content"],
            created_at=datetime.fromisoformat(row["completed_at"]),
            data_class=data_class,
        )
    return ConversationTurn(
        turn_id=row["turn_id"],
        run_id=row["run_id"],
        sequence=row["sequence"],
        mode=Mode(row["mode"]),
        user=user,
        assistant=assistant,
        prompt_id=row["prompt_id"],
        prompt_version=row["prompt_version"],
        prompt_hash=row["prompt_hash"],
        dropped_messages=row["dropped_messages"],
        estimated_context_tokens=row["estimated_context_tokens"],
        total_tokens=row["total_tokens"],
    )
