"""macOS Keychain access with no plaintext configuration or logging."""

from __future__ import annotations

# This module invokes only the absolute, argument-list-only macOS Keychain binary below.
import subprocess  # nosec B404
from typing import Protocol

from restork.config.models import KeychainReference


class SecretResolver(Protocol):
    def resolve(self, reference: KeychainReference) -> str: ...


class KeychainSecretStore:
    """Resolve ``keychain:<service>/<account>`` using the macOS Keychain."""

    def exists(self, reference: KeychainReference) -> bool:
        """Check item metadata without requesting or returning its secret value."""

        service, account = _reference_parts(reference)
        completed = subprocess.run(  # nosec B603
            [
                "/usr/bin/security",
                "find-generic-password",
                "-s",
                service,
                "-a",
                account,
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        return completed.returncode == 0

    def configure_interactively(self, reference: KeychainReference) -> None:
        """Prompt inside ``security`` so the secret never enters Python arguments."""

        service, account = _reference_parts(reference)
        completed = subprocess.run(  # nosec B603
            [
                "/usr/bin/security",
                "add-generic-password",
                "-U",
                "-a",
                account,
                "-s",
                service,
                # Apple recommends placing -w last so `security` prompts.
                "-w",
            ],
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError("Keychain update did not complete")

    def resolve(self, reference: KeychainReference) -> str:
        service, account = _reference_parts(reference)
        # ``service`` and ``account`` were constrained by ``KeychainReference``.
        completed = subprocess.run(  # nosec B603
            ["/usr/bin/security", "find-generic-password", "-w", "-s", service, "-a", account],
            check=False,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            raise LookupError("Keychain item is unavailable")
        secret = completed.stdout.rstrip("\n")
        if not secret:
            raise LookupError("Keychain item is empty")
        return secret


def _reference_parts(reference: KeychainReference) -> tuple[str, str]:
    service, separator, account = reference.value.removeprefix("keychain:").rpartition("/")
    if not separator or not service or not account:
        raise ValueError("invalid keychain reference")
    return service, account
