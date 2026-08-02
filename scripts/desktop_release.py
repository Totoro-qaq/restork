#!/usr/bin/env python3
"""Create fail-closed Tauri release configuration and update metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote, urlsplit

_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_RELEASE_TAG = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$")
_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    config = commands.add_parser("config")
    config.add_argument("--output", type=Path, required=True)
    manifest = commands.add_parser("manifest")
    manifest.add_argument("--directory", type=Path, required=True)
    manifest.add_argument("--repository", required=True)
    manifest.add_argument("--tag", required=True)
    manifest.add_argument("--version", required=True)
    return parser


def _updater_config(output: Path, *, public_key: str, endpoint: str) -> None:
    key = public_key.strip()
    if not 32 <= len(key) <= 4096 or "PRIVATE KEY" in key.upper() or "\x00" in key:
        raise ValueError("RESTORK_UPDATER_PUBLIC_KEY is missing or invalid")
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("RESTORK_UPDATER_ENDPOINT must be a credential-free HTTPS URL")
    payload = {
        "bundle": {"createUpdaterArtifacts": True},
        "plugins": {"updater": {"endpoints": [endpoint], "pubkey": key}},
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _update_manifest(directory: Path, *, repository: str, tag: str, version: str) -> None:
    if not _REPOSITORY.fullmatch(repository):
        raise ValueError("repository must use OWNER/NAME")
    if not _RELEASE_TAG.fullmatch(tag) or not _VERSION.fullmatch(version):
        raise ValueError("release tag or application version is invalid")
    archives = sorted(directory.glob("*.app.tar.gz"))
    disks = sorted(directory.glob("*.dmg"))
    if len(archives) != 1 or len(disks) != 1:
        raise ValueError("desktop release needs exactly one app archive and one DMG")
    archive = archives[0]
    signature_path = archive.with_name(f"{archive.name}.sig")
    if not signature_path.is_file():
        raise ValueError("desktop updater signature is missing")
    signature = signature_path.read_text(encoding="utf-8").strip()
    if not 32 <= len(signature) <= 4096 or any(character.isspace() for character in signature):
        raise ValueError("desktop updater signature is invalid")
    download_url = (
        f"https://github.com/{repository}/releases/download/{quote(tag, safe='')}/"
        f"{quote(archive.name, safe='')}"
    )
    payload = {
        "version": version,
        "notes": f"Restork {tag}. See the GitHub release for verified release notes.",
        "pub_date": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "platforms": {
            "darwin-aarch64": {
                "signature": signature,
                "url": download_url,
            }
        },
    }
    latest = directory / "latest.json"
    latest.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    artifacts = [*archives, *disks, signature_path, latest]
    (directory / "SHA256SUMS").write_text(
        "".join(f"{_sha256(path)}  {path.name}\n" for path in sorted(artifacts)),
        encoding="utf-8",
    )


def main() -> int:
    arguments = _parser().parse_args()
    try:
        if arguments.command == "config":
            _updater_config(
                arguments.output,
                public_key=os.environ.get("RESTORK_UPDATER_PUBLIC_KEY", ""),
                endpoint=os.environ.get("RESTORK_UPDATER_ENDPOINT", ""),
            )
        else:
            _update_manifest(
                arguments.directory,
                repository=arguments.repository,
                tag=arguments.tag,
                version=arguments.version,
            )
    except (OSError, UnicodeError, ValueError) as error:
        raise SystemExit(f"desktop release: {error}") from error
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
