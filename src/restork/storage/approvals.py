"""Atomic local storage for single-use approval capabilities."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from restork.contracts.approval import ApprovalRequest
from restork.contracts.types import ApprovalDecision, RiskClass
from restork.storage.database import connect, initialize
from restork.storage.event_log import append_next_event
from restork.storage.idempotency import (
    load_idempotent_response,
    mutation_binding,
    save_idempotent_response,
)


class ApprovalAlreadyConsumed(ValueError):
    """Raised when a consumed approval capability is replayed."""


@dataclass(frozen=True)
class ApprovalDecisionOutcome:
    request: ApprovalRequest
    changed: bool


class SQLiteApprovalStore:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def open(cls, path: Path) -> SQLiteApprovalStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection)

    def create(self, request: ApprovalRequest) -> None:
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            self._bind_preview(request)
            self._connection.execute(
                """
                INSERT INTO approvals (approval_id, run_id, expires_at, decision, request_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    request.approval_id,
                    request.run_id,
                    request.expires_at.isoformat(),
                    request.decision.value,
                    request.model_dump_json(),
                ),
            )
            append_next_event(
                self._connection,
                request.run_id,
                kind="approval.requested",
                metadata={"approval_id": request.approval_id},
            )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")

    def decide(
        self, approval_id: str, decision: ApprovalDecision, decided_by: str
    ) -> ApprovalRequest:
        if decision not in {ApprovalDecision.APPROVED, ApprovalDecision.DENIED}:
            msg = "approvals can only be approved or denied by a decision"
            raise ValueError(msg)
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            request = self._load(approval_id)
            if request.decision is not ApprovalDecision.PENDING:
                raise ValueError("approval is no longer pending")
            if request.expires_at <= datetime.now(UTC):
                raise ValueError("approval capability has expired")
            updated = request.model_copy(
                update={
                    "decision": decision,
                    "decided_by": decided_by,
                    "decided_at": datetime.now(UTC),
                }
            )
            self._save(updated)
            if decision is ApprovalDecision.DENIED:
                self._delete_preview(updated)
            append_next_event(
                self._connection,
                updated.run_id,
                kind="approval.resolved",
                metadata={
                    "approval_id": approval_id,
                    "decision": decision.value,
                },
            )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return updated

    def decide_idempotently(
        self,
        approval_id: str,
        decision: ApprovalDecision,
        decided_by: str,
        *,
        idempotency_key: str,
    ) -> ApprovalDecisionOutcome:
        if decision not in {ApprovalDecision.APPROVED, ApprovalDecision.DENIED}:
            raise ValueError("approvals can only be approved or denied by a decision")
        operation = "approval.decide"
        binding = mutation_binding(approval_id, decision.value, decided_by)
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
                result = ApprovalRequest.model_validate_json(replay)
            else:
                request = self._load(approval_id)
                if request.decision is not ApprovalDecision.PENDING:
                    raise ValueError("approval is no longer pending")
                if request.expires_at <= datetime.now(UTC):
                    raise ValueError("approval capability has expired")
                result = request.model_copy(
                    update={
                        "decision": decision,
                        "decided_by": decided_by,
                        "decided_at": datetime.now(UTC),
                    }
                )
                self._save(result)
                if decision is ApprovalDecision.DENIED:
                    self._delete_preview(result)
                append_next_event(
                    self._connection,
                    result.run_id,
                    kind="approval.resolved",
                    metadata={
                        "approval_id": approval_id,
                        "decision": decision.value,
                    },
                )
                save_idempotent_response(
                    self._connection,
                    operation=operation,
                    idempotency_key=idempotency_key,
                    binding=binding,
                    response_json=result.model_dump_json(),
                )
                changed = True
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return ApprovalDecisionOutcome(result, changed)

    def consume(self, approval_id: str) -> ApprovalRequest:
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            request = self._load(approval_id)
            updated = self._consume_request(request)
            self._save(updated)
            self._delete_preview(updated)
            append_next_event(
                self._connection,
                updated.run_id,
                kind="approval.resolved",
                metadata={
                    "approval_id": approval_id,
                    "decision": ApprovalDecision.CONSUMED.value,
                },
            )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
            return updated

    def consume_matching(
        self,
        approval_id: str,
        *,
        action_digest: str,
        canonical_scope: str,
        resource_versions: dict[str, str],
        policy_version: str,
        nonce: str,
        action_kind: str | None = None,
        risk_class: RiskClass | None = None,
    ) -> ApprovalRequest:
        """Atomically consume only the exact reviewed action capability."""
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            request = self._load(approval_id)
            if request.action_digest != action_digest:
                raise PermissionError("approval action digest does not match")
            if request.canonical_scope != canonical_scope:
                raise PermissionError("approval canonical scope does not match")
            if request.resource_versions != resource_versions:
                raise PermissionError("approval resource versions do not match")
            if request.policy_version != policy_version:
                raise PermissionError("approval policy version does not match")
            if request.nonce != nonce:
                raise PermissionError("approval nonce does not match")
            if action_kind is not None and request.action_kind != action_kind:
                raise PermissionError("approval action kind does not match")
            if risk_class is not None and request.risk_class is not risk_class:
                raise PermissionError("approval risk class does not match")
            updated = self._consume_request(request)
            self._save(updated)
            self._delete_preview(updated)
            append_next_event(
                self._connection,
                updated.run_id,
                kind="approval.resolved",
                metadata={
                    "approval_id": approval_id,
                    "decision": ApprovalDecision.CONSUMED.value,
                },
            )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
            return updated

    @staticmethod
    def _consume_request(request: ApprovalRequest) -> ApprovalRequest:
        if request.decision is ApprovalDecision.CONSUMED:
            raise ApprovalAlreadyConsumed("approval capability has already been consumed")
        if request.expires_at <= datetime.now(UTC):
            raise ValueError("approval capability has expired")
        if request.decision is not ApprovalDecision.APPROVED:
            raise ValueError("approval capability is not approved")
        return request.model_copy(
            update={"decision": ApprovalDecision.CONSUMED, "consumed_at": datetime.now(UTC)}
        )

    def _load(self, approval_id: str) -> ApprovalRequest:
        row = self._connection.execute(
            "SELECT request_json FROM approvals WHERE approval_id = ?", (approval_id,)
        ).fetchone()
        if row is None:
            raise KeyError(approval_id)
        return ApprovalRequest.model_validate_json(row["request_json"])

    def get(self, approval_id: str) -> ApprovalRequest:
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            request = self._load(approval_id)
            if (
                request.decision is ApprovalDecision.PENDING
                and request.expires_at <= datetime.now(UTC)
            ):
                request = request.model_copy(
                    update={
                        "decision": ApprovalDecision.EXPIRED,
                        "decided_at": datetime.now(UTC),
                    }
                )
                self._save(request)
                self._delete_preview(request)
                append_next_event(
                    self._connection,
                    request.run_id,
                    kind="approval.resolved",
                    metadata={
                        "approval_id": approval_id,
                        "decision": ApprovalDecision.EXPIRED.value,
                    },
                )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return request

    def list_requests(
        self, *, pending_only: bool = False, limit: int = 50
    ) -> tuple[ApprovalRequest, ...]:
        if not 1 <= limit <= 200:
            raise ValueError("approval list limit must be between 1 and 200")
        if pending_only:
            rows = self._connection.execute(
                """
                SELECT approval_id FROM approvals
                WHERE decision = ?
                ORDER BY expires_at ASC, approval_id
                LIMIT ?
                """,
                (ApprovalDecision.PENDING.value, limit),
            ).fetchall()
        else:
            rows = self._connection.execute(
                """
                SELECT approval_id FROM approvals
                ORDER BY expires_at DESC, approval_id
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return tuple(self.get(row["approval_id"]) for row in rows)

    def _save(self, request: ApprovalRequest) -> None:
        self._connection.execute(
            """
            UPDATE approvals SET expires_at = ?, decision = ?, request_json = ?
            WHERE approval_id = ?
            """,
            (
                request.expires_at.isoformat(),
                request.decision.value,
                request.model_dump_json(),
                request.approval_id,
            ),
        )

    def _bind_preview(self, request: ApprovalRequest) -> None:
        if request.preview_ref is None:
            return
        row = self._connection.execute(
            "SELECT run_id, expires_at FROM transient_blobs WHERE blob_id = ?",
            (request.preview_ref,),
        ).fetchone()
        if row is None:
            raise ValueError("approval preview blob does not exist")
        if row["run_id"] is not None and row["run_id"] != request.run_id:
            raise ValueError("approval preview belongs to another run")
        blob_expiry = datetime.fromisoformat(row["expires_at"])
        expires_at = min(blob_expiry, request.expires_at)
        self._connection.execute(
            "UPDATE transient_blobs SET run_id = ?, expires_at = ? WHERE blob_id = ?",
            (request.run_id, expires_at.isoformat(), request.preview_ref),
        )

    def _delete_preview(self, request: ApprovalRequest) -> None:
        if request.preview_ref is not None:
            self._connection.execute(
                "DELETE FROM transient_blobs WHERE blob_id = ?", (request.preview_ref,)
            )
