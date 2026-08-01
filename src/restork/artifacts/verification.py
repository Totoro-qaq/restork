"""Completion requires at least one verifiable artifact reference."""

from __future__ import annotations


def verify_artifacts(artifacts: list[str]) -> None:
    if not artifacts or any(not item.strip() for item in artifacts):
        raise ValueError("run cannot complete without a verifiable artifact")
