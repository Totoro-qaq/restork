"""Command-line entry point for the Restork Core."""

from __future__ import annotations

import argparse
from collections.abc import Sequence

from restork import __version__


def _parser() -> argparse.ArgumentParser:
    return argparse.ArgumentParser(
        prog="restork",
        add_help=False,
        description=(
            "Restork is a local-first agent workspace for Research, Study, and Work."
        ),
    )


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command-line interface and return a process exit status."""
    parser = _parser()
    parser.add_argument("-h", "--help", action="store_true", help="show this help message and exit")
    parser.add_argument("--version", action="store_true", help="show the Restork version and exit")
    arguments = parser.parse_args(argv)

    if arguments.version:
        print(f"restork {__version__}")
        return 0

    parser.print_help()
    return 0
