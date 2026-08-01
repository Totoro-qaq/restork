"""Validate every tool exposure against task and mode policy."""

from __future__ import annotations

from restork.contracts.task import TaskSpec
from restork.modes.base import profile_for


class ToolRegistry:
    def validate(self, task: TaskSpec, tool_name: str) -> None:
        profile = profile_for(task.mode)
        if tool_name not in profile.allowed_tools:
            raise PermissionError("tool is not allowed by the current mode")
        if tool_name not in task.tool_policy.allowed_tools:
            raise PermissionError("tool is not allowed by the task policy")
