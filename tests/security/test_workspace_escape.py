from __future__ import annotations

import ast
from pathlib import Path

from restork.contracts.types import Mode
from restork.modes.base import profile_for


def test_work_v1_has_no_executor_shell_network_or_repository_write_path() -> None:
    source_root = Path(__file__).parents[2] / "src" / "restork" / "work"
    forbidden_imports = {"asyncio.subprocess", "requests", "socket", "subprocess", "urllib"}
    forbidden_calls = {"eval", "exec", "popen", "spawn", "system"}

    for path in source_root.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                assert not ({alias.name for alias in node.names} & forbidden_imports)
            elif isinstance(node, ast.ImportFrom):
                assert node.module not in forbidden_imports
            elif isinstance(node, ast.Call):
                name = (
                    node.func.id
                    if isinstance(node.func, ast.Name)
                    else node.func.attr
                    if isinstance(node.func, ast.Attribute)
                    else ""
                )
                assert name.casefold() not in forbidden_calls

    profile = profile_for(Mode.WORK)
    assert profile.allowed_tools == frozenset({"vault_search", "handoff_export"})
    assert all(
        marker not in tool
        for tool in profile.allowed_tools
        for marker in ("deploy", "executor", "network", "repository_write", "shell")
    )
