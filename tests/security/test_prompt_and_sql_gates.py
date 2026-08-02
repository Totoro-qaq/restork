from __future__ import annotations

import ast
from pathlib import Path

import pytest
from pydantic import ValidationError

from restork.prompts.registry import get_prompt, prompt_manifest
from restork.providers.base import ChatCompletionRequest, ChatMessage


def test_sec_prompt_001_registry_has_immutable_complete_metadata() -> None:
    manifest = prompt_manifest()
    identities = {(item["prompt_id"], item["version"]) for item in manifest}

    assert len(identities) == len(manifest)
    assert {item["prompt_id"] for item in manifest} >= {
        "agent.loop.system",
        "research.synthesis.system",
        "conversation.research.system",
        "conversation.study.system",
        "conversation.work.system",
    }
    for item in manifest:
        assert len(str(item["content_hash"])) == 64
        definition = get_prompt(str(item["prompt_id"]), str(item["version"]))
        assert definition.content_hash == item["content_hash"]
        assert "untrusted" in definition.content.casefold()


def test_sec_prompt_002_model_requests_reject_partial_prompt_metadata() -> None:
    with pytest.raises(ValidationError, match="prompt metadata"):
        ChatCompletionRequest(
            messages=[ChatMessage(role="user", content="synthetic")],
            prompt_id="conversation.research.system",
        )


def test_sec_sql_001_sqlite_calls_cannot_build_queries_from_dynamic_expressions() -> None:
    source_root = Path(__file__).parents[2] / "src" / "restork"
    failures: list[str] = []
    for path in source_root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        assignments = _string_assignments(tree)
        for node in ast.walk(tree):
            if not _is_sqlite_call(node) or not node.args:
                continue
            if not _is_static_sql(node.args[0], assignments, seen=set()):
                failures.append(f"{path.relative_to(source_root)}:{node.lineno}")
    assert failures == [], "dynamic SQL expression(s): " + ", ".join(failures)


def _is_sqlite_call(node: ast.AST) -> bool:
    if (
        not isinstance(node, ast.Call)
        or not isinstance(node.func, ast.Attribute)
        or node.func.attr not in {"execute", "executemany", "executescript"}
    ):
        return False
    receiver = node.func.value
    receiver_name = (
        receiver.id
        if isinstance(receiver, ast.Name)
        else receiver.attr
        if isinstance(receiver, ast.Attribute)
        else ""
    )
    return receiver_name in {"_connection", "connection", "cursor"}


def _string_assignments(tree: ast.AST) -> dict[str, list[ast.AST]]:
    assignments: dict[str, list[ast.AST]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assignments.setdefault(target.id, []).append(node.value)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.value is not None:
                assignments.setdefault(node.target.id, []).append(node.value)
    return assignments


def _is_static_sql(
    expression: ast.AST,
    assignments: dict[str, list[ast.AST]],
    *,
    seen: set[str],
) -> bool:
    if isinstance(expression, ast.Constant):
        return isinstance(expression.value, str)
    if not isinstance(expression, ast.Name) or expression.id in seen:
        return False
    values = assignments.get(expression.id, [])
    return bool(values) and all(
        _is_static_sql(value, assignments, seen={*seen, expression.id})
        for value in values
    )
