"""Run-state envelopes independent of persistence implementation."""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from restork.contracts.base import ContractModel
from restork.contracts.types import Mode, RunPhase, StopReason


class RunSummary(ContractModel):
    run_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    mode: Mode
    state: RunPhase
    state_version: int = Field(ge=0)
    stop_reason: StopReason | None = None
    created_at: datetime
    updated_at: datetime
