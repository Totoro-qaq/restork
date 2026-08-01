from __future__ import annotations

import json
from email.message import Message
from pathlib import Path
from urllib.request import Request

import pytest
from pytest import CaptureFixture, MonkeyPatch

from restork.cli import LocalApiClient, main


class _Response:
    def __init__(self, payload: bytes, content_type: str = "application/json") -> None:
        self._payload = payload
        self.headers = Message()
        self.headers["Content-Type"] = content_type

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *args: object) -> None:
        del args

    def read(self) -> bytes:
        return self._payload


def test_cli_api_client_allows_only_loopback_and_uses_header_token(
    monkeypatch: MonkeyPatch,
) -> None:
    seen: list[Request] = []

    def fake_urlopen(request: Request, timeout: int) -> _Response:
        assert timeout == 30
        seen.append(request)
        return _Response(b'{"status":"ready"}')

    monkeypatch.setattr("restork.cli.urlopen", fake_urlopen)
    client = LocalApiClient("http://127.0.0.1:7337", "cli-token")
    assert client.request("GET", "/v1/health") == {"status": "ready"}
    assert seen[0].get_header("Authorization") == "Bearer cli-token"
    assert "cli-token" not in seen[0].full_url

    for unsafe in (
        "https://127.0.0.1:7337",
        "http://example.com:7337",
        "http://user@127.0.0.1:7337",
        "http://127.0.0.1:7337/path",
    ):
        with pytest.raises(ValueError, match="loopback"):
            LocalApiClient(unsafe, "token")


def test_cli_commands_use_the_v1_api_contract(
    monkeypatch: MonkeyPatch,
    capsys: CaptureFixture[str],
) -> None:
    calls: list[tuple[str, str, dict[str, object]]] = []

    def fake_request(
        self: LocalApiClient,
        method: str,
        path: str,
        **kwargs: object,
    ) -> object:
        del self
        calls.append((method, path, kwargs))
        if path == "/v1/runs":
            return {"run_id": "run-1"}
        if path.endswith("/events"):
            return "id: 1\nevent: run.created\ndata: {}\n\n"
        return {"ok": True}

    monkeypatch.setenv("RESTORK_CLI_TOKEN", "cli-token")
    monkeypatch.setattr(LocalApiClient, "request", fake_request)
    base = ["--api-url", "http://127.0.0.1:7337"]
    assert main(
        [
            *base,
            "create",
            "--task-id",
            "t",
            "--mode",
            "research",
            "--goal",
            "g",
            "--scope",
            "s",
            "--criterion",
            "c",
            "--idempotency-key",
            "create-1",
        ]
    ) == 0
    assert main(
        [
            *base,
            "study-diagnostic",
            "run-study",
            "--objective",
            "Explain Bayesian evidence",
            "--target-note",
            "Study/Bayesian.md",
        ]
    ) == 0
    capsys.readouterr()
    assert main(
        [
            *base,
            "study-path",
            "run-study",
            "--answer",
            "diagnostic-111111111111111111111111=2",
            "--answer",
            "diagnostic-222222222222222222222222=bounded response",
        ]
    ) == 0
    capsys.readouterr()
    assert main(
        [
            *base,
            "study-practice",
            "run-study",
            "exercise-333333333333333333333333",
            "--answer",
            "private response",
            "--confidence",
            "3",
            "--idempotency-key",
            "study-cli-attempt",
        ]
    ) == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True
    assert main([*base, "stream", "run-1", "--after", "3"]) == 0
    assert "event: run.created" in capsys.readouterr().out
    assert main(
        [
            *base,
            "approve",
            "approval-1",
            "--by",
            "local-user",
            "--idempotency-key",
            "approve-1",
        ]
    ) == 0
    capsys.readouterr()
    assert main(
        [
            *base,
            "resolve-unknown",
            "intent-1",
            "--run-id",
            "run-1",
            "--outcome",
            "failed",
            "--idempotency-key",
            "resolve-1",
        ]
    ) == 0
    capsys.readouterr()
    assert main(
        [
            *base,
            "research",
            "run-1",
            "--question",
            "What does the source report?",
            "--source",
            "https://example.com/source",
            "--target-note",
            "Research/Source.md",
        ]
    ) == 0

    create_call = calls[0]
    assert create_call[:2] == ("POST", "/v1/runs")
    assert create_call[2]["idempotency_key"] == "create-1"
    assert calls[4] == (
        "GET",
        "/v1/runs/run-1/events",
        {"last_event_id": 3},
    )
    assert calls[5][1] == "/v1/approvals/approval-1"
    assert calls[5][2]["body"] == {
        "decision": "approve",
        "decided_by": "local-user",
    }
    assert calls[6][1] == "/v1/runs/run-1/effects/intent-1/resolve"
    assert calls[7][1] == "/v1/research/runs/run-1/execute"
    assert calls[7][2]["body"] == {
        "schema_version": 1,
        "question": "What does the source report?",
        "sources": [
            {
                "schema_version": 1,
                "url": "https://example.com/source",
                "kind": None,
            }
        ],
        "target_note": "Research/Source.md",
    }
    assert calls[1][1] == "/v1/study/runs/run-study/diagnostic"
    assert calls[1][2]["body"] == {
        "schema_version": 1,
        "objective": "Explain Bayesian evidence",
        "target_note": "Study/Bayesian.md",
    }
    assert calls[2][1] == "/v1/study/runs/run-study/path"
    assert calls[2][2]["body"] == {
        "schema_version": 1,
        "answers": {
            "diagnostic-111111111111111111111111": "2",
            "diagnostic-222222222222222222222222": "bounded response",
        },
    }
    assert calls[3][1].endswith(
        "/exercises/exercise-333333333333333333333333/attempt"
    )
    assert calls[3][2]["idempotency_key"] == "study-cli-attempt"
    assert json.loads(capsys.readouterr().out)["ok"] is True


def test_cli_requires_pairing_before_authenticated_commands(
    monkeypatch: MonkeyPatch,
    capsys: CaptureFixture[str],
) -> None:
    monkeypatch.delenv("RESTORK_CLI_TOKEN", raising=False)
    assert main(["health"]) == 2
    assert "restork pair" in capsys.readouterr().err


def test_serve_displays_separate_pairing_codes_without_touching_design_assets(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
    capsys: CaptureFixture[str],
) -> None:
    class _Server:
        def run(self) -> None:
            return None

    monkeypatch.setattr("restork.cli.make_server", lambda app, port: _Server())
    assert main(["--state-db", str(tmp_path / "state.db"), "serve"]) == 0
    output = capsys.readouterr().out
    assert "Web pairing code:" in output
    assert "CLI pairing code:" in output
