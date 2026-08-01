"""Core-owned generic Radar items and idempotent local actions."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from restork.contracts.types import DataClass
from restork.dashboard.models import (
    RadarAction,
    RadarItem,
    RadarLane,
    RadarSnapshot,
    RadarState,
)
from restork.storage.database import connect, initialize
from restork.storage.idempotency import (
    load_idempotent_response,
    mutation_binding,
    save_idempotent_response,
)

_ACTION_STATE = {
    RadarAction.DISMISS: RadarState.DISMISSED,
    RadarAction.READ_LATER: RadarState.READ_LATER,
    RadarAction.RESEARCH: RadarState.RESEARCH_QUEUED,
    RadarAction.MAKE_TASK: RadarState.TASK_QUEUED,
}


class SQLiteRadarStore:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def create(cls, path: Path) -> SQLiteRadarStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection)

    def upsert(self, item: RadarItem) -> RadarItem:
        self._connection.execute(
            """
            INSERT INTO radar_items (
                item_id, lane, title, source, url, summary, score, published_at,
                state, data_class, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(item_id) DO UPDATE SET
                lane = excluded.lane,
                title = excluded.title,
                source = excluded.source,
                url = excluded.url,
                summary = excluded.summary,
                score = excluded.score,
                published_at = excluded.published_at,
                data_class = excluded.data_class,
                updated_at = excluded.updated_at
            """,
            _values(item),
        )
        return self.get(item.item_id)

    def get(self, item_id: str) -> RadarItem:
        row = self._connection.execute(
            "SELECT * FROM radar_items WHERE item_id = ?", (item_id,)
        ).fetchone()
        if row is None:
            raise KeyError(item_id)
        return _from_row(row)

    def snapshot(self, *, include_dismissed: bool = False, limit: int = 100) -> RadarSnapshot:
        if not 1 <= limit <= 500:
            raise ValueError("Radar limit must be between 1 and 500")
        if include_dismissed:
            rows = self._connection.execute(
                """
                SELECT * FROM radar_items
                ORDER BY score DESC, COALESCE(published_at, created_at) DESC, item_id
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        else:
            rows = self._connection.execute(
                """
                SELECT * FROM radar_items
                WHERE state != ?
                ORDER BY score DESC, COALESCE(published_at, created_at) DESC, item_id
                LIMIT ?
                """,
                (RadarState.DISMISSED.value, limit),
            ).fetchall()
        return RadarSnapshot(configured=True, items=tuple(_from_row(row) for row in rows))

    def act(
        self, item_id: str, action: RadarAction, *, idempotency_key: str
    ) -> RadarItem:
        operation = "radar.action"
        binding = mutation_binding(item_id, action.value)
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            replay = load_idempotent_response(
                self._connection,
                operation=operation,
                idempotency_key=idempotency_key,
                binding=binding,
            )
            if replay is not None:
                result = RadarItem.model_validate_json(replay)
            else:
                current = self.get(item_id)
                updated_at = datetime.now(UTC)
                result = current.model_copy(
                    update={"state": _ACTION_STATE[action], "updated_at": updated_at}
                )
                self._connection.execute(
                    "UPDATE radar_items SET state = ?, updated_at = ? WHERE item_id = ?",
                    (result.state.value, result.updated_at.isoformat(), item_id),
                )
                save_idempotent_response(
                    self._connection,
                    operation=operation,
                    idempotency_key=idempotency_key,
                    binding=binding,
                    response_json=result.model_dump_json(),
                )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return result


def empty_radar_snapshot() -> RadarSnapshot:
    return RadarSnapshot(configured=False, items=())


def _values(item: RadarItem) -> tuple[object, ...]:
    return (
        item.item_id,
        item.lane.value,
        item.title,
        item.source,
        item.url,
        item.summary,
        item.score,
        item.published_at.isoformat() if item.published_at is not None else None,
        item.state.value,
        item.data_class.value,
        item.created_at.isoformat(),
        item.updated_at.isoformat(),
    )


def _from_row(row: sqlite3.Row) -> RadarItem:
    return RadarItem(
        item_id=row["item_id"],
        lane=RadarLane(row["lane"]),
        title=row["title"],
        source=row["source"],
        url=row["url"],
        summary=row["summary"],
        score=row["score"],
        published_at=datetime.fromisoformat(row["published_at"])
        if row["published_at"] is not None
        else None,
        state=RadarState(row["state"]),
        data_class=DataClass(row["data_class"]),
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )
