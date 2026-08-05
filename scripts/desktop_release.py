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
    config.add_argument(
        "--platform", choices=("generic", "macos", "windows", "linux"), default="generic"
    )
    config.add_argument("--version")
    config.add_argument("--signing-mode", choices=("protected", "ad-hoc"), default="protected")
    manifest = commands.add_parser("manifest")
    manifest.add_argument("--directory", type=Path, required=True)
    manifest.add_argument("--repository", required=True)
    manifest.add_argument("--tag", required=True)
    manifest.add_argument("--version", required=True)
    manifest.add_argument("--commit", default=os.environ.get("GITHUB_SHA", "unknown"))
    manifest.add_argument("--channel", choices=("alpha", "stable"), default="alpha")
    manifest.add_argument("--trust", choices=("protected", "ad-hoc"), default="protected")
    return parser


def _updater_config(
    output: Path,
    *,
    public_key: str,
    endpoint: str,
    platform: str = "generic",
    version: str | None = None,
    signing_mode: str = "protected",
) -> None:
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
    if version is not None and not _VERSION.fullmatch(version):
        raise ValueError("application version is invalid")
    if signing_mode == "ad-hoc" and platform != "macos":
        raise ValueError("ad-hoc release signing is supported only for macOS")
    bundle: dict[str, object] = {"createUpdaterArtifacts": True}
    if platform == "macos":
        bundle["targets"] = ["app", "dmg"]
        if signing_mode == "ad-hoc":
            bundle["macOS"] = {"signingIdentity": "-"}
    elif platform == "linux":
        bundle["targets"] = ["appimage", "deb"]
    elif platform == "windows":
        thumbprint = os.environ.get("RESTORK_WINDOWS_CERTIFICATE_THUMBPRINT", "").strip()
        timestamp_url = os.environ.get("RESTORK_WINDOWS_TIMESTAMP_URL", "").strip()
        parsed_timestamp = urlsplit(timestamp_url)
        if not re.fullmatch(r"[A-Fa-f0-9]{40,128}", thumbprint):
            raise ValueError("RESTORK_WINDOWS_CERTIFICATE_THUMBPRINT is missing or invalid")
        if parsed_timestamp.scheme != "https" or not parsed_timestamp.hostname:
            raise ValueError("RESTORK_WINDOWS_TIMESTAMP_URL must be HTTPS")
        bundle.update(
            {
                "targets": ["nsis", "msi"],
                "windows": {
                    "certificateThumbprint": thumbprint,
                    "digestAlgorithm": "sha256",
                    "timestampUrl": timestamp_url,
                },
            }
        )
    payload: dict[str, object] = {
        "bundle": bundle,
        "plugins": {"updater": {"endpoints": [endpoint], "pubkey": key}},
    }
    if version is not None:
        payload["version"] = version
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _signed_updater(directory: Path, patterns: tuple[str, ...]) -> tuple[Path, str] | None:
    candidates: list[Path] = []
    for pattern in patterns:
        candidates.extend(directory.glob(pattern))
    candidates = sorted(
        path for path in set(candidates) if path.is_file() and not path.name.endswith(".sig")
    )
    if not candidates:
        return None
    if len(candidates) != 1:
        raise ValueError(f"expected exactly one updater artifact for {patterns!r}")
    artifact = candidates[0]
    signature_path = artifact.with_name(f"{artifact.name}.sig")
    if not signature_path.is_file():
        raise ValueError(f"desktop updater signature is missing for {artifact.name}")
    signature = signature_path.read_text(encoding="utf-8").strip()
    if not 32 <= len(signature) <= 4096 or any(character.isspace() for character in signature):
        raise ValueError(f"desktop updater signature is invalid for {artifact.name}")
    return artifact, signature


def _download_url(repository: str, tag: str, path: Path) -> str:
    return (
        f"https://github.com/{repository}/releases/download/{quote(tag, safe='')}/"
        f"{quote(path.name, safe='')}"
    )


def _update_manifest(
    directory: Path,
    *,
    repository: str,
    tag: str,
    version: str,
    commit: str = "unknown",
    channel: str = "alpha",
    trust: str = "protected",
) -> None:
    if not _REPOSITORY.fullmatch(repository):
        raise ValueError("repository must use OWNER/NAME")
    if not _RELEASE_TAG.fullmatch(tag) or not _VERSION.fullmatch(version):
        raise ValueError("release tag or application version is invalid")
    if channel not in {"alpha", "stable"}:
        raise ValueError("release channel is invalid")
    if trust not in {"protected", "ad-hoc"}:
        raise ValueError("release trust tier is invalid")
    if trust == "ad-hoc" and channel != "alpha":
        raise ValueError("ad-hoc artifacts are restricted to the alpha channel")
    if commit != "unknown" and not re.fullmatch(r"[A-Fa-f0-9]{40}", commit):
        raise ValueError("release commit must be a full Git commit SHA")
    signed = {
        "darwin-aarch64": _signed_updater(directory, ("*.app.tar.gz",)),
        "windows-x86_64": _signed_updater(directory, ("*-setup.exe", "*_setup.exe")),
        "linux-x86_64": _signed_updater(directory, ("*.AppImage",)),
    }
    platforms = {
        platform: {
            "signature": updater[1],
            "url": _download_url(repository, tag, updater[0]),
        }
        for platform, updater in signed.items()
        if updater is not None
    }
    if not platforms:
        raise ValueError("desktop release has no signed updater artifacts")
    notes = (
        f"Restork {tag} is an ad-hoc-signed macOS Alpha. "
        "It has a Tauri updater signature but no Apple Developer ID or notarization."
        if trust == "ad-hoc"
        else f"Restork {tag}. See the GitHub release for verified release notes."
    )
    payload = {
        "version": version,
        "notes": notes,
        "pub_date": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "platforms": platforms,
    }
    latest = directory / "latest.json"
    latest.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    artifacts = sorted(
        path
        for path in directory.iterdir()
        if path.is_file()
        and path.name not in {"SHA256SUMS", "SHA256SUMS.asc", "release-manifest.json"}
    )
    artifact_records = [
        {
            "name": path.name,
            "sha256": _sha256(path),
            "bytes": path.stat().st_size,
            "url": _download_url(repository, tag, path),
        }
        for path in artifacts
    ]
    release_manifest = {
        "schema_version": 1,
        "repository": repository,
        "tag": tag,
        "version": version,
        "commit": commit,
        "channel": channel,
        "trust": trust,
        "workflow_run": os.environ.get("GITHUB_RUN_ID", "local"),
        "updater_targets": sorted(platforms),
        "artifacts": artifact_records,
    }
    (directory / "release-manifest.json").write_text(
        json.dumps(release_manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    artifacts.extend([directory / "release-manifest.json"])
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
                platform=arguments.platform,
                version=arguments.version,
                signing_mode=arguments.signing_mode,
            )
        else:
            _update_manifest(
                arguments.directory,
                repository=arguments.repository,
                tag=arguments.tag,
                version=arguments.version,
                commit=arguments.commit,
                channel=arguments.channel,
                trust=arguments.trust,
            )
    except (OSError, UnicodeError, ValueError) as error:
        raise SystemExit(f"desktop release: {error}") from error
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
