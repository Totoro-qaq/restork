from __future__ import annotations

import json
import os
from pathlib import Path

from pytest import CaptureFixture, MonkeyPatch

from restork import __version__
from restork.cli import main
from restork.providers.diagnostics import ProviderDiagnosticReport
from restork.providers.setup import ProviderSetupResult


def test_version_is_available_without_configuration(capsys: CaptureFixture[str]) -> None:
    assert main(["--version"]) == 0
    assert f"restork {__version__}" in capsys.readouterr().out


def test_help_describes_the_three_modes(capsys: CaptureFixture[str]) -> None:
    assert main(["--help"]) == 0
    output = capsys.readouterr().out
    assert "Research, Study, and Work" in output


class _InteractiveInput:
    def isatty(self) -> bool:
        return True


def test_provider_configure_is_an_interactive_keychain_entry_without_core(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
    capsys: CaptureFixture[str],
) -> None:
    calls: list[Path] = []

    def fake_configure(config_path: Path, keychain: object) -> ProviderSetupResult:
        del keychain
        calls.append(config_path)
        return ProviderSetupResult(config_path=config_path, config_created=True)

    monkeypatch.setattr("restork.cli.sys.platform", "darwin")
    monkeypatch.setattr("restork.cli.sys.stdin", _InteractiveInput())
    monkeypatch.setattr("restork.cli.configure_provider", fake_configure)
    monkeypatch.setenv("RESTORK_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.delenv("RESTORK_CLI_TOKEN", raising=False)

    assert main(["provider", "configure"]) == 0

    assert calls == [tmp_path / "config" / "config.toml"]
    output = capsys.readouterr().out
    assert "macOS Keychain" in output
    assert "doctor --connect" in output
    assert "API key:" not in output


def test_doctor_is_local_by_default_and_network_is_explicit(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
    capsys: CaptureFixture[str],
) -> None:
    diagnostic_values: list[tuple[bool, str]] = []

    class FakeDiagnostics:
        def __init__(self, config_path: Path) -> None:
            assert config_path == tmp_path / "config" / "config.toml"

        def status(self) -> ProviderDiagnosticReport:
            return _diagnostic_report("ready", connection_checked=False)

        async def diagnose(
            self,
            *,
            smoke: bool = False,
            target: str = "primary",
        ) -> ProviderDiagnosticReport:
            diagnostic_values.append((smoke, target))
            return _diagnostic_report(
                "smoke_passed" if smoke else "connected",
                connection_checked=True,
            )

    monkeypatch.setattr("restork.cli.DeepSeekProviderDiagnostics", FakeDiagnostics)
    monkeypatch.setenv("RESTORK_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.delenv("RESTORK_CLI_TOKEN", raising=False)

    assert main(["doctor"]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "ready"
    assert diagnostic_values == []
    assert main(["doctor", "--connect"]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "connected"
    assert main(["doctor", "--smoke"]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "smoke_passed"
    assert main(["doctor", "--web-search"]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "smoke_passed"
    assert diagnostic_values == [
        (False, "primary"),
        (True, "primary"),
        (True, "web_search"),
    ]


def test_desktop_serve_writes_bootstrap_pipe_without_printing_pairing_codes(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
    capsys: CaptureFixture[str],
) -> None:
    bootstrap_reader, bootstrap_writer = os.pipe()
    ran: list[bool] = []

    class FakeServer:
        def run(self) -> None:
            ran.append(True)

    monkeypatch.setattr("restork.cli.make_server", lambda app, port: FakeServer())
    monkeypatch.setenv("RESTORK_DESKTOP_BOOTSTRAP_FD", str(bootstrap_writer))
    monkeypatch.setenv("RESTORK_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("RESTORK_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("RESTORK_CACHE_DIR", str(tmp_path / "cache"))

    assert main(
        [
            "--state-db",
            str(tmp_path / "data" / "state.db"),
            "serve",
            "--port",
            "49153",
        ]
    ) == 0

    try:
        payload = json.loads(os.read(bootstrap_reader, 4096))
    finally:
        os.close(bootstrap_reader)
    assert payload["port"] == 49153
    assert len(payload["pairing_code"]) >= 16
    assert ran == [True]
    assert capsys.readouterr().out == ""


def _diagnostic_report(
    status: str,
    *,
    connection_checked: bool,
) -> ProviderDiagnosticReport:
    return ProviderDiagnosticReport.model_validate(
        {
            "status": status,
            "message": "Synthetic diagnostic status.",
            "config_present": True,
            "config_valid": True,
            "credential_present": True,
            "connection_checked": connection_checked,
        }
    )
