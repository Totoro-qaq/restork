#!/usr/bin/env python3
"""Export the canonical cross-runtime JSON Schema bundle deterministically."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from restork.schemas import contract_schemas


def render_bundle() -> str:
    bundle = {
        "bundle_version": 1,
        "protocol": "restork-v1",
        "schemas": contract_schemas(),
    }
    return json.dumps(bundle, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("contracts/restork-v1.schema.json"),
    )
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    rendered = render_bundle()
    if arguments.check:
        if not arguments.output.is_file() or arguments.output.read_text() != rendered:
            parser.error(f"{arguments.output} is stale; run scripts/export-contracts.py")
        return 0
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
