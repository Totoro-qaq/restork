#!/usr/bin/env python3
"""Fail when Dashboard and Core intent limits drift from the contract file."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "contracts/intent-limits.json"

CHECKS = [
    (ROOT / "dashboard/src/limits.ts", {
        "MIN_SLIDE_COUNT": "slide_count.min",
        "MAX_SLIDE_COUNT": "slide_count.max",
        "MIN_SCHEDULE_INTERVAL_DAYS": "schedule_interval_days.min",
        "MAX_SCHEDULE_INTERVAL_DAYS": "schedule_interval_days.max",
        "MAX_SKILL_IDS_PER_RUN": "skill_ids_per_run.max",
    }),
    (ROOT / "rust/crates/restork-api/src/presentation_api.rs", {
        "MIN_SLIDE_COUNT": "slide_count.min",
        "MAX_SLIDE_COUNT": "slide_count.max",
    }),
    (ROOT / "rust/crates/restork-api/src/run_skills.rs", {
        "MAX_SKILL_IDS_PER_RUN": "skill_ids_per_run.max",
    }),
    (ROOT / "rust/crates/restork-automation/src/lib.rs", {
        "MIN_INTERVAL_DAYS": "schedule_interval_days.min",
        "MAX_INTERVAL_DAYS": "schedule_interval_days.max",
    }),
]

def lookup(document: object, path: str) -> int:
    current: object = document
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            raise KeyError(path)
        current = current[part]
    if not isinstance(current, int):
        raise TypeError(path)
    return current


def assigned_int(source: str, name: str) -> int | None:
    match = re.search(rf"(?:pub(?:\s*\([^)]*\))?\s+)?(?:const\s+)?{name}\s*(?::[^=]+)?=\s*(\d+)", source)
    return int(match.group(1)) if match else None


def main() -> int:
    document = json.loads(CONTRACT.read_text(encoding="utf-8"))
    issues: list[str] = []
    for path, names in CHECKS:
        source = path.read_text(encoding="utf-8")
        for name, key in names.items():
            expected = lookup(document, key)
            actual = assigned_int(source, name)
            if actual is None:
                issues.append(f"{path.relative_to(ROOT)}: missing {name}")
            elif actual != expected:
                issues.append(
                    f"{path.relative_to(ROOT)}: {name} is {actual}, contract {key} is {expected}",
                )
    if issues:
        print("\n".join(issues), file=sys.stderr)
        return 1
    print("intent limits ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
