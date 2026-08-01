"""TOML configuration loading without secret-value support."""

from __future__ import annotations

import tomllib
from pathlib import Path

from restork.config.models import AppConfig


def load_config(path: Path) -> AppConfig:
    """Load one external TOML file into strict, non-secret configuration."""
    with path.open("rb") as config_file:
        document = tomllib.load(config_file)
    return AppConfig.model_validate(document)
