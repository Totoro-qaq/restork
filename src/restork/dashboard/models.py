"""Strict local Dashboard data contracts."""

from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from urllib.parse import urlsplit

from pydantic import Field, field_validator

from restork.artifacts.research import ResearchArtifact
from restork.contracts.approval import ApprovalRequest
from restork.contracts.base import ContractModel
from restork.contracts.types import DataClass


class DashboardTask(ContractModel):
    task_id: str = Field(min_length=1)
    relative_path: str = Field(min_length=1)
    line_number: int = Field(ge=1)
    text: str = Field(min_length=1)
    completed: bool
    fields: dict[str, str]
    block_id: str | None = None
    locator_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class TaskBoardSnapshot(ContractModel):
    configured: bool
    tasks: tuple[DashboardTask, ...]


class TaskCompletionRequest(ContractModel):
    completed: bool


class TaskCaptureRequest(ContractModel):
    text: str = Field(min_length=1, max_length=500)
    due: date | None = None
    priority: str | None = None
    project: str | None = Field(default=None, max_length=300)
    source: str | None = Field(default=None, max_length=300)

    @field_validator("text")
    @classmethod
    def require_single_line_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized or "\n" in normalized or "\r" in normalized:
            raise ValueError("task text must be one non-empty line")
        return normalized

    @field_validator("priority")
    @classmethod
    def require_supported_priority(cls, value: str | None) -> str | None:
        if value is not None and value not in {"P0", "P1", "P2", "P3"}:
            raise ValueError("priority must be P0 through P3")
        return value


class TaskMutationPreview(ContractModel):
    task_id: str = Field(min_length=1)
    relative_path: str = Field(min_length=1)
    before_line: str
    after_line: str = Field(min_length=1)
    expected_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    postimage_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    approval: ApprovalRequest


class TaskApplyResult(ContractModel):
    approval_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    relative_path: str = Field(min_length=1)
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    applied: bool = True


class RadarLane(StrEnum):
    MY_STARS = "my_stars"
    TRENDING = "trending"
    HN = "hn"
    PAPERS = "papers"


class RadarState(StrEnum):
    NEW = "new"
    READ_LATER = "read_later"
    DISMISSED = "dismissed"
    RESEARCH_QUEUED = "research_queued"
    TASK_QUEUED = "task_queued"


class RadarAction(StrEnum):
    DISMISS = "dismiss"
    READ_LATER = "read_later"
    RESEARCH = "research"
    MAKE_TASK = "make_task"


class RadarItem(ContractModel):
    item_id: str = Field(min_length=1, max_length=256)
    lane: RadarLane
    title: str = Field(min_length=1, max_length=500)
    source: str = Field(min_length=1, max_length=256)
    url: str = Field(min_length=1, max_length=2_048)
    summary: str = Field(default="", max_length=4_000)
    score: float = Field(default=0, ge=0)
    published_at: datetime | None = None
    state: RadarState = RadarState.NEW
    data_class: DataClass = DataClass.PUBLIC
    created_at: datetime
    updated_at: datetime

    @field_validator("url")
    @classmethod
    def require_public_http_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
        ):
            raise ValueError(
                "radar URL must be an absolute HTTP URL without credentials or fragment"
            )
        return value

    @field_validator("data_class")
    @classmethod
    def reject_never_store_classes(cls, value: DataClass) -> DataClass:
        if value in {DataClass.SECRET, DataClass.CREDENTIAL}:
            raise ValueError("secret and credential data cannot enter Radar")
        return value


class RadarSnapshot(ContractModel):
    configured: bool
    items: tuple[RadarItem, ...]


class RadarActionRequest(ContractModel):
    action: RadarAction

    @field_validator("action", mode="before")
    @classmethod
    def normalize_action(cls, value: object) -> object:
        return RadarAction(value) if isinstance(value, str) else value


class RadarActionResult(ContractModel):
    item: RadarItem
    run_id: str | None = None
    research_artifact: ResearchArtifact | None = None
    task_preview_available: bool = False
    task_approval_id: str | None = None
