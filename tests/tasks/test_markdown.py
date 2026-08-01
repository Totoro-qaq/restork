from __future__ import annotations

from datetime import date

import pytest

from restork.tasks.markdown import parse_tasks, render_restork_task


def test_parse_canonical_and_legacy_tasks_preserves_unknown_fields() -> None:
    markdown = (
        "- [ ] Ship Restork #todo [due:: 2026-08-15] [priority:: P1] [custom:: keep] "
        "^restork-01abc\n- [x] Legacy item [project:: [[Restork]]]\n"
    )
    tasks = parse_tasks("Inbox.md", markdown)

    assert tasks[0].is_restork_created is True
    assert tasks[0].fields["custom"] == "keep"
    assert tasks[1].completed is True
    assert tasks[1].block_id is None


def test_render_restork_task_uses_canonical_syntax() -> None:
    task = render_restork_task(
        "Implement API",
        "restork-01abc",
        due=date(2026, 8, 15),
        priority="P1",
        project="[[Restork]]",
    )
    assert task == (
        "- [ ] Implement API #todo [due:: 2026-08-15] [priority:: P1] "
        "[project:: [[Restork]]] ^restork-01abc"
    )


def test_invalid_task_fields_fail_closed() -> None:
    with pytest.raises(ValueError, match="priority"):
        parse_tasks("Inbox.md", "- [ ] Bad [priority:: urgent]")
