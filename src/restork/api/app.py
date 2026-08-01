"""Authenticated local FastAPI app with replayable run-event SSE."""

import json
from collections.abc import Callable
from hashlib import sha256
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request
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
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import ApprovalDecision, EffectPhase, Mode
from restork.daily.service import DailyContextService
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
from restork.research.models import SourceRequest
from restork.research.store import SQLiteResearchStore
from restork.research.workflow import ResearchRunRequest, ResearchWorkflow
from restork.runtime.runner import Harness
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore
from restork.tools.registry import DEFAULT_TOOL_DEFINITIONS


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
) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

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
        }

    def configured_memory() -> MemoryService:
        if memory is None:
            raise HTTPException(status_code=503, detail="memory service is not configured")
        return memory

    @app.get("/v1/memory")
    def inspect_memory(
        _: Annotated[AccessToken, Depends(read_memory)],
        layer: MemoryLayer | None = None,
    ) -> dict[str, object]:
        payload = configured_memory().inspect(layer).model_dump(mode="json")
        records = payload.get("records")
        if isinstance(records, list):
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
        limit: int = 50,
    ) -> dict[str, object]:
        try:
            summaries = runs.list_runs(limit=limit)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
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
        return {"runs": items}

    @app.get("/v1/approvals")
    def list_approvals(
        _: Annotated[AccessToken, Depends(read_approvals)],
        pending_only: bool = False,
        limit: int = 50,
    ) -> dict[str, object]:
        try:
            requests = approvals.list_requests(pending_only=pending_only, limit=limit)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return {
            "approvals": [request.model_dump(mode="json") for request in requests]
        }

    @app.get("/v1/tasks")
    def list_tasks(
        _: Annotated[AccessToken, Depends(read_tasks)],
        include_completed: bool = True,
    ) -> dict[str, object]:
        board = tasks or MarkdownTaskBoard()
        return board.snapshot(include_completed=include_completed).model_dump(mode="json")

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
    ) -> dict[str, object]:
        snapshot = (
            radar.snapshot(include_dismissed=include_dismissed)
            if radar is not None
            else empty_radar_snapshot()
        )
        return snapshot.model_dump(mode="json")

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
                detail=error.errors(include_context=False),
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

    @app.get("/v1/daily")
    async def read_daily_context(
        _: Annotated[AccessToken, Depends(read_daily)],
    ) -> dict[str, object]:
        if daily is None:
            raise HTTPException(status_code=503, detail="Daily context is not configured")
        snapshot = await daily.snapshot()
        return snapshot.model_dump(mode="json")

    @app.get("/v1/daily/music/cover")
    def read_daily_music_cover(
        _: Annotated[AccessToken, Depends(read_daily)],
    ) -> FileResponse:
        if daily is None:
            raise HTTPException(status_code=503, detail="Daily context is not configured")
        try:
            path, media_type = daily.music_cover()
        except (KeyError, OSError, TypeError, ValueError) as error:
            raise HTTPException(status_code=404, detail="Daily cover is unavailable") from error
        return FileResponse(
            path,
            media_type=media_type,
            headers={"Cache-Control": "private, no-store"},
        )

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
                detail=error.errors(include_context=False),
            ) from error
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return run.model_dump(mode="json")

    @app.get("/v1/runs/{run_id}/events")
    def stream_events(
        run_id: str,
        _: Annotated[AccessToken, Depends(read_runs)],
        last_event_id: str | None = Header(default=None),
    ) -> StreamingResponse:
        try:
            after_seq = int(last_event_id) if last_event_id is not None else 0
        except ValueError as error:
            raise HTTPException(
                status_code=400, detail="Last-Event-ID must be an integer"
            ) from error
        covered_seq, snapshot, replay_events = events.replay_window(run_id, after_seq=after_seq)
        frames: list[str] = []
        if snapshot is not None and covered_seq is not None:
            frames.append(
                f"id: {covered_seq}\nevent: run.snapshot\ndata: {json.dumps(snapshot)}\n\n"
            )
        frames.extend(
            f"id: {event.seq}\nevent: {event.kind}\ndata: {json.dumps(event.metadata)}\n\n"
            for event in replay_events
        )
        payload = "".join(frames)
        return StreamingResponse(iter([payload]), media_type="text/event-stream")

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
