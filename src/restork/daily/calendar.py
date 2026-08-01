"""Bounded read-only local ICS parsing without account synchronization."""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from hashlib import sha256
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from restork.daily.files import resolve_private_file
from restork.daily.models import CalendarEvent, CalendarSnapshot, DailyStatus


class LocalCalendar:
    def __init__(self, profile_root: Path) -> None:
        self._profile_root = profile_root

    def snapshot(
        self,
        path_value: str,
        timezone_name: str,
        *,
        now: datetime | None = None,
        window_days: int = 14,
        limit: int = 12,
    ) -> CalendarSnapshot:
        if not path_value:
            return CalendarSnapshot(
                configured=False,
                status=DailyStatus.NOT_CONFIGURED,
                message="Select a local read-only ICS file.",
            )
        try:
            timezone = ZoneInfo(timezone_name or "UTC")
            path = resolve_private_file(
                path_value,
                base=self._profile_root,
                suffixes=frozenset({".ics"}),
            )
            current = (now or datetime.now(UTC)).astimezone(timezone)
            events = _parse_calendar(path, timezone)
            upper = current + timedelta(days=window_days)
            selected = tuple(
                sorted(
                    (
                        event
                        for event in events
                        if event.ends_at >= current and event.starts_at <= upper
                    ),
                    key=lambda event: (event.starts_at, event.event_id),
                )[:limit]
            )
            return CalendarSnapshot(
                configured=True,
                status=DailyStatus.READY,
                events=selected,
                message="No upcoming events." if not selected else "",
            )
        except (OSError, UnicodeError, ValueError, ZoneInfoNotFoundError):
            return CalendarSnapshot(
                configured=True,
                status=DailyStatus.ERROR,
                message="The local calendar could not be read safely.",
            )


def _parse_calendar(path: Path, default_timezone: ZoneInfo) -> tuple[CalendarEvent, ...]:
    lines = _unfold(path.read_text(encoding="utf-8").splitlines())
    raw_events: list[list[str]] = []
    current: list[str] | None = None
    for line in lines:
        if line == "BEGIN:VEVENT":
            if current is not None:
                raise ValueError("nested VEVENT is invalid")
            current = []
        elif line == "END:VEVENT":
            if current is None:
                raise ValueError("unexpected VEVENT terminator")
            raw_events.append(current)
            current = None
        elif current is not None:
            current.append(line)
    if current is not None:
        raise ValueError("unterminated VEVENT")
    return tuple(_event(lineset, default_timezone) for lineset in raw_events)


def _event(lines: list[str], default_timezone: ZoneInfo) -> CalendarEvent:
    properties: dict[str, tuple[dict[str, str], str]] = {}
    for line in lines:
        if ":" not in line:
            continue
        raw_name, value = line.split(":", maxsplit=1)
        parts = raw_name.split(";")
        name = parts[0].upper()
        params = {
            key.upper(): parameter
            for part in parts[1:]
            if "=" in part
            for key, parameter in [part.split("=", maxsplit=1)]
        }
        properties[name] = (params, value)
    if "DTSTART" not in properties:
        raise ValueError("calendar event has no start")
    start, all_day = _ical_datetime(*properties["DTSTART"], default_timezone)
    if "DTEND" in properties:
        end, _ = _ical_datetime(*properties["DTEND"], default_timezone)
    else:
        end = start + (timedelta(days=1) if all_day else timedelta(hours=1))
    if end < start:
        raise ValueError("calendar event ends before it starts")
    classification = properties.get("CLASS", ({}, "PUBLIC"))[1].upper()
    redacted = classification in {"PRIVATE", "CONFIDENTIAL"}
    title = "Busy" if redacted else _ical_text(properties.get("SUMMARY", ({}, "Untitled"))[1])
    identity = properties.get("UID", ({}, ""))[1]
    event_id = sha256(f"{identity}\0{start.isoformat()}".encode()).hexdigest()[:24]
    return CalendarEvent(
        event_id=event_id,
        title=title[:300] or "Untitled",
        starts_at=start,
        ends_at=end,
        all_day=all_day,
        redacted=redacted,
    )


def _ical_datetime(
    params: dict[str, str], value: str, default_timezone: ZoneInfo
) -> tuple[datetime, bool]:
    if params.get("VALUE") == "DATE" or (len(value) == 8 and value.isdigit()):
        parsed_date = date.fromisoformat(f"{value[:4]}-{value[4:6]}-{value[6:8]}")
        return datetime.combine(parsed_date, time.min, default_timezone), True
    if value.endswith("Z"):
        return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC), False
    timezone = (
        ZoneInfo(params["TZID"].strip('"')) if "TZID" in params else default_timezone
    )
    pattern = "%Y%m%dT%H%M%S" if len(value) == 15 else "%Y%m%dT%H%M"
    return datetime.strptime(value, pattern).replace(tzinfo=timezone), False


def _unfold(lines: list[str]) -> list[str]:
    unfolded: list[str] = []
    for line in lines:
        if line.startswith((" ", "\t")):
            if not unfolded:
                raise ValueError("calendar continuation has no property")
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line.rstrip("\r"))
    return unfolded


def _ical_text(value: str) -> str:
    return (
        value.replace("\\n", " ")
        .replace("\\N", " ")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
        .strip()
    )
