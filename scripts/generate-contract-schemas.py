#!/usr/bin/env python3
"""Write stable JSON Schema files from the Core's versioned contracts."""

from __future__ import annotations

import json
from pathlib import Path

from restork.schemas import contract_schemas


def main() -> None:
    output_dir = Path("schemas")
    output_dir.mkdir(exist_ok=True)
    for name, schema in contract_schemas().items():
        filename = "".join(
            f"-{character.lower()}" if character.isupper() else character for character in name
        )
        (output_dir / f"{filename.lstrip('-')}.schema.json").write_text(
            json.dumps(schema, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()
