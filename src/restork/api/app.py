"""Authenticated local FastAPI app with replayable run-event SSE."""

from __future__ import annotations

import json

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.middleware.base import RequestResponseEndpoint

from restork.api.auth import PairingAuthority
from restork.storage.events import SQLiteEventStore


def create_app(events: SQLiteEventStore, pairing: PairingAuthority) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def require_token(authorization: str = Header(default="")) -> None:
        scheme, _, token = authorization.partition(" ")
        if scheme != "Bearer" or not token:
            raise HTTPException(status_code=401, detail="Bearer authorization is required")
        try:
            pairing.verify(token, "restork-web")
        except PermissionError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error

    @app.middleware("http")
    async def local_origin_only(request: Request, call_next: RequestResponseEndpoint) -> Response:
        origin = request.headers.get("origin")
        if origin and origin not in {"http://127.0.0.1", "http://localhost"}:
            return JSONResponse(status_code=403, content={"detail": "cross-origin request denied"})
        return await call_next(request)

    @app.post("/api/pair")
    def pair(body: dict[str, str]) -> dict[str, str]:
        try:
            token = pairing.pair(body.get("code", ""), "restork-web")
        except PermissionError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        return {"access_token": token.value, "token_type": "bearer"}  # nosec B105

    @app.get("/api/runs/{run_id}/events")
    def stream_events(
        run_id: str,
        last_event_id: str | None = Header(default=None),
        _: None = Depends(require_token),
    ) -> StreamingResponse:
        try:
            after_seq = int(last_event_id) if last_event_id is not None else 0
        except ValueError as error:
            raise HTTPException(
                status_code=400, detail="Last-Event-ID must be an integer"
            ) from error
        payload = "".join(
            f"id: {event.seq}\nevent: {event.kind}\ndata: {json.dumps(event.metadata)}\n\n"
            for event in events.read(run_id, after_seq=after_seq)
        )
        return StreamingResponse(iter([payload]), media_type="text/event-stream")

    return app
