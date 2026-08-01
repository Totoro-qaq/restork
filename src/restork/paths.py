"""Platform-appropriate runtime locations, never the source checkout."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

from platformdirs import user_cache_path, user_data_path


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
            config_dir=Path(values["RESTORK_CONFIG_DIR"]).expanduser()
            if "RESTORK_CONFIG_DIR" in values
            else data_root / "config",
            data_dir=Path(values["RESTORK_DATA_DIR"]).expanduser()
            if "RESTORK_DATA_DIR" in values
            else data_root / "data",
            cache_dir=Path(values["RESTORK_CACHE_DIR"]).expanduser()
            if "RESTORK_CACHE_DIR" in values
            else user_cache_path("Restork", appauthor=False),
        )
