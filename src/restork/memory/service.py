"""Coordinator for memory inspection, context selection, and private lifecycle."""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from restork.contracts.types import DataClass
from restork.memory.context import WorkingContextSelector
from restork.memory.models import (
    ContextCandidate,
    ContextSelection,
    ContextSelectionRequest,
    MemoryExportResult,
    MemoryInspection,
    MemoryLayer,
    MemoryRecord,
    ProvenanceKind,
    RetentionClass,
    SourcePurgeResult,
    json_safe_value,
)
from restork.memory.profile import PrivateProfileStore
from restork.memory.semantic import MarkdownSemanticMemory
from restork.memory.store import SQLiteMemoryStore


class MemoryService:
    def __init__(
        self,
        store: SQLiteMemoryStore,
        profile: PrivateProfileStore,
        export_dir: Path,
        *,
        semantic: MarkdownSemanticMemory | None = None,
        derived_purgers: Iterable[Callable[[str], int]] = (),
    ) -> None:
        self._store = store
        self._profile = profile
        self._export_dir = export_dir.expanduser()
        self._semantic = semantic
        self._derived_purgers = tuple(derived_purgers)
        self._selector = WorkingContextSelector()

    def inspect(self, layer: MemoryLayer | None = None) -> MemoryInspection:
        records = (*self._store.list_records(), *self._profile.records())
        selected = tuple(record for record in records if layer is None or record.layer is layer)
        counts = {candidate.value: 0 for candidate in MemoryLayer}
        for record in records:
            counts[record.layer.value] += 1
        return MemoryInspection(records=selected, counts=counts)

    def get(self, memory_id: str) -> MemoryRecord:
        if memory_id.startswith("profile:"):
            return self._profile.get(memory_id)
        return self._store.get(memory_id, touch=True)

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
    ) -> MemoryRecord:
        return self._store.remember_episode(
            memory_id,
            summary,
            kind=kind,
            data_class=data_class,
            retention_class=retention_class,
            provenance=provenance,
            run_id=run_id,
            source_id=source_id,
            expires_at=expires_at,
        )

    def build_context(self, request: ContextSelectionRequest) -> ContextSelection:
        candidates = list(request.candidates)
        for memory_id in request.memory_ids:
            record = self.get(memory_id)
            if not record.summary:
                raise ValueError("empty profile memory is not eligible for context")
            candidates.append(
                ContextCandidate(
                    candidate_id=record.memory_id,
                    layer=record.layer,
                    content=record.summary,
                    data_class=record.data_class,
                    created_at=record.updated_at,
                    score=100,
                    explicit=True,
                    source_ref=record.source_id or record.run_id,
                )
            )
        if request.semantic_query is not None:
            if self._semantic is None:
                raise ValueError("semantic memory is not configured")
            candidates.extend(self._semantic.search(request.semantic_query))
        return self._selector.select(
            candidates,
            max_tokens=request.max_tokens,
            reserve_tokens=request.reserve_tokens,
        )

    def correct(
        self,
        memory_id: str,
        value: str | list[str],
        *,
        expected_content_hash: str,
        data_class: DataClass,
        idempotency_key: str,
    ) -> MemoryRecord:
        if not idempotency_key:
            raise ValueError("Idempotency-Key is required")
        if memory_id.startswith("profile:"):
            if data_class is not DataClass.PERSONAL:
                raise ValueError("profile memory uses the personal data class")
            binding = sha256(
                f"{memory_id}\0{expected_content_hash}\0{json_safe_value(value)}".encode()
            ).hexdigest()
            replay = self._external_replay("profile.correct", idempotency_key, binding)
            if isinstance(replay, MemoryRecord):
                return replay
            updated = self._profile.correct(
                memory_id,
                value,
                expected_content_hash=expected_content_hash,
            )
            self._external_save("profile.correct", idempotency_key, binding, updated)
            return updated
        if not isinstance(value, str):
            raise TypeError("episodic memory corrections require text")
        return self._store.correct(
            memory_id,
            value,
            expected_content_hash=expected_content_hash,
            data_class=data_class,
            idempotency_key=idempotency_key,
        )

    def delete(
        self,
        memory_id: str,
        *,
        expected_content_hash: str,
        idempotency_key: str,
    ) -> bool:
        if not idempotency_key:
            raise ValueError("Idempotency-Key is required")
        if memory_id.startswith("profile:"):
            binding = sha256(f"{memory_id}\0{expected_content_hash}".encode()).hexdigest()
            replay = self._external_replay("profile.delete", idempotency_key, binding)
            if isinstance(replay, bool):
                return replay
            deleted = self._profile.delete(
                memory_id, expected_content_hash=expected_content_hash
            )
            self._external_save("profile.delete", idempotency_key, binding, deleted)
            return deleted
        return self._store.delete(
            memory_id,
            expected_content_hash=expected_content_hash,
            idempotency_key=idempotency_key,
        )

    def export(
        self, layers: tuple[MemoryLayer, ...], *, idempotency_key: str
    ) -> MemoryExportResult:
        if not idempotency_key:
            raise ValueError("Idempotency-Key is required")
        binding = sha256("\0".join(sorted(layer.value for layer in layers)).encode()).hexdigest()
        replay = self._external_replay("memory.export", idempotency_key, binding)
        if isinstance(replay, MemoryExportResult):
            return replay
        selected = [
            record
            for record in self.inspect().records
            if record.layer in layers and record.retention_class is not RetentionClass.PROTECTED
        ]
        document = {
            "schema_version": 1,
            "exported_at": datetime.now(UTC).isoformat(),
            "records": [record.model_dump(mode="json") for record in selected],
        }
        payload = json.dumps(
            document, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        digest = sha256(payload).hexdigest()
        export_id = sha256(f"{idempotency_key}\0{binding}".encode()).hexdigest()[:24]
        target = self._export_dir / f"memory-export-{export_id}.json"
        _private_write(target, payload)
        result = MemoryExportResult(
            artifact_ref=f"memory-export:{export_id}",
            record_count=len(selected),
            content_hash=digest,
        )
        self._external_save("memory.export", idempotency_key, binding, result)
        return result

    def purge_source(self, source_id: str, *, idempotency_key: str) -> SourcePurgeResult:
        if not idempotency_key:
            raise ValueError("Idempotency-Key is required")
        tombstone = sha256(source_id.encode("utf-8")).hexdigest()
        replay = self._external_replay("memory.purge_source", idempotency_key, tombstone)
        if isinstance(replay, SourcePurgeResult):
            return replay
        deleted_records = self._store.purge_source(source_id)
        deleted_derived = sum(purger(source_id) for purger in self._derived_purgers)
        result = SourcePurgeResult(
            source_tombstone=tombstone,
            deleted_records=deleted_records,
            deleted_derived=deleted_derived,
        )
        self._external_save("memory.purge_source", idempotency_key, tombstone, result)
        return result

    def maintain(self, *, max_cache_entries: int) -> tuple[int, int]:
        return self._store.purge_expired(), self._store.evict_cache(max_cache_entries)

    def _external_replay(self, operation: str, key: str, binding: str) -> object | None:
        existing = self._store.load_external_mutation(operation, key, binding)
        if existing is None:
            return None
        document = json.loads(existing)
        result_type = document["type"]
        value = document["value"]
        if result_type == "MemoryRecord":
            return MemoryRecord.model_validate_json(
                json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            )
        if result_type == "MemoryExportResult":
            return MemoryExportResult.model_validate(value)
        if result_type == "SourcePurgeResult":
            return SourcePurgeResult.model_validate(value)
        if result_type == "bool" and isinstance(value, bool):
            return value
        raise ValueError("stored memory mutation response is invalid")

    def _external_save(self, operation: str, key: str, binding: str, result: object) -> None:
        if isinstance(result, MemoryRecord | MemoryExportResult | SourcePurgeResult):
            result_type = type(result).__name__
            value: object = result.model_dump(mode="json")
        elif isinstance(result, bool):
            result_type = "bool"
            value = result
        else:
            raise TypeError("unsupported memory mutation response")
        payload = json.dumps(
            {"type": result_type, "value": value},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        self._store.save_external_mutation(operation, key, binding, payload)


def _private_write(target: Path, payload: bytes) -> None:
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        target.parent.chmod(0o700)
    except OSError:
        pass
    temporary = target.with_name(f".{target.name}.tmp-{uuid4().hex}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
        target.chmod(0o600)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
