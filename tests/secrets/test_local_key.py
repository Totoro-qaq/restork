from __future__ import annotations

import os
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from restork.secrets.local_key import LocalEncryptionKeyStore


def test_local_encryption_key_is_user_only_and_restart_stable(tmp_path: Path) -> None:
    path = tmp_path / "private" / "transient.key"
    store = LocalEncryptionKeyStore()

    created = store.load_or_create(path)
    restarted = LocalEncryptionKeyStore().load_or_create(path)

    assert created == restarted
    assert path.stat().st_mode & 0o077 == 0
    assert Fernet(created).decrypt(Fernet(restarted).encrypt(b"restart")) == b"restart"


def test_local_encryption_key_rejects_symlinks_and_permissive_files(
    tmp_path: Path,
) -> None:
    outside = tmp_path / "outside.key"
    outside.write_bytes(Fernet.generate_key())
    linked = tmp_path / "linked.key"
    linked.symlink_to(outside)

    with pytest.raises(PermissionError, match="regular"):
        LocalEncryptionKeyStore().load_or_create(linked)

    permissive = tmp_path / "permissive.key"
    permissive.write_bytes(Fernet.generate_key())
    os.chmod(permissive, 0o644)
    with pytest.raises(PermissionError, match="0600"):
        LocalEncryptionKeyStore().load_or_create(permissive)


def test_local_encryption_key_fails_closed_when_restore_requires_key(
    tmp_path: Path,
) -> None:
    path = tmp_path / "missing.key"

    with pytest.raises(FileNotFoundError, match="restore the key"):
        LocalEncryptionKeyStore().load_or_create(path, require_existing=True)

    assert not path.exists()
