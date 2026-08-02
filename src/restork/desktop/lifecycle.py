"""Fail-closed ownership lease between the native desktop shell and Core."""

from __future__ import annotations

import os
import signal
import stat
import threading

_PARENT_FD_ENV = "RESTORK_DESKTOP_PARENT_FD"
_PARENT_PID_ENV = "RESTORK_DESKTOP_PARENT_PID"


class DesktopParentLeaseError(RuntimeError):
    """The native parent lease is malformed or unsafe to monitor."""


def start_desktop_parent_lease_watchdog() -> bool:
    """Exit Core's process group when the owning Rust supervisor disappears.

    The Rust parent retains the only write end of an anonymous pipe. Kernel EOF
    therefore covers normal shutdown, a native crash, and SIGKILL without a
    polling race or dependence on PID reuse. Direct browser/CLI service mode has
    no lease and returns ``False``.
    """
    descriptor_value = os.environ.get(_PARENT_FD_ENV)
    parent_value = os.environ.get(_PARENT_PID_ENV)
    if descriptor_value is None and parent_value is None:
        return False
    if descriptor_value is None or parent_value is None:
        raise DesktopParentLeaseError("desktop parent lease is incomplete")
    try:
        descriptor = int(descriptor_value)
        parent_pid = int(parent_value)
    except ValueError as error:
        raise DesktopParentLeaseError("desktop parent lease is invalid") from error
    if descriptor < 3 or parent_pid < 2:
        raise DesktopParentLeaseError("desktop parent lease is invalid")
    if os.getppid() != parent_pid or os.getpgrp() != os.getpid():
        raise DesktopParentLeaseError("desktop parent ownership does not match Core")
    try:
        metadata = os.fstat(descriptor)
    except OSError as error:
        raise DesktopParentLeaseError("desktop parent lease descriptor is unavailable") from error
    if not stat.S_ISFIFO(metadata.st_mode):
        raise DesktopParentLeaseError("desktop parent lease must be an anonymous pipe")
    os.set_inheritable(descriptor, False)
    thread = threading.Thread(
        target=_watch_parent_lease,
        args=(descriptor,),
        name="restork-parent-lease",
        daemon=True,
    )
    thread.start()
    return True


def _watch_parent_lease(descriptor: int) -> None:
    try:
        while os.read(descriptor, 1):
            pass
    except OSError:
        pass
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass
    try:
        os.killpg(os.getpgrp(), signal.SIGTERM)
    except OSError:
        os._exit(0)
