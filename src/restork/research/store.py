"""Durable, idempotent Research artifact storage."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from restork.artifacts.research import ResearchArtifact
from restork.storage.database import connect, initialize


class SQLiteResearchStore:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def create(cls, path: Path) -> SQLiteResearchStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection)

    def save(self, artifact: ResearchArtifact) -> ResearchArtifact:
        existing = self.for_run(artifact.run_id)
        if existing is not None:
            if existing != artifact:
                raise ValueError("Research run is already bound to another artifact")
            return existing
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            self._connection.execute(
                """
                INSERT INTO research_artifacts
                    (artifact_id, run_id, artifact_json, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    artifact.artifact_id,
                    artifact.run_id,
                    artifact.model_dump_json(),
                    artifact.created_at.isoformat(),
                ),
            )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return artifact

    def get(self, artifact_id: str) -> ResearchArtifact:
        row = self._connection.execute(
            "SELECT artifact_json FROM research_artifacts WHERE artifact_id = ?",
            (artifact_id,),
        ).fetchone()
        if row is None:
            raise KeyError(artifact_id)
        return ResearchArtifact.model_validate_json(row["artifact_json"])

    def for_run(self, run_id: str) -> ResearchArtifact | None:
        row = self._connection.execute(
            "SELECT artifact_json FROM research_artifacts WHERE run_id = ?", (run_id,)
        ).fetchone()
        return None if row is None else ResearchArtifact.model_validate_json(row["artifact_json"])

