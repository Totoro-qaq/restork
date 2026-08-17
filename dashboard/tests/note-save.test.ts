import { afterEach, describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import { approvalsView, researchPreviewMarkup, studyArtifactMarkup } from "../src/ui/render";
import type {
  ApprovalRequest,
  DashboardApi,
  DashboardSnapshot,
  ResearchArtifact,
  StudyArtifact,
} from "../src/api/types";

const NOW = "2026-08-08T00:00:00Z";

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approval_id: "approval-note-save",
    run_id: "run-note-save",
    action_kind: "vault_write",
    risk_class: "local_write",
    human_summary: "Append a source-backed note to Research/Note.md",
    action_digest: "a".repeat(64),
    canonical_scope: "Research/Note.md",
    resource_versions: { "Research/Note.md": "preimage" },
    policy_version: "v1",
    preview_ref: null,
    nonce: "nonce",
    expires_at: "2026-08-09T00:00:00Z",
    decision: "pending",
    ...overrides,
  };
}

function researchArtifact(): ResearchArtifact {
  return {
    artifact_id: "research-artifact-note-save",
    run_id: "run-research-note-save",
    question: "Does the save button render?",
    claims: [{
      claim_id: "claim-1",
      statement: "The button binds to the preview endpoint.",
      kind: "grounded",
      evidence_refs: ["evidence-1"],
      inference_basis: null,
    }],
    conflicts: [],
    unresolved_questions: [],
    related_notes: [],
    note_preview: {
      action: "append",
      relative_path: "Research/Note.md",
      expected_hash: "b".repeat(64),
      markdown: "## Research update\n\n- grounded claim\n",
      markdown_hash: "c".repeat(64),
    },
    metrics: {
      supported_claim_rate: 1,
      primary_source_ratio: null,
      citation_correctness: null,
      duplicate_sources: 0,
      related_note_count: 0,
      conflict_count: 0,
    },
  };
}

function studyArtifact(withNotePreview: boolean): StudyArtifact {
  return {
    artifact_id: "study-artifact-note-save",
    run_id: "run-study-note-save",
    readiness_signal: "developing",
    objective: {
      objective_id: "study-objective-note-save",
      outcome: "Explain durable checkpoint loops",
      success_criteria: ["Recover without duplicate effects"],
    },
    prerequisites: [],
    related_notes: [],
    learning_path: [{
      step_id: "study-step-1",
      order: 1,
      title: "Trace one checkpoint",
      outcome: "Identify the durable inputs.",
      note_refs: [],
    }],
    exercises: [{
      exercise_id: "study-exercise-1",
      concept: "optimistic concurrency",
      kind: "active_recall",
      prompt: "Why compare an expected version?",
      hints: ["Think about duplicate effects."],
      answer_revealed: false,
    }],
    metrics: {
      diagnostic_completed: true,
      explicit_prerequisite_ratio: 0,
      practice_count: 1,
      related_note_count: 0,
    },
    note_preview: withNotePreview
      ? {
        action: "create",
        relative_path: "Restork Study - Durable Checkpoint Loops.md",
        expected_hash: null,
        markdown: "# Durable checkpoint loops\n",
        markdown_hash: "d".repeat(64),
      }
      : null,
    sensitivity: "personal",
    created_at: NOW,
    validation: { status: "validated", mechanism: "test" },
  };
}

function snapshot(approvals: ApprovalRequest[]): DashboardSnapshot {
  return {
    runs: [],
    approvals,
    taskBoard: { configured: false, tasks: [] },
    radar: { configured: false, items: [] },
    memory: {
      records: [],
      counts: { working: 0, episodic: 0, semantic: 0, profile: 0 },
      architecture: ["working", "episodic", "semantic", "profile"],
    },
    daily: null,
    provider: null,
  } as DashboardSnapshot;
}

function fakeApi(approvals: ApprovalRequest[]): DashboardApi {
  return {
    pair: vi.fn(async () => undefined),
    loadDashboard: vi.fn(async () => snapshot(approvals)),
    decideApproval: vi.fn(async () => {
      throw new Error("not used");
    }),
    applyTask: vi.fn(async () => {
      throw new Error("not used");
    }),
    previewResearchNote: vi.fn(async () => {
      throw new Error("not used");
    }),
    previewStudyNote: vi.fn(async () => {
      throw new Error("not used");
    }),
  } as unknown as DashboardApi;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("save-to-vault buttons on artifacts", () => {
  it("renders a save button on the research artifact preview", () => {
    const markup = researchPreviewMarkup(researchArtifact(), "en");
    expect(markup).toContain('data-note-save="research"');
    expect(markup).toContain('data-note-run-id="run-research-note-save"');
    expect(markup).toContain("Save to vault");
    expect(markup).not.toContain('data-note-save="research" data-run-id=');
  });

  it("renders a save button on the study artifact only when a note preview exists", () => {
    const withPreview = studyArtifactMarkup(studyArtifact(true), "en");
    expect(withPreview).toContain('data-note-save="study"');
    expect(withPreview).toContain('data-note-run-id="run-study-note-save"');
    expect(withPreview).toContain("Restork Study - Durable Checkpoint Loops.md");

    const withoutPreview = studyArtifactMarkup(studyArtifact(false), "en");
    expect(withoutPreview).not.toContain("data-note-save");
  });
});

describe("approval cards for vault writes", () => {
  it("offers APPLY WRITE for an approved vault_write approval", () => {
    const markup = approvalsView(snapshot([approval({ decision: "approved" })]), "en");
    expect(markup).toContain("APPLY WRITE");
    expect(markup).toContain('data-task-apply="approval-note-save"');
    expect(markup).toContain('data-action-kind="vault_write"');
  });

  it("offers APPLY WRITE for an approved task_write approval", () => {
    const markup = approvalsView(
      snapshot([approval({ decision: "approved", action_kind: "task_write" })]),
      "en",
    );
    expect(markup).toContain("APPLY WRITE");
    expect(markup).toContain('data-task-apply="approval-note-save"');
  });

  it("keeps pending approvals on approve/reject and hides apply", () => {
    const markup = approvalsView(snapshot([approval()]), "en");
    expect(markup).toContain("CONFIRM");
    expect(markup).toContain("DO NOT APPLY");
    expect(markup).not.toContain("data-task-apply");
  });

  it("never offers apply for non-write action kinds", () => {
    const markup = approvalsView(
      snapshot([approval({ decision: "approved", action_kind: "handoff_export" })]),
      "en",
    );
    expect(markup).not.toContain("data-task-apply");
  });
});

describe("vault write approval flow", () => {
  it("applies the write after approving a vault_write approval", async () => {
    const approvals = [approval()];
    const api = fakeApi(approvals);
    vi.spyOn(api, "decideApproval").mockResolvedValue(approval({ decision: "approved" }));
    const applyTask = vi.spyOn(api, "applyTask").mockResolvedValue({
      approval_id: "approval-note-save",
      task_id: "task-note-save",
      relative_path: "Research/Note.md",
      content_hash: "e".repeat(64),
      applied: true,
    });
    const root = document.createElement("main");
    document.body.append(root);
    mountDashboard(root, { api, snapshot: snapshot(approvals) });

    root.querySelector<HTMLButtonElement>('[data-decision="approve"]')?.click();

    await vi.waitFor(() => expect(applyTask).toHaveBeenCalledWith("approval-note-save"));
    expect(api.decideApproval).toHaveBeenCalledWith("approval-note-save", "approve");
  });

  it("applies an already-approved vault_write from the apply button", async () => {
    const approvals = [approval({ decision: "approved" })];
    const api = fakeApi(approvals);
    const applyTask = vi.spyOn(api, "applyTask").mockResolvedValue({
      approval_id: "approval-note-save",
      task_id: "task-note-save",
      relative_path: "Research/Note.md",
      content_hash: "e".repeat(64),
      applied: true,
    });
    const root = document.createElement("main");
    document.body.append(root);
    mountDashboard(root, { api, snapshot: snapshot(approvals) });

    root.querySelector<HTMLButtonElement>('[data-task-apply="approval-note-save"]')?.click();

    await vi.waitFor(() => expect(applyTask).toHaveBeenCalledWith("approval-note-save"));
  });
});
