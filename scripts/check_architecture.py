#!/usr/bin/env python3
"""Fail fast when Restork's composition roots start absorbing feature code again."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# These are composition roots and shared contracts, not feature dumping grounds.
# Budgets intentionally leave a little refactoring room while requiring new
# domains to get their own module before the next large feature lands.
LINE_BUDGETS = {
    "dashboard/src/main.ts": 4200,
    "dashboard/src/ui/render.ts": 2800,
    "dashboard/src/api/client.ts": 1600,
    "dashboard/src/api/types.ts": 1650,
    "rust/crates/restork-api/src/lib.rs": 3500,
    "rust/crates/restork-api/src/feature_api.rs": 3700,
    "rust/crates/restork-api/src/catalog_api.rs": 2500,
    "rust/crates/restork-api/src/session_api.rs": 1650,
    "rust/crates/restork-api/src/daily_api.rs": 1550,
    "desktop/src-tauri/src/lib.rs": 650,
    "desktop/src-tauri/src/commands.rs": 650,
    "desktop/src-tauri/src/update_commands.rs": 400,
    "desktop/src-tauri/src/update_runtime.rs": 325,
    "desktop/src-tauri/src/supervisor.rs": 475,
    "desktop/src-tauri/src/supervisor_windows.rs": 460,
    "desktop/src-tauri/src/updates.rs": 550,
    "desktop/src-tauri/src/vault_grant.rs": 360,
}

# These helpers previously existed in several feature slices with subtly
# different behavior. They now have one owner so future extraction cannot
# reintroduce copy/paste implementations.
SHARED_DEFINITION_OWNERS = {
    "activeView": "dashboard/src/ui/dom.ts",
    "bindRovingFocus": "dashboard/src/ui/dom.ts",
    "escapeMarkup": "dashboard/src/ui/dom.ts",
}


def source_lines(path: Path) -> int:
    return len(path.read_text(encoding="utf-8").splitlines())


def main() -> int:
    issues: list[str] = []
    for relative, maximum in LINE_BUDGETS.items():
        path = ROOT / relative
        if not path.is_file():
            issues.append(f"missing architecture boundary: {relative}")
            continue
        actual = source_lines(path)
        if actual > maximum:
            issues.append(
                f"{relative} has {actual} lines (budget {maximum}); "
                "extract the new domain into an owned module",
            )

    for path in sorted((ROOT / "dashboard/src/features").glob("*.ts")):
        source = path.read_text(encoding="utf-8")
        if re.search(r'from\s+["\']\.\./main["\']', source):
            issues.append(
                f"{path.relative_to(ROOT)} imports main.ts; inject a narrow effect interface instead",
            )

    dashboard_sources = sorted((ROOT / "dashboard/src").rglob("*.ts"))
    for function_name, expected_owner in SHARED_DEFINITION_OWNERS.items():
        definition = re.compile(rf"(?:export\s+)?function\s+{function_name}\s*\(")
        owners = [
            str(path.relative_to(ROOT))
            for path in dashboard_sources
            if definition.search(path.read_text(encoding="utf-8"))
        ]
        if owners != [expected_owner]:
            issues.append(
                f"{function_name} must have exactly one definition in {expected_owner}; "
                f"found {owners or 'none'}",
            )

    desktop_sources = sorted((ROOT / "desktop/src-tauri/src").glob("*.rs"))
    for path in desktop_sources:
        relative = str(path.relative_to(ROOT))
        source = path.read_text(encoding="utf-8")
        if relative != "desktop/src-tauri/src/vault_grant.rs" and "--vault-grant-file" in source:
            issues.append(
                f"{relative} owns the Vault launch bridge; keep it in vault_grant.rs",
            )
        if "--vault-dir" in source:
            issues.append(
                f"{relative} sends a Vault path through desktop argv; use the private grant bridge",
            )

    if issues:
        print("Architecture boundary check failed:", file=sys.stderr)
        for issue in issues:
            print(f"- {issue}", file=sys.stderr)
        return 1
    print("Architecture boundary check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
