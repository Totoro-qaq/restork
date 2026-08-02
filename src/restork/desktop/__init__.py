"""Contracts used only by the thin native desktop supervisor."""

from restork.desktop.bootstrap import write_desktop_bootstrap
from restork.desktop.lifecycle import start_desktop_parent_lease_watchdog

__all__ = ["start_desktop_parent_lease_watchdog", "write_desktop_bootstrap"]
