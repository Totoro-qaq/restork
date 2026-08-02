"""One-shot bootstrap handoff from the Core to its desktop parent."""

from __future__ import annotations

import json
import os
import stat
from datetime import UTC, datetime


def write_desktop_bootstrap(descriptor: int, *, port: int, pairing_code: str) -> None:
    """Write one bounded payload to an inherited anonymous pipe, then close it."""
    if isinstance(descriptor, bool) or not isinstance(descriptor, int) or descriptor < 3:
        raise ValueError("desktop bootstrap descriptor is invalid")
    owned_descriptor = descriptor
    try:
        metadata = os.fstat(owned_descriptor)
        if not stat.S_ISFIFO(metadata.st_mode):
            raise PermissionError("desktop bootstrap descriptor must be a pipe")
        os.set_inheritable(owned_descriptor, False)
        if not 1 <= port <= 65535:
            raise ValueError("desktop bootstrap port is invalid")
        if not 16 <= len(pairing_code) <= 256 or "\x00" in pairing_code:
            raise ValueError("desktop pairing code shape is invalid")
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
        if len(payload) > 4096:
            raise ValueError("desktop bootstrap payload is too large")
        handle = os.fdopen(owned_descriptor, "wb", closefd=True)
        owned_descriptor = -1
        with handle:
            handle.write(payload)
            handle.flush()
    finally:
        if owned_descriptor >= 0:
            try:
                os.close(owned_descriptor)
            except OSError:
                pass
