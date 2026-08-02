"""Durable user-visible conversation contracts without hidden reasoning."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from restork.contracts.base import ContractModel
from restork.contracts.types import DataClass, Mode


class ConversationMessage(ContractModel):
    message_id: str = Field(min_length=1, max_length=256)
    run_id: str = Field(min_length=1, max_length=256)
    turn_sequence: int = Field(ge=1)
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=32_000)
    created_at: datetime
    data_class: DataClass

    @field_validator("created_at")
    @classmethod
    def require_aware_time(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("conversation timestamps must be timezone-aware")
        return value


class ConversationTurn(ContractModel):
    turn_id: str = Field(min_length=1, max_length=256)
    run_id: str = Field(min_length=1, max_length=256)
    sequence: int = Field(ge=1)
    mode: Mode
    user: ConversationMessage
    assistant: ConversationMessage | None = None
    prompt_id: str = Field(min_length=1, max_length=128)
    prompt_version: str = Field(min_length=1, max_length=32)
    prompt_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    dropped_messages: int = Field(default=0, ge=0)
    estimated_context_tokens: int = Field(default=0, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)


class ConversationInput(ContractModel):
    content: str = Field(min_length=1, max_length=16_000)

    @field_validator("content")
    @classmethod
    def reject_control_payloads(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized or "\x00" in normalized:
            raise ValueError("conversation message is empty or contains NUL")
        return normalized
