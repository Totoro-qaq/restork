from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from restork.daily.calendar import LocalCalendar
from restork.daily.models import DailyStatus


def test_calendar_reads_bounded_events_and_redacts_private_titles(tmp_path: Path) -> None:
    calendar_file = tmp_path / "calendar.ics"
    calendar_file.write_text(
        "\r\n".join(
            (
                "BEGIN:VCALENDAR",
                "VERSION:2.0",
                "BEGIN:VEVENT",
                "UID:public-1",
                "DTSTART:20260802T030000Z",
                "DTEND:20260802T040000Z",
                "SUMMARY:Review synthetic evidence",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:private-1",
                "DTSTART:20260802T050000Z",
                "DTEND:20260802T060000Z",
                "SUMMARY:Private appointment",
                "CLASS:PRIVATE",
                "END:VEVENT",
                "END:VCALENDAR",
                "",
            )
        ),
        encoding="utf-8",
    )

    snapshot = LocalCalendar(tmp_path).snapshot(
        "calendar.ics",
        "Asia/Shanghai",
        now=datetime(2026, 8, 2, 2, tzinfo=UTC),
    )

    assert snapshot.status is DailyStatus.READY
    assert [event.title for event in snapshot.events] == [
        "Review synthetic evidence",
        "Busy",
    ]
    assert snapshot.events[1].redacted is True


def test_calendar_rejects_traversal_and_symlink_inputs(tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside.ics"
    outside.write_text("BEGIN:VCALENDAR\nEND:VCALENDAR\n", encoding="utf-8")
    linked = tmp_path / "linked.ics"
    linked.symlink_to(outside)
    calendar = LocalCalendar(tmp_path)

    traversal = calendar.snapshot("../outside.ics", "UTC")
    symlink = calendar.snapshot("linked.ics", "UTC")

    assert traversal.status is DailyStatus.ERROR
    assert symlink.status is DailyStatus.ERROR
