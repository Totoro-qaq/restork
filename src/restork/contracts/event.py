"""Append-only event envelope contracts."""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from restork.contracts.base import ContractModel


class RunEvent(ContractModel):
    event_id: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    seq: int = Field(ge=1)
    occurred_at: datetime
    kind: str = Field(min_length=1)
    metadata: dict[str, object] = Field(default_factory=dict)
