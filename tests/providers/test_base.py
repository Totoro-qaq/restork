from __future__ import annotations

import pytest
from pydantic import ValidationError

from restork.providers.base import (
    ChatCompletion,
    ChatCompletionRequest,
    ChatMessage,
    ChatToolDefinition,
    ToolCall,
)


def test_chat_message_roles_fail_closed_on_invalid_shapes() -> None:
    with pytest.raises(ValidationError, match="content only"):
        ChatMessage(role="user", content="hello", reasoning_content="not allowed")
    with pytest.raises(ValidationError, match="content or tool calls"):
        ChatMessage(role="assistant")
    with pytest.raises(ValidationError, match="tool_call_id"):
        ChatMessage(role="tool", content="result")


def test_tool_choice_and_completion_require_concrete_contracts() -> None:
    with pytest.raises(ValidationError, match="tool_choice"):
        ChatCompletionRequest(
            messages=[ChatMessage(role="user", content="hello")],
            tool_choice="required",
        )
    with pytest.raises(ValidationError, match="content or tool calls"):
        ChatCompletion(completion_id="empty", model="model")
    with pytest.raises(ValidationError, match="JSON object schema"):
        ChatToolDefinition(name="bad", description="bad", parameters={"type": "string"})
    with pytest.raises(ValidationError, match="JSON serializable"):
        ToolCall(tool_call_id="call", name="bad", arguments={"value": object()})
