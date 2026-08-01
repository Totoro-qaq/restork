"""JSON Schema exports for local clients generated from Core contracts."""

from __future__ import annotations

from typing import Any

from restork.contracts.approval import ApprovalRequest
from restork.contracts.event import RunEvent
from restork.contracts.task import TaskSpec
from restork.research.models import SourceCard, SourceRequest


def contract_schemas() -> dict[str, dict[str, Any]]:
    """Return the V1 schemas shared by the Core and TypeScript clients."""
    return {
        "ApprovalRequest": ApprovalRequest.model_json_schema(),
        "RunEvent": RunEvent.model_json_schema(),
        "SourceCard": SourceCard.model_json_schema(),
        "SourceRequest": SourceRequest.model_json_schema(),
        "TaskSpec": TaskSpec.model_json_schema(),
    }
