from __future__ import annotations

from pytest import CaptureFixture

from restork.cli import main


def test_version_is_available_without_configuration(capsys: CaptureFixture[str]) -> None:
    assert main(["--version"]) == 0
    assert "restork 0.1.0" in capsys.readouterr().out


def test_help_describes_the_three_modes(capsys: CaptureFixture[str]) -> None:
    assert main(["--help"]) == 0
    output = capsys.readouterr().out
    assert "Research, Study, and Work" in output
