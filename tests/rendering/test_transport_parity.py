from __future__ import annotations

from email.message import Message
from pathlib import Path
from typing import Self

import pytest

from restork.cli import LocalApiClient


class _LocalResponse:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self.headers = Message()
        self.headers["Content-Type"] = "text/event-stream"

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *args: object) -> None:
        del args

    def read(self) -> bytes:
        return self._payload


def test_transport_rendering_parity_cli_preserves_core_sse_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = (
        Path(__file__).parents[2]
        / "dashboard"
        / "tests"
        / "fixtures"
        / "transport-event.sse"
    ).read_bytes()
    captured_urls: list[str] = []

    def open_local(request: object, timeout: int) -> _LocalResponse:
        del timeout
        captured_urls.append(request.full_url)  # type: ignore[attr-defined]
        return _LocalResponse(fixture)

    monkeypatch.setattr("restork.cli.urlopen", open_local)
    response = LocalApiClient("http://127.0.0.1:7337", "synthetic-token").request(
        "GET",
        "/v1/runs/run/events",
        last_event_id=0,
    )

    assert response == fixture.decode()
    assert captured_urls == ["http://127.0.0.1:7337/v1/runs/run/events"]
