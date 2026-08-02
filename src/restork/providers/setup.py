"""Safe local setup for the DeepSeek provider and macOS Keychain reference."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from restork.config.loader import load_config
from restork.config.models import KeychainReference, ProviderConfig

DEFAULT_KEYCHAIN_REFERENCE = KeychainReference(
    value="keychain:restork/provider/deepseek"
)

_DEFAULT_CONFIG = """[provider]
name = "deepseek"
model = "deepseek-v4-pro"
base_url = "https://api.deepseek.com"
api_key_ref = "keychain:restork/provider/deepseek"
thinking_enabled = true
reasoning_effort = "high"
"""


class ProviderSetupError(RuntimeError):
    """A safe setup failure that never contains credential material."""


@dataclass(frozen=True)
class ProviderSetupResult:
    config_path: Path
    config_created: bool


class InteractiveSecretStore(Protocol):
    def configure_interactively(self, reference: KeychainReference) -> None: ...


def configure_provider(
    config_path: Path,
    keychain: InteractiveSecretStore,
) -> ProviderSetupResult:
    """Prompt for the key, then create a non-secret config when it is absent."""

    if config_path.exists():
        try:
            provider = load_config(config_path).provider
        except (OSError, ValueError) as error:
            raise ProviderSetupError(
                "Existing provider configuration is invalid; fix it before changing Keychain"
            ) from error
        created = False
    else:
        provider = ProviderConfig(api_key_ref=DEFAULT_KEYCHAIN_REFERENCE)
        created = True
    try:
        keychain.configure_interactively(provider.api_key_ref)
    except (OSError, RuntimeError, ValueError) as error:
        raise ProviderSetupError("DeepSeek API key was not saved") from error
    if created:
        _write_new_config(config_path)
    return ProviderSetupResult(config_path=config_path, config_created=created)


def _write_new_config(config_path: Path) -> None:
    try:
        config_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(  # noqa: PTH123
            config_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as config_file:
            config_file.write(_DEFAULT_CONFIG)
            config_file.flush()
            os.fsync(config_file.fileno())
    except OSError as error:
        raise ProviderSetupError("Provider configuration could not be created") from error
