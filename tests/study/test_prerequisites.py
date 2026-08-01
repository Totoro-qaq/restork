from __future__ import annotations

from pathlib import Path

from restork.knowledge.search import VaultIndex
from restork.knowledge.vault import Vault
from restork.study.prerequisites import resolve_study_context


def _write(root: Path, path: str, content: str) -> None:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def test_only_resolved_links_in_explicit_prerequisite_sections_are_prerequisites(
    tmp_path: Path,
) -> None:
    _write(tmp_path, "Probability.md", "# Probability Foundations\n")
    _write(tmp_path, "Experiments.md", "# Experiment Design\n")
    _write(
        tmp_path,
        "Bayesian.md",
        """# Bayesian Model Comparison

General relation: [[Experiment Design]].

## Prerequisites

- [[Probability Foundations]]
- [[Missing Note]]

## Applications

[[Experiment Design]] is useful here too.
""",
    )

    context = resolve_study_context(VaultIndex.build(Vault(tmp_path)), "Bayesian.md")

    assert [item.relative_path for item in context.prerequisites] == ["Probability.md"]
    assert context.prerequisites[0].explicit_source == "prerequisite_section"
    assert [item.relative_path for item in context.related_notes] == ["Experiments.md"]

