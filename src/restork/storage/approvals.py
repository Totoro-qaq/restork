"""Atomic local storage for single-use approval capabilities."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from restork.contracts.approval import ApprovalRequest
from restork.contracts.types import ApprovalDecision
from restork.storage.database import connect, initialize


class ApprovalAlreadyConsumed(ValueError):
    """Raised when a consumed approval capability is replayed."""


class SQLiteApprovalStore:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def open(cls, path: Path) -> SQLiteApprovalStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection)

    def create(self, request: ApprovalRequest) -> None:
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

    def decide(
        self, approval_id: str, decision: ApprovalDecision, decided_by: str
    ) -> ApprovalRequest:
        if decision not in {ApprovalDecision.APPROVED, ApprovalDecision.DENIED}:
            msg = "approvals can only be approved or denied by a decision"
            raise ValueError(msg)
        request = self._load(approval_id)
        if request.decision is not ApprovalDecision.PENDING:
            raise ValueError("approval is no longer pending")
        updated = request.model_copy(
            update={"decision": decision, "decided_by": decided_by, "decided_at": datetime.now(UTC)}
        )
        self._save(updated)
        return updated

    def consume(self, approval_id: str) -> ApprovalRequest:
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            request = self._load(approval_id)
            updated = self._consume_request(request)
            self._save(updated)
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
            updated = self._consume_request(request)
            self._save(updated)
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
