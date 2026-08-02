from __future__ import annotations

import stat
from pathlib import Path

import pytest

from restork.config.loader import load_config
from restork.config.models import KeychainReference
from restork.providers.setup import ProviderSetupError, configure_provider


class FakeInteractiveStore:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.references: list[KeychainReference] = []

    def configure_interactively(self, reference: KeychainReference) -> None:
        self.references.append(reference)
        if self.fail:
            raise RuntimeError("synthetic prompt cancellation")


def test_provider_setup_prompts_then_creates_private_non_secret_config(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "private" / "config.toml"
    store = FakeInteractiveStore()

    result = configure_provider(config_path, store)

    assert result.config_created is True
    assert store.references[0].value == "keychain:restork/provider/deepseek"
    assert load_config(config_path).provider.model == "deepseek-v4-pro"
    assert stat.S_IMODE(config_path.stat().st_mode) == 0o600
    assert "API" not in config_path.read_text(encoding="utf-8")


def test_provider_setup_preserves_existing_valid_configuration(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    original = (
        "[provider]\n"
        'name = "deepseek"\n'
        'model = "deepseek-v4-pro"\n'
        'base_url = "https://api.deepseek.com"\n'
        'api_key_ref = "keychain:restork/custom/deepseek"\n'
        "thinking_enabled = true\n"
        'reasoning_effort = "high"\n'
    )
    config_path.write_text(original, encoding="utf-8")
    store = FakeInteractiveStore()

    result = configure_provider(config_path, store)

    assert result.config_created is False
    assert store.references[0].value == "keychain:restork/custom/deepseek"
    assert config_path.read_text(encoding="utf-8") == original


def test_provider_setup_cancellation_does_not_create_configuration(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"

    with pytest.raises(ProviderSetupError, match="not saved"):
        configure_provider(config_path, FakeInteractiveStore(fail=True))

    assert not config_path.exists()
