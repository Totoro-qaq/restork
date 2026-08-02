"""Platform-appropriate runtime locations, never the source checkout."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

from platformdirs import user_cache_path, user_data_path


def _runtime_root(values: Mapping[str, str], name: str, fallback: Path) -> Path:
    """Return one explicit operator-owned root after fail-closed normalization.

    Runtime-root environment variables are process-owner configuration, not
    request input. Requiring an absolute, non-root directory prevents an
    accidental relative checkout path or filesystem-root selection while still
    allowing private directories on external volumes.
    """

    raw_value = values.get(name)
    if raw_value is None:
        return Path(os.path.realpath(fallback.expanduser()))
    if not raw_value.strip() or "\x00" in raw_value:
        raise ValueError(f"{name} must be a non-empty absolute directory")
    expanded = os.path.expanduser(raw_value)
    if not os.path.isabs(expanded):
        raise ValueError(f"{name} must be an absolute directory")
    normalized = Path(os.path.realpath(expanded))
    if normalized == Path(normalized.anchor):
        raise ValueError(f"{name} must not select a filesystem root")
    return normalized


class RuntimePaths:
    """Configuration, durable data, and cache roots for one local user."""

    def __init__(self, *, config_dir: Path, data_dir: Path, cache_dir: Path) -> None:
        self.config_dir = config_dir
        self.data_dir = data_dir
        self.cache_dir = cache_dir

    @classmethod
    def from_environ(cls, environ: Mapping[str, str] | None = None) -> RuntimePaths:
        values = os.environ if environ is None else environ
        data_root = user_data_path("Restork", appauthor=False)
        return cls(
            config_dir=_runtime_root(values, "RESTORK_CONFIG_DIR", data_root / "config"),
            data_dir=_runtime_root(values, "RESTORK_DATA_DIR", data_root / "data"),
            cache_dir=_runtime_root(
                values,
                "RESTORK_CACHE_DIR",
                user_cache_path("Restork", appauthor=False),
            ),
        )
