"""SQLite episodic-memory persistence with protected retention boundaries."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from restork.contracts.types import DataClass
from restork.memory.models import (
    MemoryLayer,
    MemoryRecord,
    ProvenanceKind,
    RetentionClass,
    memory_content_hash,
)
from restork.storage.database import connect, initialize
from restork.storage.idempotency import (
    load_idempotent_response,
    mutation_binding,
    save_idempotent_response,
)


class SQLiteMemoryStore:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def create(cls, path: Path) -> SQLiteMemoryStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection)

    def create_record(self, record: MemoryRecord) -> MemoryRecord:
        if record.layer is not MemoryLayer.EPISODIC:
            raise ValueError("SQLite memory store accepts episodic records only")
        self._connection.execute(
            """
            INSERT INTO memory_records (
                memory_id, layer, kind, summary, provenance, data_class,
                retention_class, created_at, updated_at, expires_at,
                last_accessed_at, run_id, source_id, content_hash, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _record_values(record),
        )
        return record

    def remember_episode(
        self,
        memory_id: str,
        summary: str,
        *,
        kind: str,
        data_class: DataClass,
        retention_class: RetentionClass = RetentionClass.SESSION,
        provenance: ProvenanceKind = ProvenanceKind.USER,
        run_id: str | None = None,
        source_id: str | None = None,
        expires_at: datetime | None = None,
        now: datetime | None = None,
    ) -> MemoryRecord:
        timestamp = now or datetime.now(UTC)
        record = MemoryRecord(
            memory_id=memory_id,
            layer=MemoryLayer.EPISODIC,
            kind=kind,
            summary=summary,
            provenance=provenance,
            data_class=data_class,
            retention_class=retention_class,
            created_at=timestamp,
            updated_at=timestamp,
            expires_at=expires_at,
            last_accessed_at=timestamp,
            run_id=run_id,
            source_id=source_id,
            content_hash=memory_content_hash(summary),
        )
        return self.create_record(record)

    def get(self, memory_id: str, *, touch: bool = False) -> MemoryRecord:
        row = self._connection.execute(
            "SELECT * FROM memory_records WHERE memory_id = ?", (memory_id,)
        ).fetchone()
        if row is None:
            raise KeyError(memory_id)
        record = _record_from_row(row)
        if record.expires_at is not None and record.expires_at <= datetime.now(UTC):
            self._connection.execute(
                "DELETE FROM memory_records WHERE memory_id = ?", (memory_id,)
            )
            raise KeyError(memory_id)
        if touch and record.retention_class is RetentionClass.CACHE:
            timestamp = datetime.now(UTC)
            self._connection.execute(
                "UPDATE memory_records SET last_accessed_at = ? WHERE memory_id = ?",
                (timestamp.isoformat(), memory_id),
            )
            record = record.model_copy(update={"last_accessed_at": timestamp})
        return record

    def list_records(self) -> tuple[MemoryRecord, ...]:
        self.purge_expired()
        return tuple(
            _record_from_row(row)
            for row in self._connection.execute(
                "SELECT * FROM memory_records ORDER BY updated_at DESC, memory_id"
            )
        )

    def correct(
        self,
        memory_id: str,
        summary: str,
        *,
        expected_content_hash: str,
        data_class: DataClass,
        idempotency_key: str,
    ) -> MemoryRecord:
        binding = mutation_binding(memory_id, expected_content_hash, summary, data_class.value)
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            replay = load_idempotent_response(
                self._connection,
                operation="memory.correct",
                idempotency_key=idempotency_key,
                binding=binding,
            )
            if replay is not None:
                self._connection.execute("COMMIT")
                return MemoryRecord.model_validate_json(replay)
            row = self._connection.execute(
                "SELECT * FROM memory_records WHERE memory_id = ?", (memory_id,)
            ).fetchone()
            if row is None:
                raise KeyError(memory_id)
            current = _record_from_row(row)
            if current.retention_class is RetentionClass.PROTECTED:
                raise PermissionError("protected memory cannot be corrected")
            if current.content_hash != expected_content_hash:
                raise ValueError("memory changed after it was inspected")
            if data_class in {DataClass.SECRET, DataClass.CREDENTIAL}:
                raise PermissionError("secret and credential data cannot enter memory")
            timestamp = datetime.now(UTC)
            updated = current.model_copy(
                update={
                    "summary": summary,
                    "data_class": data_class,
                    "updated_at": timestamp,
                    "last_accessed_at": timestamp,
                    "content_hash": memory_content_hash(summary),
                    "version": current.version + 1,
                }
            )
            updated = MemoryRecord.model_validate(updated)
            cursor = self._connection.execute(
                """
                UPDATE memory_records SET
                    summary = ?, data_class = ?, updated_at = ?, last_accessed_at = ?,
                    content_hash = ?, version = ?
                WHERE memory_id = ? AND content_hash = ?
                """,
                (
                    updated.summary,
                    updated.data_class.value,
                    updated.updated_at.isoformat(),
                    updated.last_accessed_at.isoformat()
                    if updated.last_accessed_at is not None
                    else None,
                    updated.content_hash,
                    updated.version,
                    memory_id,
                    expected_content_hash,
                ),
            )
            if cursor.rowcount != 1:
                raise ValueError("memory changed during correction")
            payload = updated.model_dump_json()
            save_idempotent_response(
                self._connection,
                operation="memory.correct",
                idempotency_key=idempotency_key,
                binding=binding,
                response_json=payload,
            )
        except BaseException:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return updated

    def delete(
        self,
        memory_id: str,
        *,
        expected_content_hash: str,
        idempotency_key: str,
    ) -> bool:
        binding = mutation_binding(memory_id, expected_content_hash)
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            replay = load_idempotent_response(
                self._connection,
                operation="memory.delete",
                idempotency_key=idempotency_key,
                binding=binding,
            )
            if replay is not None:
                self._connection.execute("COMMIT")
                return bool(json.loads(replay)["deleted"])
            row = self._connection.execute(
                "SELECT * FROM memory_records WHERE memory_id = ?", (memory_id,)
            ).fetchone()
            if row is None:
                raise KeyError(memory_id)
            current = _record_from_row(row)
            if current.retention_class is RetentionClass.PROTECTED:
                raise PermissionError("protected memory cannot be deleted")
            if current.content_hash != expected_content_hash:
                raise ValueError("memory changed after it was inspected")
            self._connection.execute(
                "DELETE FROM memory_records WHERE memory_id = ?", (memory_id,)
            )
            response = json.dumps({"deleted": True}, separators=(",", ":"))
            save_idempotent_response(
                self._connection,
                operation="memory.delete",
                idempotency_key=idempotency_key,
                binding=binding,
                response_json=response,
            )
        except BaseException:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return True

    def purge_expired(self, *, now: datetime | None = None) -> int:
        timestamp = (now or datetime.now(UTC)).isoformat()
        cursor = self._connection.execute(
            """
            DELETE FROM memory_records
            WHERE retention_class IN ('transient', 'cache')
              AND expires_at IS NOT NULL
              AND expires_at <= ?
            """,
            (timestamp,),
        )
        return cursor.rowcount

    def evict_cache(self, max_entries: int) -> int:
        if max_entries < 0:
            raise ValueError("cache entry limit cannot be negative")
        rows = self._connection.execute(
            """
            SELECT memory_id FROM memory_records
            WHERE retention_class = 'cache'
            ORDER BY COALESCE(last_accessed_at, created_at) DESC, memory_id
            """
        ).fetchall()
        victims = [row["memory_id"] for row in rows[max_entries:]]
        if not victims:
            return 0
        self._connection.executemany(
            "DELETE FROM memory_records WHERE memory_id = ?", ((item,) for item in victims)
        )
        return len(victims)

    def purge_source(self, source_id: str) -> int:
        cursor = self._connection.execute(
            """
            DELETE FROM memory_records
            WHERE source_id = ? AND retention_class != 'protected'
            """,
            (source_id,),
        )
        return cursor.rowcount

    def load_external_mutation(
        self, operation: str, idempotency_key: str, binding: str
    ) -> str | None:
        return load_idempotent_response(
            self._connection,
            operation=operation,
            idempotency_key=idempotency_key,
            binding=binding,
        )

    def save_external_mutation(
        self,
        operation: str,
        idempotency_key: str,
        binding: str,
        response_json: str,
    ) -> None:
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            existing = load_idempotent_response(
                self._connection,
                operation=operation,
                idempotency_key=idempotency_key,
                binding=binding,
            )
            if existing is None:
                save_idempotent_response(
                    self._connection,
                    operation=operation,
                    idempotency_key=idempotency_key,
                    binding=binding,
                    response_json=response_json,
                )
        except BaseException:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")


def _record_values(record: MemoryRecord) -> tuple[object, ...]:
    return (
        record.memory_id,
        record.layer.value,
        record.kind,
        record.summary,
        record.provenance.value,
        record.data_class.value,
        record.retention_class.value,
        record.created_at.isoformat(),
        record.updated_at.isoformat(),
        record.expires_at.isoformat() if record.expires_at is not None else None,
        record.last_accessed_at.isoformat() if record.last_accessed_at is not None else None,
        record.run_id,
        record.source_id,
        record.content_hash,
        record.version,
    )


def _record_from_row(row: sqlite3.Row) -> MemoryRecord:
    return MemoryRecord(
        memory_id=row["memory_id"],
        layer=MemoryLayer(row["layer"]),
        kind=row["kind"],
        summary=row["summary"],
        provenance=ProvenanceKind(row["provenance"]),
        data_class=DataClass(row["data_class"]),
        retention_class=RetentionClass(row["retention_class"]),
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
        expires_at=datetime.fromisoformat(row["expires_at"])
        if row["expires_at"] is not None
        else None,
        last_accessed_at=datetime.fromisoformat(row["last_accessed_at"])
        if row["last_accessed_at"] is not None
        else None,
        run_id=row["run_id"],
        source_id=row["source_id"],
        content_hash=row["content_hash"],
        version=row["version"],
    )
