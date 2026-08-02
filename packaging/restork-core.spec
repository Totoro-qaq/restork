# -*- mode: python ; coding: utf-8 -*-
"""Reproducible PyInstaller onedir definition for the desktop Core."""

from pathlib import Path


PROJECT_ROOT = Path(SPECPATH).resolve().parent
SOURCE_ROOT = PROJECT_ROOT / "src"

analysis = Analysis(
    [str(PROJECT_ROOT / "packaging" / "restork_core_entry.py")],
    pathex=[str(SOURCE_ROOT)],
    binaries=[],
    datas=[(str(SOURCE_ROOT / "restork" / "web"), "restork/web")],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "bandit",
        "mypy",
        "PIL",
        "pytest",
        "ruff",
    ],
    noarchive=False,
    optimize=1,
)

python_archive = PYZ(analysis.pure)

executable = EXE(
    python_archive,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="restork-core",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

bundle = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="restork-core",
)
