"""Mode profiles are policy, not prompt instructions."""

from __future__ import annotations

from dataclasses import dataclass

from restork.contracts.types import Mode


@dataclass(frozen=True)
class ModeProfile:
    mode: Mode
    allowed_tools: frozenset[str]
    permits_vault_write: bool


_PROFILES = {
    Mode.RESEARCH: ModeProfile(Mode.RESEARCH, frozenset({"vault_search", "source_read"}), False),
    Mode.STUDY: ModeProfile(Mode.STUDY, frozenset({"vault_search", "practice"}), False),
    Mode.WORK: ModeProfile(Mode.WORK, frozenset({"vault_search", "handoff_export"}), False),
}


def profile_for(mode: Mode) -> ModeProfile:
    return _PROFILES[mode]
