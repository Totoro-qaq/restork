"""Owner-only atomic bootstrap handoff from the Core to its desktop parent."""

from __future__ import annotations

import json
import os
import stat
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4


def write_desktop_bootstrap(path: Path, *, port: int, pairing_code: str) -> None:
    """Publish one complete bootstrap file without replacing an existing target."""
    if not path.is_absolute() or path == Path(path.anchor):
        raise ValueError("desktop bootstrap path must be an absolute file path")
    if not 1 <= port <= 65535:
        raise ValueError("desktop bootstrap port is invalid")
    if not 16 <= len(pairing_code) <= 256 or "\x00" in pairing_code:
        raise ValueError("desktop pairing code shape is invalid")
    parent = path.parent
    parent_metadata = parent.lstat()
    if not stat.S_ISDIR(parent_metadata.st_mode) or parent.is_symlink():
        raise PermissionError("desktop bootstrap parent must be a real directory")
    if hasattr(os, "getuid") and parent_metadata.st_uid != os.getuid():
        raise PermissionError("desktop bootstrap parent must be owned by this user")
    if stat.S_IMODE(parent_metadata.st_mode) & 0o077:
        raise PermissionError("desktop bootstrap parent must have mode 0700")

    payload = json.dumps(
        {
            "schema_version": 1,
            "pid": os.getpid(),
            "port": port,
            "pairing_code": pairing_code,
            "issued_at": datetime.now(UTC).isoformat(),
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode() + b"\n"
    temporary = parent / f".{path.name}.{uuid4().hex}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, path, follow_symlinks=False)
        directory_descriptor = os.open(parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        temporary.unlink(missing_ok=True)
