from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from restork.desktop.lifecycle import (
    DesktopParentLeaseError,
    start_desktop_parent_lease_watchdog,
)


def test_direct_service_mode_has_no_parent_lease(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RESTORK_DESKTOP_PARENT_FD", raising=False)
    monkeypatch.delenv("RESTORK_DESKTOP_PARENT_PID", raising=False)

    assert start_desktop_parent_lease_watchdog() is False


def test_incomplete_parent_lease_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RESTORK_DESKTOP_PARENT_FD", "7")
    monkeypatch.delenv("RESTORK_DESKTOP_PARENT_PID", raising=False)

    with pytest.raises(DesktopParentLeaseError, match="incomplete"):
        start_desktop_parent_lease_watchdog()


def test_core_exits_when_parent_lease_closes(tmp_path: Path) -> None:
    reader, writer = os.pipe()
    environment = os.environ.copy()
    environment["RESTORK_DESKTOP_PARENT_FD"] = str(reader)
    environment["RESTORK_DESKTOP_PARENT_PID"] = str(os.getpid())
    source_root = Path(__file__).parents[2] / "src"
    code = (
        "import os,time;"
        "from restork.desktop.lifecycle import start_desktop_parent_lease_watchdog;"
        "assert start_desktop_parent_lease_watchdog();"
        "open(os.environ['READY_FILE'],'w').close();"
        "time.sleep(30)"
    )
    ready = tmp_path / "ready"
    environment["READY_FILE"] = str(ready)
    process = subprocess.Popen(  # noqa: S603
        [sys.executable, "-c", code],
        env=environment,
        cwd=source_root.parent,
        pass_fds=(reader,),
        start_new_session=True,
    )
    os.close(reader)
    try:
        deadline = time.monotonic() + 3
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert ready.exists()
        os.close(writer)
        assert process.wait(timeout=3) == -signal.SIGTERM
    finally:
        try:
            os.close(writer)
        except OSError:
            pass
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
