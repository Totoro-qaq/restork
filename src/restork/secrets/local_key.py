"""Durable user-only encryption key for restart-safe transient state."""

from __future__ import annotations

import os
import stat
from pathlib import Path

from cryptography.fernet import Fernet


class LocalEncryptionKeyStore:
    """Create once with mode 0600, then reuse without exposing the key."""

    def load_or_create(self, path: Path, *, require_existing: bool = False) -> bytes:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return self._load(path)
        if require_existing:
            os.close(descriptor)
            path.unlink(missing_ok=True)
            raise FileNotFoundError(
                "transient encryption key is missing; restore the key that matches "
                "the existing database"
            )
        key = Fernet.generate_key()
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(key)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            try:
                path.unlink()
            except OSError:
                pass
            raise
        return key

    @staticmethod
    def _load(path: Path) -> bytes:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
            raise PermissionError("transient encryption key must be a regular file")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise PermissionError("transient encryption key must have mode 0600")
        try:
            key = path.read_bytes()
            Fernet(key)
        except (OSError, ValueError) as error:
            raise ValueError("transient encryption key is invalid") from error
        return key
