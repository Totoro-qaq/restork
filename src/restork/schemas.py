"""JSON Schema exports for local clients generated from Core contracts."""

from __future__ import annotations

from typing import Any

from restork.artifacts.research import ResearchArtifact
from restork.artifacts.study import StudyArtifact, StudyDiagnostic
from restork.artifacts.work import WorkHandoffEnvelope, WorkPlanArtifact
from restork.contracts.approval import ApprovalRequest
from restork.contracts.event import RunEvent
from restork.contracts.task import TaskSpec
from restork.research.models import SourceCard, SourceRequest
from restork.research.workflow import ResearchRunRequest
from restork.study.models import (
    DiagnosticSubmission,
    PracticeAttemptResult,
    PracticeSubmission,
    StudyStartRequest,
)
from restork.work.models import (
    WorkExportResult,
    WorkHandoffPreview,
    WorkResultManifest,
    WorkStartRequest,
    WorkVerificationReport,
)


def contract_schemas() -> dict[str, dict[str, Any]]:
    """Return the V1 schemas shared by the Core and TypeScript clients."""
    return {
        "ApprovalRequest": ApprovalRequest.model_json_schema(),
        "RunEvent": RunEvent.model_json_schema(),
        "DiagnosticSubmission": DiagnosticSubmission.model_json_schema(),
        "PracticeAttemptResult": PracticeAttemptResult.model_json_schema(),
        "PracticeSubmission": PracticeSubmission.model_json_schema(),
        "ResearchArtifact": ResearchArtifact.model_json_schema(),
        "ResearchRunRequest": ResearchRunRequest.model_json_schema(),
        "SourceCard": SourceCard.model_json_schema(),
        "SourceRequest": SourceRequest.model_json_schema(),
        "StudyArtifact": StudyArtifact.model_json_schema(),
        "StudyDiagnostic": StudyDiagnostic.model_json_schema(),
        "StudyStartRequest": StudyStartRequest.model_json_schema(),
        "TaskSpec": TaskSpec.model_json_schema(),
        "WorkExportResult": WorkExportResult.model_json_schema(),
        "WorkHandoffEnvelope": WorkHandoffEnvelope.model_json_schema(),
        "WorkHandoffPreview": WorkHandoffPreview.model_json_schema(),
        "WorkPlanArtifact": WorkPlanArtifact.model_json_schema(),
        "WorkResultManifest": WorkResultManifest.model_json_schema(),
        "WorkStartRequest": WorkStartRequest.model_json_schema(),
        "WorkVerificationReport": WorkVerificationReport.model_json_schema(),
    }
