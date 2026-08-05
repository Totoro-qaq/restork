"""Authenticated local FastAPI app with replayable run-event SSE."""

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from hashlib import sha256
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.middleware.base import RequestResponseEndpoint

from restork.api.auth import (
    APPROVALS_DECIDE,
    APPROVALS_READ,
    CLI_AUDIENCE,
    DAILY_READ,
    EFFECTS_RESOLVE,
    MEMORY_READ,
    MEMORY_WRITE,
    RADAR_READ,
    RADAR_WRITE,
    RUNS_READ,
    RUNS_WRITE,
    TASKS_READ,
    TASKS_WRITE,
    TOKENS_MANAGE,
    WEB_AUDIENCE,
    AccessToken,
    InvalidAccessToken,
    PairingAuthority,
)
from restork.api.pagination import page_metadata, page_window
from restork.config.models import KeychainReference
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import ApprovalDecision, EffectPhase, Mode, RunPhase
from restork.conversation.models import ConversationInput
from restork.conversation.service import ConversationService
from restork.daily.apple_music import AppleMusicError
from restork.daily.music_research import MusicResearchError
from restork.daily.netease import NetEaseMusicError
from restork.daily.qqmusic import QQMusicError
from restork.daily.service import DailyContextService
from restork.daily.sources import music_source_registry
from restork.dashboard.models import (
    RadarAction,
    RadarActionRequest,
    RadarActionResult,
    TaskCaptureRequest,
    TaskCompletionRequest,
)
from restork.dashboard.radar import SQLiteRadarStore, empty_radar_snapshot
from restork.dashboard.tasks import MarkdownTaskBoard, MarkdownTaskMutator
from restork.memory.models import (
    ContextSelectionRequest,
    MemoryCorrection,
    MemoryDeleteRequest,
    MemoryExportRequest,
    MemoryLayer,
    SourcePurgeRequest,
)
from restork.memory.service import MemoryService
from restork.prompts.registry import prompt_manifest
from restork.providers.diagnostics import (
    ProviderDiagnosticRequest,
    ProviderDiagnostics,
)
from restork.research.models import SourceRequest
from restork.research.store import SQLiteResearchStore
from restork.research.workflow import ResearchRunRequest, ResearchWorkflow
from restork.runtime.budget import BudgetExceeded
from restork.runtime.runner import Harness
from restork.secrets import KeychainSecretStore
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore
from restork.study.models import DiagnosticSubmission, PracticeSubmission, StudyStartRequest
from restork.study.store import SQLiteStudyStore
from restork.study.workflow import StudyWorkflow
from restork.tools.registry import DEFAULT_TOOL_DEFINITIONS
from restork.work.models import WorkResultManifest, WorkStartRequest
from restork.work.workflow import WorkWorkflow


class PairPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=1, max_length=256)


class ApprovalDecisionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decided_by: str = Field(min_length=1, max_length=128)


class ApprovalMutationPayload(ApprovalDecisionPayload):
    decision: Literal["approve", "reject"]


class EffectResolutionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcome: Literal["committed", "failed"]


class WorkExportPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    approval_id: str = Field(min_length=1, max_length=256)


class WeatherConfigurationPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    enabled: bool
    mode: Literal["query", "coordinates"] | None = None
    query: str = Field(default="", max_length=120)
    language: Literal["en", "zh"] = "en"
    label: str = Field(default="", max_length=120)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)


class CalendarConfigurationPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    filename: str = Field(default="", max_length=255)
    content: str = Field(default="", max_length=2_000_000)
    timezone: str = Field(default="", max_length=128)


class MusicConfigurationPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    source: Literal["file", "qqmusic", "netease", "apple-music"] = "file"
    filename: str = Field(default="", max_length=255)
    content: str = Field(default="", max_length=2_000_000)
    share_url: str = Field(default="", max_length=2_048)
    local_date: str = Field(default="", max_length=10)


class MusicRefreshPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    local_date: str = Field(default="", max_length=10)


_SSE_TERMINAL_STATES = {RunPhase.COMPLETED, RunPhase.FAILED, RunPhase.CANCELLED}
_SSE_POLL_SECONDS = 0.25
_SSE_HEARTBEAT_SECONDS = 15.0


def _sse_frame(sequence: int, kind: str, data: dict[str, object]) -> str:
    return f"id: {sequence}\nevent: {kind}\ndata: {json.dumps(data)}\n\n"


def _safe_validation_detail(
    error: ValidationError | RequestValidationError,
) -> list[dict[str, object]]:
    """Return actionable validation metadata without echoing submitted values."""
    safe_keys = {"type", "loc", "msg"}
    items = (
        error.errors()
        if isinstance(error, RequestValidationError)
        else error.errors(include_context=False)
    )
    return [
        {key: value for key, value in item.items() if key in safe_keys}
        for item in items
    ]


def _is_loopback_browser_origin(origin: str) -> bool:
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme == "http"
        and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        and parsed.username is None
        and parsed.password is None
        and port is not None
        and not parsed.path
        and not parsed.query
        and not parsed.fragment
    )


def create_app(
    events: SQLiteEventStore,
    pairing: PairingAuthority,
    runs: SQLiteRunStore,
    approvals: SQLiteApprovalStore,
    intents: SQLiteIntentStore,
    memory: MemoryService | None = None,
    tasks: MarkdownTaskBoard | None = None,
    task_mutations: MarkdownTaskMutator | None = None,
    radar: SQLiteRadarStore | None = None,
    budgets: SQLiteBudgetStore | None = None,
    web_root: Path | None = None,
    daily: DailyContextService | None = None,
    research: ResearchWorkflow | None = None,
    research_artifacts: SQLiteResearchStore | None = None,
    study: StudyWorkflow | None = None,
    study_artifacts: SQLiteStudyStore | None = None,
    work: WorkWorkflow | None = None,
    provider_diagnostics: ProviderDiagnostics | None = None,
    conversation: ConversationService | None = None,
) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(RequestValidationError)
    async def safe_request_validation_error(
        _: Request, error: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"detail": _safe_validation_detail(error)},
        )

    def require_token(scope: str) -> Callable[..., AccessToken]:
        def dependency(request: Request, authorization: str = Header(default="")) -> AccessToken:
            scheme, _, token_value = authorization.partition(" ")
            if scheme != "Bearer" or not token_value:
                raise HTTPException(status_code=401, detail="Bearer authorization is required")
            try:
                token = pairing.verify(
                    token_value,
                    {WEB_AUDIENCE, CLI_AUDIENCE},
                    {scope},
                )
            except InvalidAccessToken as error:
                raise HTTPException(status_code=401, detail=str(error)) from error
            except PermissionError as error:
                raise HTTPException(status_code=403, detail=str(error)) from error
            if request.headers.get("origin") and token.audience != WEB_AUDIENCE:
                raise HTTPException(
                    status_code=403,
                    detail="browser requests require a Web audience token",
                )
            return token

        return dependency

    manage_token = require_token(TOKENS_MANAGE)
    read_runs = require_token(RUNS_READ)
    write_runs = require_token(RUNS_WRITE)
    read_approvals = require_token(APPROVALS_READ)
    decide_approvals = require_token(APPROVALS_DECIDE)
    resolve_effects = require_token(EFFECTS_RESOLVE)
    read_memory = require_token(MEMORY_READ)
    write_memory = require_token(MEMORY_WRITE)
    read_tasks = require_token(TASKS_READ)
    write_tasks = require_token(TASKS_WRITE)
    read_radar = require_token(RADAR_READ)
    write_radar = require_token(RADAR_WRITE)
    read_daily = require_token(DAILY_READ)

    def require_json(content_type: str = Header(default="")) -> None:
        if content_type.split(";", maxsplit=1)[0].strip().lower() != "application/json":
            raise HTTPException(status_code=415, detail="Content-Type must be application/json")

    @app.middleware("http")
    async def local_origin_only(request: Request, call_next: RequestResponseEndpoint) -> Response:
        forbidden_query_keys = {"access_token", "authorization", "token"}
        if forbidden_query_keys.intersection(request.query_params):
            return JSONResponse(
                status_code=400,
                content={"detail": "credentials are forbidden in query parameters"},
            )
        origin = request.headers.get("origin")
        if origin and not _is_loopback_browser_origin(origin):
            return JSONResponse(status_code=403, content={"detail": "cross-origin request denied"})
        if origin and request.url.path.startswith("/v1/cli/"):
            return JSONResponse(
                status_code=403,
                content={"detail": "CLI pairing rejects browser origins"},
            )
        if request.method == "OPTIONS" and origin:
            requested_method = request.headers.get("access-control-request-method", "")
            allowed_methods = {"GET", "POST"}
            if request.url.path.startswith("/v1/memory/"):
                allowed_methods.update({"PATCH", "DELETE"})
            if requested_method not in allowed_methods:
                return JSONResponse(
                    status_code=405,
                    content={"detail": "CORS method is not allowed"},
                )
            allowed_headers = {
                "authorization",
                "content-type",
                "idempotency-key",
                "last-event-id",
            }
            requested_headers = {
                header.strip().lower()
                for header in request.headers.get("access-control-request-headers", "").split(",")
                if header.strip()
            }
            if not requested_headers <= allowed_headers:
                return JSONResponse(
                    status_code=400,
                    content={"detail": "CORS header is not allowed"},
                )
            return Response(
                status_code=204,
                headers={
                    "Access-Control-Allow-Origin": origin,
                    "Access-Control-Allow-Headers": (
                        "Authorization, Content-Type, Idempotency-Key, Last-Event-ID"
                    ),
                    "Access-Control-Allow-Methods": ", ".join(
                        (*sorted(allowed_methods), "OPTIONS")
                    ),
                    "Vary": "Origin",
                },
            )
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; style-src 'self'; script-src 'self'; "
            "connect-src 'self'; img-src 'self' data:; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        return response

    @app.post("/v1/pair")
    def pair(body: PairPayload, _: None = Depends(require_json)) -> dict[str, str]:
        try:
            token = pairing.pair(body.code, WEB_AUDIENCE)
        except PermissionError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        return _token_payload(token)

    @app.post("/v1/cli/pair")
    def pair_cli(body: PairPayload, _: None = Depends(require_json)) -> dict[str, str]:
        try:
            token = pairing.pair(body.code, CLI_AUDIENCE)
        except PermissionError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        return _token_payload(token)

    @app.post("/v1/token/rotate")
    def rotate_token(
        token: Annotated[AccessToken, Depends(manage_token)],
    ) -> dict[str, str]:
        replacement = pairing.rotate(token.value, token.audience)
        return _token_payload(replacement)

    @app.post("/v1/token/revoke")
    def revoke_token(
        token: Annotated[AccessToken, Depends(manage_token)],
    ) -> Response:
        pairing.revoke(token.value)
        return Response(status_code=204)

    @app.get("/v1/readiness")
    def readiness() -> dict[str, str]:
        """Return metadata-only process readiness for a local desktop supervisor."""
        return {"status": "ready", "schema": "v1"}

    @app.get("/v1/health")
    def health(_: Annotated[AccessToken, Depends(read_runs)]) -> dict[str, str]:
        return {"status": "ready", "schema": "v1"}

    @app.get("/v1/capabilities")
    def capabilities(
        _: Annotated[AccessToken, Depends(read_runs)],
    ) -> dict[str, object]:
        return {
            "modes": [mode.value for mode in Mode],
            "providers": ["deepseek-v4-pro"],
            "tools": sorted(DEFAULT_TOOL_DEFINITIONS),
            "memory": {
                "layers": [layer.value for layer in MemoryLayer],
                "valkey_required": False,
                "memory_mcp_required": False,
            },
            "conversation": {
                "run_scoped": True,
                "tools": False,
                "transport": "request_with_event_sse",
            },
            "prompts": prompt_manifest(),
        }

    def configured_provider_diagnostics() -> ProviderDiagnostics:
        if provider_diagnostics is None:
            raise HTTPException(
                status_code=503,
                detail="provider diagnostics are not configured",
            )
        return provider_diagnostics

    @app.get("/v1/providers/deepseek")
    def inspect_provider(
        _: Annotated[AccessToken, Depends(read_runs)],
    ) -> dict[str, object]:
        return configured_provider_diagnostics().status().model_dump(mode="json")

    @app.post("/v1/providers/deepseek/diagnostics")
    async def diagnose_provider(
        body: ProviderDiagnosticRequest,
        _: Annotated[AccessToken, Depends(write_runs)],
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        report = await configured_provider_diagnostics().diagnose(
            smoke=body.smoke,
            target=body.target,
        )
        return report.model_dump(mode="json")

    def configured_memory() -> MemoryService:
        if memory is None:
            raise HTTPException(status_code=503, detail="memory service is not configured")
        return memory

    @app.get("/v1/memory")
    def inspect_memory(
        _: Annotated[AccessToken, Depends(read_memory)],
        layer: MemoryLayer | None = None,
        cursor: str | None = None,
        limit: int = 20,
    ) -> dict[str, object]:
        try:
            window = page_window(scope=f"memory:{layer or 'all'}", cursor=cursor, limit=limit)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        payload = configured_memory().inspect(layer).model_dump(mode="json")
        records = payload.get("records")
        if isinstance(records, list):
            page_records = records[window.offset : window.offset + window.limit + 1]
            has_more = len(page_records) > window.limit
            records = page_records[: window.limit]
            payload["records"] = records
            payload["page"] = page_metadata(
                scope=f"memory:{layer or 'all'}",
                window=window,
                returned=len(records),
                has_more=has_more,
            )
            for record in records:
                if not isinstance(record, dict):
                    continue
                memory_id = record.get("memory_id")
                if (
                    isinstance(memory_id, str)
                    and memory_id.startswith("profile:")
                    and memory_id
                    not in {"profile:locale.language", "profile:locale.timezone"}
                ):
                    record["summary"] = "[configured]" if record.get("summary") else ""
        return payload

    @app.post("/v1/memory/context")
    def build_memory_context(
        body: ContextSelectionRequest,
        _: Annotated[AccessToken, Depends(read_memory)],
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        try:
            selection = configured_memory().build_context(body)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="memory record not found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return selection.model_dump(mode="json")

    @app.patch("/v1/memory/{memory_id}")
    def correct_memory(
        memory_id: str,
        body: MemoryCorrection,
        _: Annotated[AccessToken, Depends(write_memory)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        try:
            record = configured_memory().correct(
                memory_id,
                body.value,
                expected_content_hash=body.expected_content_hash,
                data_class=body.data_class,
                idempotency_key=idempotency_key,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail="memory record not found") from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return record.model_dump(mode="json")

    @app.delete("/v1/memory/{memory_id}")
    def delete_memory(
        memory_id: str,
        body: MemoryDeleteRequest,
        _: Annotated[AccessToken, Depends(write_memory)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, bool]:
        try:
            deleted = configured_memory().delete(
                memory_id,
                expected_content_hash=body.expected_content_hash,
                idempotency_key=idempotency_key,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail="memory record not found") from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return {"deleted": deleted}

    @app.post("/v1/memory/export")
    def export_memory(
        body: MemoryExportRequest,
        _: Annotated[AccessToken, Depends(write_memory)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        try:
            result = configured_memory().export(
                body.layers, idempotency_key=idempotency_key
            )
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return result.model_dump(mode="json")

    @app.post("/v1/memory/purge-source")
    def purge_memory_source(
        body: SourcePurgeRequest,
        _: Annotated[AccessToken, Depends(write_memory)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        try:
            result = configured_memory().purge_source(
                body.source_id, idempotency_key=idempotency_key
            )
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return result.model_dump(mode="json")

    @app.get("/v1/runs")
    def list_runs(
        _: Annotated[AccessToken, Depends(read_runs)],
        cursor: str | None = None,
        limit: int = 20,
    ) -> dict[str, object]:
        try:
            window = page_window(scope="runs", cursor=cursor, limit=limit)
            summaries = runs.list_runs(limit=window.limit + 1, offset=window.offset)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        has_more = len(summaries) > window.limit
        summaries = summaries[: window.limit]
        items: list[dict[str, object]] = []
        for summary in summaries:
            task: TaskSpec | None
            try:
                task = runs.get_task(summary.run_id)
            except ValueError:
                task = None
            budget_status: dict[str, object] | None = None
            if budgets is not None:
                try:
                    snapshot = budgets.snapshot(summary.run_id)
                except KeyError:
                    pass
                else:
                    budget_status = {
                        "budget": snapshot.budget.model_dump(mode="json"),
                        "usage": {
                            "steps": snapshot.usage.steps,
                            "retries": snapshot.usage.retries,
                            "tokens": snapshot.usage.tokens,
                            "cost_usd": snapshot.usage.cost_usd,
                            "child_tasks": snapshot.usage.child_tasks,
                        },
                        "wall_time_exceeded": snapshot.wall_time_exceeded,
                    }
            items.append(
                {
                    "summary": summary.model_dump(mode="json"),
                    "task": task.model_dump(mode="json") if task is not None else None,
                    "budget": budget_status,
                }
            )
        return {
            "runs": items,
            "page": page_metadata(
                scope="runs",
                window=window,
                returned=len(items),
                has_more=has_more,
            ),
        }

    @app.get("/v1/approvals")
    def list_approvals(
        _: Annotated[AccessToken, Depends(read_approvals)],
        pending_only: bool = False,
        cursor: str | None = None,
        limit: int = 20,
    ) -> dict[str, object]:
        try:
            scope = f"approvals:{str(pending_only).lower()}"
            window = page_window(scope=scope, cursor=cursor, limit=limit)
            requests = approvals.list_requests(
                pending_only=pending_only,
                limit=window.limit + 1,
                offset=window.offset,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        has_more = len(requests) > window.limit
        requests = requests[: window.limit]
        return {
            "approvals": [request.model_dump(mode="json") for request in requests],
            "page": page_metadata(
                scope=scope,
                window=window,
                returned=len(requests),
                has_more=has_more,
            ),
        }

    @app.get("/v1/tasks")
    def list_tasks(
        _: Annotated[AccessToken, Depends(read_tasks)],
        include_completed: bool = True,
        cursor: str | None = None,
        limit: int = 20,
    ) -> dict[str, object]:
        board = tasks or MarkdownTaskBoard()
        try:
            scope = f"tasks:{str(include_completed).lower()}"
            window = page_window(scope=scope, cursor=cursor, limit=limit)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        payload = board.snapshot(include_completed=include_completed).model_dump(mode="json")
        task_items = payload.get("tasks", [])
        if not isinstance(task_items, list):
            task_items = []
        page_items = task_items[window.offset : window.offset + window.limit + 1]
        has_more = len(page_items) > window.limit
        page_items = page_items[: window.limit]
        payload["tasks"] = page_items
        payload["page"] = page_metadata(
            scope=scope,
            window=window,
            returned=len(page_items),
            has_more=has_more,
        )
        return payload

    @app.post("/v1/tasks/quick-capture/preview")
    def preview_task_capture(
        body: TaskCaptureRequest,
        _: Annotated[AccessToken, Depends(write_tasks)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if task_mutations is None:
            raise HTTPException(status_code=503, detail="Task mutations are not configured")
        try:
            preview = task_mutations.preview_capture(
                body,
                idempotency_key=idempotency_key,
            )
        except (KeyError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return preview.model_dump(mode="json")

    @app.post("/v1/tasks/{task_id}/preview")
    def preview_task_completion(
        task_id: str,
        body: TaskCompletionRequest,
        _: Annotated[AccessToken, Depends(write_tasks)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if task_mutations is None:
            raise HTTPException(status_code=503, detail="Task mutations are not configured")
        try:
            preview = task_mutations.preview_completion(
                task_id,
                body.completed,
                idempotency_key=idempotency_key,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Task not found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return preview.model_dump(mode="json")

    @app.post("/v1/tasks/approvals/{approval_id}/apply")
    def apply_task_mutation(
        approval_id: str,
        _: Annotated[AccessToken, Depends(write_tasks)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if task_mutations is None:
            raise HTTPException(status_code=503, detail="Task mutations are not configured")
        try:
            result = task_mutations.apply(
                approval_id,
                idempotency_key=idempotency_key,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Task preview not found") from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return result.model_dump(mode="json")

    @app.get("/v1/radar")
    def read_radar_items(
        _: Annotated[AccessToken, Depends(read_radar)],
        include_dismissed: bool = False,
        cursor: str | None = None,
        limit: int = 20,
    ) -> dict[str, object]:
        try:
            scope = f"radar:{str(include_dismissed).lower()}"
            window = page_window(scope=scope, cursor=cursor, limit=limit)
            snapshot = (
                radar.snapshot(
                    include_dismissed=include_dismissed,
                    limit=window.limit + 1,
                    offset=window.offset,
                )
                if radar is not None
                else empty_radar_snapshot()
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        items = list(snapshot.items)
        has_more = len(items) > window.limit
        items = items[: window.limit]
        payload = snapshot.model_dump(mode="json")
        payload["items"] = [item.model_dump(mode="json") for item in items]
        payload["page"] = page_metadata(
            scope=scope,
            window=window,
            returned=len(items),
            has_more=has_more,
        )
        return payload

    @app.post("/v1/radar/{item_id}/action")
    async def mutate_radar_item(
        item_id: str,
        body: RadarActionRequest,
        _: Annotated[AccessToken, Depends(write_radar)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if radar is None:
            raise HTTPException(status_code=503, detail="Radar is not configured")
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            item = radar.get(item_id)
            run_id = None
            research_artifact = None
            task_approval_id = None
            if body.action is RadarAction.RESEARCH:
                research_request = ResearchRunRequest(
                    question=f"Investigate: {item.title}",
                    sources=(SourceRequest(url=item.url),),
                )
                task_id = f"radar-{sha256(item.item_id.encode()).hexdigest()[:24]}"
                research_task = TaskSpec(
                    task_id=task_id,
                    mode=Mode.RESEARCH,
                    goal=f"Research Radar item: {item.title} ({item.url})",
                    workspace_scope=f"radar:{item.item_id}",
                    completion_criteria=[
                        "claims reference evidence",
                        "unresolved questions are explicit",
                    ],
                    data_policy=DataPolicy(
                        maximum_outbound_class=item.data_class,
                    ),
                    tool_policy=ToolPolicy(
                        allowed_tools=["vault_search", "source_read"]
                    ),
                    budgets=BudgetSpec(
                        max_steps=12,
                        max_wall_time_seconds=3600,
                        max_tokens=120_000,
                        max_retries=2,
                    ),
                    created_at=item.created_at,
                )
                run = Harness(runs, events, budgets).start(
                    research_task,
                    idempotency_key=f"radar-research:{idempotency_key}",
                )
                run_id = run.run_id
                if research is not None:
                    research_artifact = await research.execute(run.run_id, research_request)
            elif body.action is RadarAction.MAKE_TASK and task_mutations is not None:
                preview = task_mutations.preview_capture(
                    TaskCaptureRequest(
                        text=f"Review: {item.title}",
                        priority="P2",
                        source=f"restork:radar/{item.item_id}",
                    ),
                    idempotency_key=f"radar-task:{idempotency_key}",
                )
                task_approval_id = preview.approval.approval_id
            updated = radar.act(item_id, body.action, idempotency_key=idempotency_key)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Radar item not found") from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=502, detail="Research execution failed") from error
        result = RadarActionResult(
            item=updated,
            run_id=run_id,
            research_artifact=research_artifact,
            task_preview_available=(
                body.action is RadarAction.MAKE_TASK
                and task_approval_id is not None
            ),
            task_approval_id=task_approval_id,
        )
        return result.model_dump(mode="json")

    @app.post("/v1/research/runs/{run_id}/execute")
    async def execute_research_run(
        run_id: str,
        request: Request,
        _: Annotated[AccessToken, Depends(write_runs)],
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if research is None:
            raise HTTPException(status_code=503, detail="Research workflow is not configured")
        try:
            body = ResearchRunRequest.model_validate_json(await request.body())
            artifact = await research.execute(run_id, body)
        except ValidationError as error:
            raise HTTPException(
                status_code=422,
                detail=_safe_validation_detail(error),
            ) from error
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Research run not found") from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=502, detail="Research execution failed") from error
        return artifact.model_dump(mode="json")

    @app.get("/v1/research/runs/{run_id}/artifact")
    def inspect_research_run_artifact(
        run_id: str,
        _: Annotated[AccessToken, Depends(read_runs)],
    ) -> dict[str, object]:
        if research_artifacts is None:
            raise HTTPException(status_code=503, detail="Research artifacts are not configured")
        artifact = research_artifacts.for_run(run_id)
        if artifact is None:
            raise HTTPException(status_code=404, detail="Research artifact not found")
        return artifact.model_dump(mode="json")

    @app.get("/v1/research/artifacts/{artifact_id}")
    def inspect_research_artifact(
        artifact_id: str,
        _: Annotated[AccessToken, Depends(read_runs)],
    ) -> dict[str, object]:
        if research_artifacts is None:
            raise HTTPException(status_code=503, detail="Research artifacts are not configured")
        try:
            artifact = research_artifacts.get(artifact_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Research artifact not found") from error
        return artifact.model_dump(mode="json")

    @app.post("/v1/study/runs/{run_id}/diagnostic")
    async def prepare_study_diagnostic(
        run_id: str,
        request: Request,
        _: Annotated[AccessToken, Depends(write_runs)],
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if study is None:
            raise HTTPException(status_code=503, detail="Study workflow is not configured")
        try:
            body = StudyStartRequest.model_validate_json(await request.body())
            diagnostic = study.prepare(run_id, body)
        except ValidationError as error:
            raise HTTPException(
                status_code=422,
                detail=_safe_validation_detail(error),
            ) from error
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Study run not found") from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=502, detail="Study diagnostic failed") from error
        return diagnostic.model_dump(mode="json")

    @app.post("/v1/study/runs/{run_id}/path")
    async def submit_study_diagnostic(
        run_id: str,
        request: Request,
        _: Annotated[AccessToken, Depends(write_runs)],
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if study is None:
            raise HTTPException(status_code=503, detail="Study workflow is not configured")
        try:
            body = DiagnosticSubmission.model_validate_json(await request.body())
            artifact = study.submit_diagnostic(run_id, body)
        except ValidationError as error:
            raise HTTPException(
                status_code=422,
                detail=_safe_validation_detail(error),
            ) from error
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Study run not found") from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=502, detail="Study path generation failed") from error
        return artifact.model_dump(mode="json")

    @app.post("/v1/study/runs/{run_id}/exercises/{exercise_id}/attempt")
    async def submit_study_practice(
        run_id: str,
        exercise_id: str,
        request: Request,
        _: Annotated[AccessToken, Depends(write_runs)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if study is None:
            raise HTTPException(status_code=503, detail="Study workflow is not configured")
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            body = PracticeSubmission.model_validate_json(await request.body())
            result = study.submit_practice(
                run_id,
                exercise_id,
                body,
                idempotency_key=idempotency_key,
            )
        except ValidationError as error:
            raise HTTPException(
                status_code=422,
                detail=_safe_validation_detail(error),
            ) from error
        except KeyError as error:
            raise HTTPException(
                status_code=404, detail="Study run or exercise not found"
            ) from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=502, detail="Study practice failed") from error
        return result.model_dump(mode="json")

    @app.get("/v1/study/runs/{run_id}/diagnostic")
    def inspect_study_diagnostic(
        run_id: str,
        _: Annotated[AccessToken, Depends(read_runs)],
    ) -> dict[str, object]:
        if study_artifacts is None:
            raise HTTPException(status_code=503, detail="Study artifacts are not configured")
        try:
            diagnostic = study_artifacts.diagnostic(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Study diagnostic not found") from error
        return diagnostic.model_dump(mode="json")

    @app.get("/v1/study/runs/{run_id}/artifact")
    def inspect_study_artifact(
        run_id: str,
        _: Annotated[AccessToken, Depends(read_runs)],
    ) -> dict[str, object]:
        if study_artifacts is None:
            raise HTTPException(status_code=503, detail="Study artifacts are not configured")
        try:
            artifact = study_artifacts.artifact_for_run(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Study artifact not found") from error
        if artifact is None:
            raise HTTPException(status_code=404, detail="Study artifact not found")
        return artifact.model_dump(mode="json")

    @app.post("/v1/work/runs/{run_id}/plan")
    async def plan_work_run(
        run_id: str,
        request: Request,
        _: Annotated[AccessToken, Depends(write_runs)],
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if work is None:
            raise HTTPException(status_code=503, detail="Work workflow is not configured")
        try:
            body = WorkStartRequest.model_validate_json(await request.body())
            artifact = work.plan(run_id, body)
        except ValidationError as error:
            raise HTTPException(
                status_code=422,
                detail=_safe_validation_detail(error),
            ) from error
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Work run not found") from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=502, detail="Work planning failed") from error
        return artifact.model_dump(mode="json")

    @app.post("/v1/work/runs/{run_id}/handoff/preview")
    def preview_work_handoff(
        run_id: str,
        _: Annotated[AccessToken, Depends(write_runs)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if work is None:
            raise HTTPException(status_code=503, detail="Work workflow is not configured")
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            preview = work.preview_handoff(run_id, idempotency_key=idempotency_key)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Work plan not found") from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=502, detail="Work handoff preview failed") from error
        return preview.model_dump(mode="json")

    @app.post("/v1/work/runs/{run_id}/handoff/export")
    def export_work_handoff(
        run_id: str,
        body: WorkExportPayload,
        _: Annotated[AccessToken, Depends(write_runs)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if work is None:
            raise HTTPException(status_code=503, detail="Work workflow is not configured")
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            result = work.export_handoff(
                run_id,
                body.approval_id,
                idempotency_key=idempotency_key,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Work handoff not found") from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=502, detail="Work handoff export failed") from error
        return result.model_dump(mode="json")

    @app.post("/v1/work/runs/{run_id}/verify")
    async def verify_work_result(
        run_id: str,
        request: Request,
        _: Annotated[AccessToken, Depends(write_runs)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if work is None:
            raise HTTPException(status_code=503, detail="Work workflow is not configured")
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            body = WorkResultManifest.model_validate_json(await request.body())
            report = work.verify(run_id, body, idempotency_key=idempotency_key)
        except ValidationError as error:
            raise HTTPException(
                status_code=422,
                detail=_safe_validation_detail(error),
            ) from error
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Work run not found") from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=502, detail="Work verification failed") from error
        return report.model_dump(mode="json")

    @app.get("/v1/work/runs/{run_id}/artifact")
    def inspect_work_artifact(
        run_id: str,
        _: Annotated[AccessToken, Depends(read_runs)],
    ) -> dict[str, object]:
        if work is None:
            raise HTTPException(status_code=503, detail="Work workflow is not configured")
        try:
            artifact = work.artifact(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Work artifact not found") from error
        return artifact.model_dump(mode="json")

    @app.get("/v1/work/runs/{run_id}/handoff")
    def inspect_work_handoff(
        run_id: str,
        _: Annotated[AccessToken, Depends(read_runs)],
    ) -> dict[str, object]:
        if work is None:
            raise HTTPException(status_code=503, detail="Work workflow is not configured")
        try:
            preview = work.handoff_preview(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Work run not found") from error
        if preview is None:
            raise HTTPException(status_code=404, detail="Work handoff not found")
        return preview.model_dump(mode="json")

    @app.get("/v1/work/runs/{run_id}/verification")
    def inspect_work_verification(
        run_id: str,
        _: Annotated[AccessToken, Depends(read_runs)],
    ) -> dict[str, object]:
        if work is None:
            raise HTTPException(status_code=503, detail="Work workflow is not configured")
        try:
            report = work.latest_verification(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Work run not found") from error
        if report is None:
            raise HTTPException(status_code=404, detail="Work verification not found")
        return report.model_dump(mode="json")

    def configured_daily() -> DailyContextService:
        if daily is None:
            raise HTTPException(status_code=503, detail="Daily context is not configured")
        return daily

    @app.get("/v1/daily")
    async def read_daily_context(
        _: Annotated[AccessToken, Depends(read_daily)],
        timezone: str | None = None,
    ) -> dict[str, object]:
        try:
            snapshot = await configured_daily().snapshot(timezone_name=timezone)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return snapshot.model_dump(mode="json")

    @app.post("/v1/daily/weather")
    async def configure_daily_weather(
        body: WeatherConfigurationPayload,
        _: Annotated[AccessToken, Depends(write_memory)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        if body.enabled and body.mode not in {"query", "coordinates"}:
            raise HTTPException(status_code=422, detail="Weather setup mode is required")
        if body.enabled and body.mode == "query" and not body.query.strip():
            raise HTTPException(status_code=422, detail="A city or region is required")
        if body.enabled and body.mode == "coordinates" and (
            body.latitude is None or body.longitude is None
        ):
            raise HTTPException(status_code=422, detail="Current coordinates are required")
        try:
            resolved = await configured_daily().configure_weather(
                enabled=body.enabled,
                query=body.query if body.mode == "query" else "",
                language=body.language,
                label=body.label,
                latitude=body.latitude,
                longitude=body.longitude,
            )
        except (
            ConnectionError,
            OSError,
            PermissionError,
            TimeoutError,
            json.JSONDecodeError,
        ) as error:
            raise HTTPException(
                status_code=502,
                detail="Weather location lookup is temporarily unavailable",
            ) from error
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return {
            "configured": resolved is not None,
            "location_label": resolved.label if resolved is not None else "",
            "latitude": resolved.latitude if resolved is not None else None,
            "longitude": resolved.longitude if resolved is not None else None,
        }

    @app.post("/v1/daily/calendar")
    def configure_daily_calendar(
        body: CalendarConfigurationPayload,
        _: Annotated[AccessToken, Depends(write_memory)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        if body.enabled and (not body.filename or not body.content):
            raise HTTPException(status_code=422, detail="Select a non-empty ICS file")
        try:
            snapshot = configured_daily().configure_calendar(
                enabled=body.enabled,
                filename=body.filename,
                content=body.content,
                timezone_name=body.timezone or None,
            )
        except (OSError, TypeError, UnicodeError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return snapshot.model_dump(mode="json")

    @app.get("/v1/daily/music/sources")
    def list_daily_music_sources(
        _: Annotated[AccessToken, Depends(read_daily)],
    ) -> list[dict[str, object]]:
        present = False
        try:
            present = KeychainSecretStore().exists(
                KeychainReference(
                    value="keychain:restork/music/apple/developer-token"
                )
            )
        except OSError:
            pass
        return [
            item.model_dump(mode="json")
            for item in music_source_registry(
                apple_developer_credential_present=present
            )
        ]

    @app.post("/v1/daily/music")
    async def configure_daily_music(
        body: MusicConfigurationPayload,
        _: Annotated[AccessToken, Depends(write_memory)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        if body.enabled and body.source == "file" and (not body.filename or not body.content):
            raise HTTPException(status_code=422, detail="Select a non-empty JSON or CSV playlist")
        if (
            body.enabled
            and body.source in {"qqmusic", "netease", "apple-music"}
            and not body.share_url.strip()
        ):
            raise HTTPException(status_code=422, detail="Paste a public playlist share link")
        if (
            body.enabled
            and body.source in {"qqmusic", "netease", "apple-music"}
            and (body.filename or body.content)
        ):
            raise HTTPException(status_code=422, detail="Choose one playlist source")
        try:
            snapshot = await configured_daily().configure_music(
                enabled=body.enabled,
                source=body.source,
                filename=body.filename,
                content=body.content,
                share_url=body.share_url,
                local_date=body.local_date,
            )
        except (AppleMusicError, NetEaseMusicError, QQMusicError) as error:
            raise HTTPException(status_code=502, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except (OSError, TypeError, UnicodeError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return snapshot.model_dump(mode="json")

    @app.post("/v1/daily/music/refresh")
    async def refresh_daily_music(
        body: MusicRefreshPayload,
        _: Annotated[AccessToken, Depends(write_memory)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            snapshot = await configured_daily().refresh_music(local_date=body.local_date)
        except (AppleMusicError, NetEaseMusicError, QQMusicError) as error:
            raise HTTPException(status_code=502, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except (OSError, TypeError, UnicodeError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return snapshot.model_dump(mode="json")

    @app.post("/v1/daily/music/research")
    async def research_daily_music(
        body: MusicRefreshPayload,
        _: Annotated[AccessToken, Depends(write_memory)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            snapshot = await configured_daily().research_music(local_date=body.local_date)
        except MusicResearchError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except (OSError, TypeError, UnicodeError, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return snapshot.model_dump(mode="json")

    @app.get("/v1/daily/music/cover")
    async def read_daily_music_cover(
        _: Annotated[AccessToken, Depends(read_daily)],
    ) -> Response:
        try:
            content, media_type = await configured_daily().music_cover()
        except (
            AppleMusicError,
            KeyError,
            NetEaseMusicError,
            OSError,
            QQMusicError,
            TypeError,
            ValueError,
        ) as error:
            raise HTTPException(status_code=404, detail="Daily cover is unavailable") from error
        headers = {"Cache-Control": "private, no-store"}
        if isinstance(content, Path):
            return FileResponse(content, media_type=media_type, headers=headers)
        return Response(content=content, media_type=media_type, headers=headers)

    @app.post("/v1/runs")
    async def create_run(
        request: Request,
        _: Annotated[AccessToken, Depends(write_runs)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            body = TaskSpec.model_validate_json(await request.body())
            run = Harness(runs, events).start(body, idempotency_key=idempotency_key)
        except ValidationError as error:
            raise HTTPException(
                status_code=422,
                detail=_safe_validation_detail(error),
            ) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return run.model_dump(mode="json")

    @app.post("/v1/runs/{parent_run_id}/work-child")
    async def create_work_child(
        parent_run_id: str,
        request: Request,
        _: Annotated[AccessToken, Depends(write_runs)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if budgets is None:
            raise HTTPException(status_code=503, detail="durable budgets are not configured")
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            child_task = TaskSpec.model_validate_json(await request.body())
            child = Harness(runs, events, budgets).start_work_child(
                parent_run_id,
                child_task,
                idempotency_key=idempotency_key,
            )
        except ValidationError as error:
            raise HTTPException(
                status_code=422,
                detail=_safe_validation_detail(error),
            ) from error
        except KeyError as error:
            raise HTTPException(status_code=404, detail="parent run not found") from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except (BudgetExceeded, ValueError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return child.model_dump(mode="json")

    @app.get("/v1/runs/{run_id}/events")
    async def stream_events(
        run_id: str,
        request: Request,
        _: Annotated[AccessToken, Depends(read_runs)],
        last_event_id: str | None = Header(default=None),
        follow: bool = False,
    ) -> StreamingResponse:
        try:
            after_seq = int(last_event_id) if last_event_id is not None else 0
        except ValueError as error:
            raise HTTPException(
                status_code=400, detail="Last-Event-ID must be an integer"
            ) from error
        if after_seq < 0:
            raise HTTPException(status_code=400, detail="Last-Event-ID must not be negative")
        covered_seq, snapshot, replay_events = events.replay_window(run_id, after_seq=after_seq)
        frames: list[str] = []
        if snapshot is not None and covered_seq is not None:
            frames.append(_sse_frame(covered_seq, "run.snapshot", snapshot))
        frames.extend(
            _sse_frame(event.seq, event.kind, event.metadata)
            for event in replay_events
        )
        headers = {
            "Cache-Control": "no-cache, no-store",
            "X-Accel-Buffering": "no",
        }
        if not follow:
            return StreamingResponse(
                iter(["".join(frames)]),
                media_type="text/event-stream",
                headers=headers,
            )
        try:
            runs.get(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="run not found") from error

        async def follow_events() -> AsyncIterator[str]:
            cursor = max(
                after_seq,
                covered_seq or 0,
                *(event.seq for event in replay_events),
            )
            for frame in frames:
                yield frame
            loop = asyncio.get_running_loop()
            last_output = loop.time()
            while not await request.is_disconnected():
                pending = events.read(run_id, after_seq=cursor)
                for event in pending:
                    cursor = event.seq
                    last_output = loop.time()
                    yield _sse_frame(event.seq, event.kind, event.metadata)
                try:
                    state = runs.get(run_id).state
                except KeyError:
                    return
                if state in _SSE_TERMINAL_STATES:
                    return
                if loop.time() - last_output >= _SSE_HEARTBEAT_SECONDS:
                    last_output = loop.time()
                    yield ": restork-heartbeat\n\n"
                await asyncio.sleep(_SSE_POLL_SECONDS)

        return StreamingResponse(
            follow_events(),
            media_type="text/event-stream",
            headers=headers,
        )

    @app.get("/v1/runs/{run_id}/event-page")
    def event_page(
        run_id: str,
        _: Annotated[AccessToken, Depends(read_runs)],
        before: int | None = None,
        limit: int = 50,
    ) -> dict[str, object]:
        if not 1 <= limit <= 100:
            raise HTTPException(
                status_code=422,
                detail="event page limit must be between 1 and 100",
            )
        try:
            runs.get(run_id)
            page = events.read_latest(run_id, before_seq=before, limit=limit + 1)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="run not found") from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        has_more = len(page) > limit
        page = page[-limit:]
        return {
            "events": [
                {"id": event.seq, "type": event.kind, "data": event.metadata}
                for event in page
            ],
            "page": {
                "limit": limit,
                "has_more": has_more,
                "next_cursor": str(page[0].seq) if has_more and page else None,
            },
        }

    def configured_conversation() -> ConversationService:
        if conversation is None:
            raise HTTPException(
                status_code=503,
                detail="conversation service is not configured",
            )
        return conversation

    @app.get("/v1/runs/{run_id}/conversation")
    def conversation_page(
        run_id: str,
        _: Annotated[AccessToken, Depends(read_runs)],
        before: int | None = None,
        limit: int = 30,
    ) -> dict[str, object]:
        if not 1 <= limit <= 100:
            raise HTTPException(
                status_code=422,
                detail="conversation page limit must be between 1 and 100",
            )
        try:
            page = configured_conversation().latest_page(
                run_id,
                before_sequence=before,
                limit=limit + 1,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail="run not found") from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        has_more = len(page) > limit
        page = page[-limit:]
        return {
            "turns": [turn.model_dump(mode="json") for turn in page],
            "page": {
                "limit": limit,
                "has_more": has_more,
                "next_cursor": str(page[0].sequence) if has_more and page else None,
            },
        }

    @app.post("/v1/runs/{run_id}/conversation")
    async def respond_to_conversation(
        run_id: str,
        body: ConversationInput,
        _: Annotated[AccessToken, Depends(write_runs)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            turn = await configured_conversation().respond(
                run_id,
                body.content,
                idempotency_key=idempotency_key,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail="run not found") from error
        except PermissionError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except RuntimeError as error:
            message = str(error)
            status = 503 if "not configured" in message else 409
            raise HTTPException(status_code=status, detail=message) from error
        except BudgetExceeded as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(
                status_code=502,
                detail="Conversation model call failed",
            ) from error
        return turn.model_dump(mode="json")

    @app.get("/v1/runs/{run_id}")
    def inspect_run(
        run_id: str,
        _: Annotated[AccessToken, Depends(read_runs)],
    ) -> dict[str, object]:
        try:
            run = runs.get(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="run not found") from error
        return run.model_dump(mode="json")

    @app.get("/v1/approvals/{approval_id}")
    def inspect_approval(
        approval_id: str,
        _: Annotated[AccessToken, Depends(read_approvals)],
    ) -> dict[str, object]:
        try:
            approval = approvals.get(approval_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="approval not found") from error
        return approval.model_dump(mode="json")

    @app.post("/v1/runs/{run_id}/cancel")
    def cancel_run(
        run_id: str,
        _: Annotated[AccessToken, Depends(write_runs)],
        idempotency_key: str = Header(default=""),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            cancelled = Harness(runs, events).cancel(run_id, idempotency_key=idempotency_key)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="run not found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return cancelled.model_dump(mode="json")

    @app.post("/v1/runs/{run_id}/resume")
    def resume_run(
        run_id: str,
        _: Annotated[AccessToken, Depends(write_runs)],
        idempotency_key: str = Header(default=""),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            resumed = Harness(runs, events).resume(run_id, idempotency_key=idempotency_key)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="run not found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return resumed.model_dump(mode="json")

    def decide_approval(
        approval_id: str,
        decision: ApprovalDecision,
        body: ApprovalDecisionPayload,
        idempotency_key: str,
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            result = Harness(runs, events).decide_approval(
                approvals,
                approval_id,
                decision,
                body.decided_by,
                idempotency_key=idempotency_key,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail="approval not found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return result.model_dump(mode="json")

    @app.post("/v1/approvals/{approval_id}/approve")
    def approve(
        approval_id: str,
        body: ApprovalDecisionPayload,
        _: Annotated[AccessToken, Depends(decide_approvals)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        return decide_approval(
            approval_id,
            ApprovalDecision.APPROVED,
            body,
            idempotency_key,
        )

    @app.post("/v1/approvals/{approval_id}")
    def decide_canonical(
        approval_id: str,
        body: ApprovalMutationPayload,
        _: Annotated[AccessToken, Depends(decide_approvals)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        decision = (
            ApprovalDecision.APPROVED
            if body.decision == "approve"
            else ApprovalDecision.DENIED
        )
        return decide_approval(
            approval_id,
            decision,
            body,
            idempotency_key,
        )

    @app.post("/v1/approvals/{approval_id}/reject")
    def reject(
        approval_id: str,
        body: ApprovalDecisionPayload,
        _: Annotated[AccessToken, Depends(decide_approvals)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        return decide_approval(
            approval_id,
            ApprovalDecision.DENIED,
            body,
            idempotency_key,
        )

    @app.post("/v1/runs/{run_id}/effects/{intent_id}/resolve")
    def resolve_effect(
        run_id: str,
        intent_id: str,
        body: EffectResolutionPayload,
        _: Annotated[AccessToken, Depends(resolve_effects)],
        idempotency_key: str = Header(default=""),
        __: None = Depends(require_json),
    ) -> dict[str, object]:
        if not idempotency_key:
            raise HTTPException(status_code=400, detail="Idempotency-Key is required")
        try:
            intent = Harness(runs, events).resolve_effect(
                intents,
                run_id,
                intent_id,
                EffectPhase(body.outcome),
                idempotency_key=idempotency_key,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail="effect intent not found") from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return {
            "intent_id": intent.intent_id,
            "run_id": intent.run_id,
            "phase": intent.phase.value,
        }

    selected_web_root = web_root or Path(__file__).resolve().parents[1] / "web"
    asset_root = selected_web_root / "assets"
    index_path = selected_web_root / "index.html"
    favicon_path = selected_web_root / "favicon.svg"
    if asset_root.is_dir() and index_path.is_file():
        app.mount("/assets", StaticFiles(directory=asset_root), name="dashboard-assets")

        if favicon_path.is_file():

            @app.get("/favicon.svg", include_in_schema=False)
            def dashboard_favicon() -> FileResponse:
                return FileResponse(
                    favicon_path,
                    media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=86400"},
                )

        @app.get("/", include_in_schema=False)
        def dashboard_index() -> FileResponse:
            return FileResponse(index_path, headers={"Cache-Control": "no-store"})

    return app


def _token_payload(token: AccessToken) -> dict[str, str]:
    return {
        "access_token": token.value,
        "token_type": "bearer",  # nosec B105
        "audience": token.audience,
        "scope": " ".join(sorted(token.scopes)),
        "expires_at": token.expires_at.isoformat(),
    }
