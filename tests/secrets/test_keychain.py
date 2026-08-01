from __future__ import annotations

import subprocess

import pytest

from restork.config.models import KeychainReference
from restork.secrets.store import KeychainSecretStore


def test_keychain_store_uses_bounded_argument_list_and_returns_only_to_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[object] = []

    def fake_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured.extend((args, kwargs))
        return subprocess.CompletedProcess(
            args=["/usr/bin/security"],
            returncode=0,
            stdout="synthetic-value\n",
            stderr="",
        )

    monkeypatch.setattr("restork.secrets.store.subprocess.run", fake_run)

    resolved = KeychainSecretStore().resolve(
        KeychainReference(value="keychain:restork/provider/deepseek")
    )

    assert resolved == "synthetic-value"
    assert captured[0] == (
        [
            "/usr/bin/security",
            "find-generic-password",
            "-w",
            "-s",
            "restork/provider",
            "-a",
            "deepseek",
        ],
    )
    assert captured[1] == {"check": False, "capture_output": True, "text": True}


def test_keychain_store_does_not_echo_failed_command_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unavailable(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        del args, kwargs
        return subprocess.CompletedProcess(
            args=["/usr/bin/security"],
            returncode=44,
            stdout="synthetic-output-that-must-not-escape\n",
            stderr="synthetic-diagnostic-that-must-not-escape\n",
        )

    monkeypatch.setattr("restork.secrets.store.subprocess.run", unavailable)

    with pytest.raises(LookupError) as error:
        KeychainSecretStore().resolve(
            KeychainReference(value="keychain:restork/provider/deepseek")
        )

    assert "synthetic-output" not in str(error.value)
    assert "synthetic-diagnostic" not in str(error.value)
