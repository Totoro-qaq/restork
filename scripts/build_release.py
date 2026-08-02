#!/usr/bin/env python3
"""Build, compare, inspect, and manifest reproducible Restork artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from scan_public_artifacts import _content_issues, _path_issues

_README_ASSETS = {
    "README.md",
    "README.zh-CN.md",
    "assets/readme/architecture.svg",
    "assets/readme/architecture.zh-CN.svg",
    "assets/readme/demo-hd.gif",
    "assets/readme/demo-poster.webp",
    "assets/readme/hero.svg",
    "assets/readme/hero.zh-CN.svg",
}
_SOURCE_DATE_EPOCH = 1_785_571_200


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build reproducible, public-only Restork release artifacts."
    )
    parser.add_argument("--output", type=Path, default=Path("dist/release"))
    parser.add_argument("--source-date-epoch", type=int, default=_SOURCE_DATE_EPOCH)
    return parser


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _build(target: Path, epoch: int) -> dict[str, str]:
    environment = dict(os.environ)
    environment["SOURCE_DATE_EPOCH"] = str(epoch)
    subprocess.run(
        ["uv", "build", "--no-sources", "--out-dir", str(target)],
        check=True,
        env=environment,
    )
    artifacts = sorted(
        path for path in target.iterdir() if path.suffix == ".whl" or path.name.endswith(".tar.gz")
    )
    if len(artifacts) != 2:
        raise RuntimeError("release build must produce exactly one wheel and one source archive")
    return {path.name: _sha256(path) for path in artifacts}


def _safe_member(name: str, payload: bytes) -> None:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise RuntimeError(f"release archive contains an unsafe path: {name}")
    relative = path.as_posix()
    issues = [*_path_issues(relative), *_content_issues(payload)]
    if issues:
        raise RuntimeError(f"release archive rejected {name}: {', '.join(issues)}")


def _inspect_wheel(path: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        for member in archive.infolist():
            if member.is_dir():
                continue
            if (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise RuntimeError(f"wheel contains a symbolic link: {member.filename}")
            _safe_member(member.filename, archive.read(member))
    required = {
        "restork/web/index.html",
        "restork/web/favicon.svg",
    }
    if not required <= names:
        raise RuntimeError("wheel is missing the bundled Dashboard")


def _inspect_source(path: Path) -> None:
    with tarfile.open(path, "r:gz") as archive:
        names = {member.name for member in archive.getmembers()}
        for member in archive.getmembers():
            if member.issym() or member.islnk() or member.isdev():
                raise RuntimeError(f"source archive contains a special entry: {member.name}")
            if not member.isfile():
                continue
            extracted = archive.extractfile(member)
            if extracted is None:
                raise RuntimeError(f"source archive entry could not be read: {member.name}")
            _safe_member(member.name, extracted.read())
    if not all(any(name.endswith(asset) for name in names) for asset in _README_ASSETS):
        raise RuntimeError("source archive is missing one or more public README assets")


def _commit() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        capture_output=True,
        check=False,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else "source-archive"


def main() -> int:
    arguments = _parser().parse_args()
    if arguments.source_date_epoch < 0:
        raise SystemExit("SOURCE_DATE_EPOCH must be non-negative")
    output = arguments.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="restork-release-") as temporary:
        root = Path(temporary)
        first = root / "first"
        second = root / "second"
        first.mkdir()
        second.mkdir()
        first_hashes = _build(first, arguments.source_date_epoch)
        second_hashes = _build(second, arguments.source_date_epoch)
        if first_hashes != second_hashes:
            raise SystemExit("release artifacts are not reproducible")
        for name in sorted(first_hashes):
            source = first / name
            if name.endswith(".whl"):
                _inspect_wheel(source)
            else:
                _inspect_source(source)
            shutil.copyfile(source, output / name)

    artifacts = [
        {
            "name": name,
            "sha256": digest,
            "size": (output / name).stat().st_size,
        }
        for name, digest in sorted(first_hashes.items())
    ]
    manifest = {
        "schema_version": 1,
        "source_commit": _commit(),
        "source_date_epoch": arguments.source_date_epoch,
        "artifacts": artifacts,
        "privacy": "public source and synthetic README assets only",
        "reproducible": True,
    }
    (output / "release-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output / "SHA256SUMS").write_text(
        "".join(f"{item['sha256']}  {item['name']}\n" for item in artifacts),
        encoding="utf-8",
    )
    print(f"Wrote reproducible release bundle to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
