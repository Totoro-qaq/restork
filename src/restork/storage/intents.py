"""Durable effect intents used to reconcile side effects after restart."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from restork.contracts.types import EffectPhase
from restork.storage.database import connect, initialize
from restork.storage.event_log import append_next_event
from restork.storage.idempotency import (
    load_idempotent_response,
    mutation_binding,
    save_idempotent_response,
)


@dataclass(frozen=True)
class EffectIntent:
    intent_id: str
    run_id: str
    tool_name: str
    input_hash: str
    phase: EffectPhase
    retry_contract: str
    artifact_refs: tuple[str, ...] = ()


@dataclass(frozen=True)
class EffectResolutionOutcome:
    intent: EffectIntent
    changed: bool


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
                (intent_id, run_id, tool_name, input_hash, phase, retry_contract,
                 artifact_refs_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                intent.intent_id,
                intent.run_id,
                intent.tool_name,
                intent.input_hash,
                intent.phase.value,
                intent.retry_contract,
                json.dumps(intent.artifact_refs, separators=(",", ":")),
            ),
        )

    def create_with_event(
        self,
        intent: EffectIntent,
        *,
        event_kind: str,
        metadata: dict[str, object],
    ) -> None:
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            self.create_intent(intent)
            append_next_event(
                self._connection,
                intent.run_id,
                kind=event_kind,
                metadata=metadata,
            )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")

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
        return _intent_from_row(row)

    def update_phase_with_event(
        self,
        intent_id: str,
        phase: EffectPhase,
        *,
        event_kind: str,
        metadata: dict[str, object],
    ) -> EffectIntent:
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            result = self.update_phase(intent_id, phase)
            append_next_event(
                self._connection,
                result.run_id,
                kind=event_kind,
                metadata=metadata,
            )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return result

    def commit_with_artifacts_and_event(
        self,
        intent_id: str,
        artifact_refs: tuple[str, ...],
        *,
        event_kind: str,
        metadata: dict[str, object],
    ) -> EffectIntent:
        """Atomically preserve completion evidence with the committed effect."""
        if any(not item.strip() for item in artifact_refs):
            raise ValueError("committed artifact references must be non-empty")
        if len(artifact_refs) != len(set(artifact_refs)):
            raise ValueError("committed artifact references must be unique")
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            cursor = self._connection.execute(
                """
                UPDATE effect_intents
                SET phase = ?, artifact_refs_json = ?
                WHERE intent_id = ?
                """,
                (
                    EffectPhase.COMMITTED.value,
                    json.dumps(artifact_refs, separators=(",", ":")),
                    intent_id,
                ),
            )
            if cursor.rowcount != 1:
                raise KeyError(intent_id)
            result = self.get(intent_id)
            append_next_event(
                self._connection,
                result.run_id,
                kind=event_kind,
                metadata=metadata,
            )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return result

    def get(self, intent_id: str) -> EffectIntent:
        row = self._connection.execute(
            "SELECT * FROM effect_intents WHERE intent_id = ?", (intent_id,)
        ).fetchone()
        if row is None:
            raise KeyError(intent_id)
        return _intent_from_row(row)

    def unresolved_for_run(self, run_id: str) -> list[EffectIntent]:
        rows = self._connection.execute(
            """
            SELECT * FROM effect_intents
            WHERE run_id = ? AND phase IN (?, ?)
            ORDER BY intent_id ASC
            """,
            (run_id, EffectPhase.STARTED.value, EffectPhase.UNKNOWN.value),
        ).fetchall()
        return [
            _intent_from_row(row)
            for row in rows
        ]

    def resolve_idempotently(
        self,
        run_id: str,
        intent_id: str,
        phase: EffectPhase,
        *,
        idempotency_key: str,
    ) -> EffectResolutionOutcome:
        if phase not in {EffectPhase.COMMITTED, EffectPhase.FAILED}:
            raise ValueError("unknown effects resolve only as committed or failed")
        operation = "effect.resolve"
        binding = mutation_binding(run_id, intent_id, phase.value)
        changed = False
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            replay = load_idempotent_response(
                self._connection,
                operation=operation,
                idempotency_key=idempotency_key,
                binding=binding,
            )
            if replay is not None:
                result = _intent_from_json(replay)
            else:
                current = self.get(intent_id)
                if current.run_id != run_id:
                    raise ValueError("effect intent belongs to another run")
                if current.phase is not EffectPhase.UNKNOWN:
                    raise ValueError("only unknown effects require reconciliation")
                result = self.update_phase(intent_id, phase)
                append_next_event(
                    self._connection,
                    run_id,
                    kind="tool.reconciled",
                    metadata={"intent_id": intent_id, "outcome": phase.value},
                )
                save_idempotent_response(
                    self._connection,
                    operation=operation,
                    idempotency_key=idempotency_key,
                    binding=binding,
                    response_json=_intent_to_json(result),
                )
                changed = True
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return EffectResolutionOutcome(result, changed)


def _intent_to_json(intent: EffectIntent) -> str:
    return json.dumps(
        {
            "intent_id": intent.intent_id,
            "run_id": intent.run_id,
            "tool_name": intent.tool_name,
            "input_hash": intent.input_hash,
            "phase": intent.phase.value,
            "retry_contract": intent.retry_contract,
            "artifact_refs": intent.artifact_refs,
        },
        sort_keys=True,
    )


def _intent_from_json(payload: str) -> EffectIntent:
    value = json.loads(payload)
    return EffectIntent(
        intent_id=value["intent_id"],
        run_id=value["run_id"],
        tool_name=value["tool_name"],
        input_hash=value["input_hash"],
        phase=EffectPhase(value["phase"]),
        retry_contract=value["retry_contract"],
        artifact_refs=tuple(value.get("artifact_refs", ())),
    )


def _intent_from_row(row: sqlite3.Row) -> EffectIntent:
    artifact_refs = json.loads(row["artifact_refs_json"])
    if not isinstance(artifact_refs, list) or not all(
        isinstance(item, str) and item for item in artifact_refs
    ):
        raise ValueError("stored effect artifact references are invalid")
    return EffectIntent(
        intent_id=row["intent_id"],
        run_id=row["run_id"],
        tool_name=row["tool_name"],
        input_hash=row["input_hash"],
        phase=EffectPhase(row["phase"]),
        retry_contract=row["retry_contract"],
        artifact_refs=tuple(artifact_refs),
    )
