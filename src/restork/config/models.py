"""Strict, non-secret configuration contracts."""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ConfigModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class KeychainReference(ConfigModel):
    value: str = Field(min_length=10)

    @field_validator("value")
    @classmethod
    def require_keychain_scheme(cls, value: str) -> str:
        if re.fullmatch(r"keychain:[A-Za-z0-9._/-]+", value) is None:
            msg = "secret references must use keychain:<service>/<account>"
            raise ValueError(msg)
        return value


class ProviderConfig(ConfigModel):
    name: str = "deepseek"
    model: str = "deepseek-v4-pro"
    base_url: str = "https://api.deepseek.com"
    api_key_ref: KeychainReference
    thinking_enabled: bool = True
    reasoning_effort: str = "high"

    @field_validator("api_key_ref", mode="before")
    @classmethod
    def coerce_keychain_reference(cls, value: Any) -> Any:
        return {"value": value} if isinstance(value, str) else value


class AppConfig(ConfigModel):
    provider: ProviderConfig
