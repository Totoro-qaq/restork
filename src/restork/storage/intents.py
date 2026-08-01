"""Durable effect intents used to reconcile side effects after restart."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

from restork.contracts.types import EffectPhase
from restork.storage.database import connect, initialize


@dataclass(frozen=True)
class EffectIntent:
    intent_id: str
    run_id: str
    tool_name: str
    input_hash: str
    phase: EffectPhase
    retry_contract: str


def may_retry(intent: EffectIntent) -> bool:
    """Unknown effects never retry automatically; reconciliation must resolve them first."""
    return (
        intent.phase in {EffectPhase.PREPARED, EffectPhase.FAILED}
        and intent.retry_contract == "pure"
    )


class SQLiteIntentStore:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def create(cls, path: Path) -> SQLiteIntentStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection)

    def create_intent(self, intent: EffectIntent) -> None:
        self._connection.execute(
            """
            INSERT INTO effect_intents
                (intent_id, run_id, tool_name, input_hash, phase, retry_contract)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                intent.intent_id,
                intent.run_id,
                intent.tool_name,
                intent.input_hash,
                intent.phase.value,
                intent.retry_contract,
            ),
        )

    def update_phase(self, intent_id: str, phase: EffectPhase) -> EffectIntent:
        cursor = self._connection.execute(
            "UPDATE effect_intents SET phase = ? WHERE intent_id = ?", (phase.value, intent_id)
        )
        if cursor.rowcount != 1:
            raise KeyError(intent_id)
        row = self._connection.execute(
            "SELECT * FROM effect_intents WHERE intent_id = ?", (intent_id,)
        ).fetchone()
        if row is None:
            raise RuntimeError("effect intent disappeared after an update")
        return EffectIntent(
            intent_id=row["intent_id"],
            run_id=row["run_id"],
            tool_name=row["tool_name"],
            input_hash=row["input_hash"],
            phase=EffectPhase(row["phase"]),
            retry_contract=row["retry_contract"],
        )
