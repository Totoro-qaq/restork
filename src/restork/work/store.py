"""Durable Work plans, privacy previews, exports, and verification reports."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import cast

from restork.artifacts.work import WorkPlanArtifact
from restork.storage.database import connect, initialize
from restork.storage.idempotency import mutation_binding
from restork.work.models import (
    WorkExportResult,
    WorkHandoffPreview,
    WorkStartRequest,
    WorkVerificationReport,
)
from restork.work.workspace import WorkspaceFile, WorkspaceSnapshot


class SQLiteWorkStore:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def create(cls, path: Path) -> SQLiteWorkStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection)

    def save_plan(
        self,
        request: WorkStartRequest,
        plan: WorkPlanArtifact,
        snapshot: WorkspaceSnapshot,
    ) -> WorkPlanArtifact:
        row = self._connection.execute(
            "SELECT request_hash, plan_json FROM work_sessions WHERE run_id = ?",
            (plan.run_id,),
        ).fetchone()
        if row is not None:
            if row["request_hash"] != plan.request_hash:
                raise ValueError("Work run is already bound to another request")
            return WorkPlanArtifact.model_validate_json(row["plan_json"])
        self._connection.execute(
            """
            INSERT INTO work_sessions
                (run_id, request_hash, request_json, plan_json, snapshot_json,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                plan.run_id,
                plan.request_hash,
                request.model_dump_json(),
                plan.model_dump_json(),
                _snapshot_json(snapshot),
                plan.created_at.isoformat(),
                plan.created_at.isoformat(),
            ),
        )
        return plan

    def request(self, run_id: str) -> WorkStartRequest:
        return WorkStartRequest.model_validate_json(self._session(run_id)["request_json"])

    def plan(self, run_id: str) -> WorkPlanArtifact:
        return WorkPlanArtifact.model_validate_json(self._session(run_id)["plan_json"])

    def snapshot(self, run_id: str) -> WorkspaceSnapshot:
        return _load_snapshot(self._session(run_id)["snapshot_json"])

    def save_preview(
        self,
        preview: WorkHandoffPreview,
        *,
        idempotency_key: str,
    ) -> WorkHandoffPreview:
        binding = mutation_binding(preview.plan.artifact_id, preview.package_hash)
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            row = self._session(preview.plan.run_id)
            existing = row["preview_json"]
            if existing is not None:
                if (
                    row["preview_idempotency_key"] != idempotency_key
                    or row["preview_binding"] != binding
                ):
                    raise ValueError("Work run already has another handoff preview")
                result = WorkHandoffPreview.model_validate_json(existing)
            else:
                self._connection.execute(
                    """
                    UPDATE work_sessions SET
                        preview_idempotency_key = ?, preview_binding = ?, preview_json = ?,
                        updated_at = ?
                    WHERE run_id = ?
                    """,
                    (
                        idempotency_key,
                        binding,
                        preview.model_dump_json(),
                        preview.envelope.created_at.isoformat(),
                        preview.plan.run_id,
                    ),
                )
                result = preview
        except BaseException:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return result

    def preview(self, run_id: str) -> WorkHandoffPreview | None:
        value = self._session(run_id)["preview_json"]
        return None if value is None else WorkHandoffPreview.model_validate_json(value)

    def save_export(
        self,
        result: WorkExportResult,
        *,
        idempotency_key: str,
    ) -> WorkExportResult:
        binding = mutation_binding(result.approval_id, result.package_hash)
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            row = self._session(result.run_id)
            existing = row["export_json"]
            if existing is not None:
                if (
                    row["export_idempotency_key"] != idempotency_key
                    or row["export_binding"] != binding
                ):
                    raise ValueError("Work handoff export idempotency key is already bound")
                saved = WorkExportResult.model_validate_json(existing)
            else:
                self._connection.execute(
                    """
                    UPDATE work_sessions SET
                        export_idempotency_key = ?, export_binding = ?, export_json = ?,
                        updated_at = ?
                    WHERE run_id = ?
                    """,
                    (
                        idempotency_key,
                        binding,
                        result.model_dump_json(),
                        result.exported_at.isoformat(),
                        result.run_id,
                    ),
                )
                saved = result
        except BaseException:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return saved

    def exported(self, run_id: str) -> WorkExportResult | None:
        value = self._session(run_id)["export_json"]
        return None if value is None else WorkExportResult.model_validate_json(value)

    def replay_export(self, run_id: str, idempotency_key: str) -> WorkExportResult | None:
        row = self._session(run_id)
        if row["export_json"] is None:
            return None
        if row["export_idempotency_key"] != idempotency_key:
            raise ValueError("Work handoff was already exported with another idempotency key")
        return WorkExportResult.model_validate_json(row["export_json"])

    def save_verification(
        self,
        report: WorkVerificationReport,
        *,
        idempotency_key: str,
        binding: str,
    ) -> WorkVerificationReport:
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            row = self._connection.execute(
                """
                SELECT run_id, binding, report_json FROM work_verifications
                WHERE idempotency_key = ?
                """,
                (idempotency_key,),
            ).fetchone()
            if row is not None:
                if row["run_id"] != report.run_id or row["binding"] != binding:
                    raise ValueError("Work verification Idempotency-Key is already bound")
                saved = WorkVerificationReport.model_validate_json(row["report_json"])
            else:
                self._connection.execute(
                    """
                    INSERT INTO work_verifications
                        (verification_id, run_id, idempotency_key, binding, manifest_hash,
                         report_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        report.verification_id,
                        report.run_id,
                        idempotency_key,
                        binding,
                        report.manifest_hash,
                        report.model_dump_json(),
                        report.created_at.isoformat(),
                    ),
                )
                saved = report
        except BaseException:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return saved

    def replay_verification(
        self,
        run_id: str,
        idempotency_key: str,
        binding: str,
    ) -> WorkVerificationReport | None:
        row = self._connection.execute(
            """
            SELECT run_id, binding, report_json FROM work_verifications
            WHERE idempotency_key = ?
            """,
            (idempotency_key,),
        ).fetchone()
        if row is None:
            return None
        if row["run_id"] != run_id or row["binding"] != binding:
            raise ValueError("Work verification Idempotency-Key is already bound")
        return WorkVerificationReport.model_validate_json(row["report_json"])

    def latest_verification(self, run_id: str) -> WorkVerificationReport | None:
        row = self._connection.execute(
            """
            SELECT report_json FROM work_verifications
            WHERE run_id = ? ORDER BY created_at DESC, verification_id DESC LIMIT 1
            """,
            (run_id,),
        ).fetchone()
        return None if row is None else WorkVerificationReport.model_validate_json(
            row["report_json"]
        )

    def _session(self, run_id: str) -> sqlite3.Row:
        row = self._connection.execute(
            "SELECT * FROM work_sessions WHERE run_id = ?", (run_id,)
        ).fetchone()
        if row is None:
            raise KeyError(run_id)
        return cast(sqlite3.Row, row)


def _snapshot_json(snapshot: WorkspaceSnapshot) -> str:
    value = {
        "workspace_id": snapshot.workspace_id,
        "snapshot_hash": snapshot.snapshot_hash,
        "files": {
            path: {
                "content_hash": item.content_hash,
                "byte_count": item.byte_count,
                "language": item.language,
            }
            for path, item in snapshot.files.items()
        },
    }
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _load_snapshot(payload: str) -> WorkspaceSnapshot:
    value = json.loads(payload)
    files = {
        path: WorkspaceFile(
            relative_path=path,
            content_hash=item["content_hash"],
            byte_count=item["byte_count"],
            language=item["language"],
            content="",
        )
        for path, item in value["files"].items()
    }
    return WorkspaceSnapshot(
        workspace_id=value["workspace_id"],
        snapshot_hash=value["snapshot_hash"],
        files=files,
    )
