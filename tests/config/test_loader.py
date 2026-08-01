from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from restork.config.loader import load_config
from restork.config.models import KeychainReference, ProviderConfig
from restork.paths import RuntimePaths


def test_loader_accepts_secret_references_but_not_secret_values(tmp_path: Path) -> None:
    config_file = tmp_path / "config.toml"
    config_file.write_text(
        """
[provider]
name = "deepseek"
model = "deepseek-v4-pro"
base_url = "https://api.deepseek.com"
api_key_ref = "keychain:restork/provider/deepseek"
""".strip(),
        encoding="utf-8",
    )

    config = load_config(config_file)

    assert config.provider.api_key_ref.value == "keychain:restork/provider/deepseek"

    config_file.write_text("[provider]\napi_key = \"not-allowed\"", encoding="utf-8")
    with pytest.raises(ValidationError):
        load_config(config_file)


def test_keychain_reference_requires_the_keychain_scheme() -> None:
    with pytest.raises(ValidationError):
        KeychainReference(value="actual-secret")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("model", "deepseek-chat"),
        ("base_url", "https://api.deepseek.com/beta"),
        ("reasoning_effort", "medium"),
        ("reasoning_effort", "max"),
    ],
)
def test_provider_config_rejects_retired_or_noncanonical_settings(field: str, value: str) -> None:
    with pytest.raises(ValidationError):
        ProviderConfig(api_key_ref="keychain:restork/deepseek", **{field: value})


def test_runtime_paths_honor_explicit_environment_overrides(tmp_path: Path) -> None:
    paths = RuntimePaths.from_environ(
        {
            "RESTORK_CONFIG_DIR": str(tmp_path / "config"),
            "RESTORK_DATA_DIR": str(tmp_path / "data"),
            "RESTORK_CACHE_DIR": str(tmp_path / "cache"),
        },
    )

    assert paths.config_dir == tmp_path / "config"
    assert paths.data_dir == tmp_path / "data"
    assert paths.cache_dir == tmp_path / "cache"
