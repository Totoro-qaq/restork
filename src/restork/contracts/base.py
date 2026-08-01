"""Shared strict-model behavior for public Restork contracts."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class ContractModel(BaseModel):
    """A serializable V1 envelope that fails closed on unknown fields."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    schema_version: int = 1
