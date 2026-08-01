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

    def resolve(self, reference: KeychainReference) -> str:
        service, separator, account = reference.value.removeprefix("keychain:").rpartition("/")
        if not separator or not service or not account:
            raise ValueError("invalid keychain reference")
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
