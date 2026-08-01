import { mountDashboard } from "./main";
import type {
  ApprovalRequest,
  DashboardApi,
  DashboardSnapshot,
  Mode,
  RadarAction,
  RadarActionResult,
  PracticeAttemptResult,
  ResearchArtifact,
  RunSummary,
  StudyArtifact,
  StudyDiagnostic,
  TaskApplyResult,
  TaskMutationPreview,
} from "./api/types";

const NOW = "2026-08-02T03:00:00Z";

const approval: ApprovalRequest = {
  approval_id: "approval-synthetic-note",
  run_id: "run-research-synthetic",
  action_kind: "vault_write",
  risk_class: "local_write",
  human_summary: "Append a source-backed evidence card to Research/Synthetic Local Agents.md",
  action_digest: "6c66daee616f19a795e33ef92d06ef5fd004b65a46f36a640f99bd8f4ef4f000",
  canonical_scope: "Research/Synthetic Local Agents.md",
  resource_versions: { "Research/Synthetic Local Agents.md": "synthetic-preimage" },
  policy_version: "v1",
  preview_ref: null,
  nonce: "synthetic-nonce",
  expires_at: "2026-08-02T03:10:00Z",
  decision: "pending",
};

const researchArtifact: ResearchArtifact = {
  artifact_id: "research-synthetic-preview",
  run_id: "run-research-synthetic",
  question: "How does the typed local agent harness preserve evidence?",
  claims: [
    {
      claim_id: "claim-synthetic-1",
      statement: "The fixture binds each grounded claim to a bounded evidence card.",
      kind: "grounded",
      evidence_refs: ["evidence-synthetic-1"],
      inference_basis: null,
    },
    {
      claim_id: "claim-synthetic-2",
      statement: "This design may reduce unsupported synthesis during review.",
      kind: "inference",
      evidence_refs: [],
      inference_basis: "A labeled design inference, not a measured product claim.",
    },
  ],
  conflicts: [],
  unresolved_questions: ["How should citation correctness be sampled on larger fixtures?"],
  related_notes: [{ relative_path: "Research/Agent Harness.md", title: "Agent Harness", score: 28 }],
  note_preview: {
    action: "append",
    relative_path: "Research/Agent Harness.md",
    expected_hash: "e".repeat(64),
    markdown: "## Research update\n\n- **grounded:** Claims bind to bounded evidence cards. [evidence-synthetic-1]\n",
    markdown_hash: "f".repeat(64),
  },
  metrics: {
    supported_claim_rate: 0.5,
    primary_source_ratio: 1,
    citation_correctness: 1,
    duplicate_sources: 0,
    related_note_count: 1,
    conflict_count: 0,
  },
};

const studyDiagnostic: StudyDiagnostic = {
  diagnostic_id: "study-diagnostic-" + "1".repeat(24),
  run_id: "run-study-synthetic",
  objective: "Practice Bayesian model comparison with a synthetic dataset",
  questions: [
    {
      question_id: "diagnostic-" + "2".repeat(24),
      prompt: "Rate your current readiness from 0 to 4.",
      response_kind: "rating",
    },
    {
      question_id: "diagnostic-" + "3".repeat(24),
      prompt: "Explain what successful model comparison means without notes.",
      response_kind: "free_text",
    },
  ],
  source_snapshot_hash: null,
  created_at: NOW,
};

const studyArtifact: StudyArtifact = {
  artifact_id: "study-" + "4".repeat(24),
  run_id: studyDiagnostic.run_id,
  readiness_signal: "developing",
  objective: {
    objective_id: "objective-" + "5".repeat(24),
    outcome: studyDiagnostic.objective,
    success_criteria: ["Explain the central concept without notes."],
  },
  prerequisites: [],
  related_notes: [],
  learning_path: [
    {
      step_id: "learning-step-" + "6".repeat(24),
      order: 1,
      title: "Construct the target model",
      outcome: "Explain the comparison and its assumptions.",
      note_refs: [],
    },
    {
      step_id: "learning-step-" + "7".repeat(24),
      order: 2,
      title: "Active recall and transfer",
      outcome: "Apply the concept to a new synthetic example.",
      note_refs: [],
    },
  ],
  exercises: [
    {
      exercise_id: "exercise-" + "8".repeat(24),
      concept: "Bayesian model comparison",
      kind: "active_recall",
      prompt: "Explain Bayesian model comparison without opening a note.",
      hints: ["Name its purpose and one boundary."],
      answer_revealed: false,
    },
  ],
  metrics: {
    diagnostic_completed: true,
    explicit_prerequisite_ratio: 0,
    practice_count: 1,
    related_note_count: 0,
  },
  sensitivity: "public",
  created_at: NOW,
  validation_status: "valid",
};

const snapshot: DashboardSnapshot = {
  runs: [
    {
      summary: {
        run_id: "run-research-synthetic",
        task_id: "task-research-synthetic",
        mode: "research",
        state: "running",
        state_version: 4,
        stop_reason: null,
        created_at: "2026-08-02T02:44:00Z",
        updated_at: "2026-08-02T02:58:00Z",
      },
      task: {
        task_id: "task-research-synthetic",
        mode: "research",
        goal: "Compare local-first agent memory designs using public synthetic sources",
        workspace_scope: "demo-vault",
        completion_criteria: ["Every claim references evidence"],
        budgets: { max_steps: 12, max_wall_time_seconds: 3600, max_tokens: 120000 },
      },
      budget: {
        budget: { max_steps: 12, max_wall_time_seconds: 3600, max_tokens: 120000 },
        usage: { steps: 6, retries: 0, tokens: 43820, cost_usd: 0, child_tasks: 0 },
        wall_time_exceeded: false,
      },
    },
    {
      summary: {
        run_id: "run-study-synthetic",
        task_id: "task-study-synthetic",
        mode: "study",
        state: "completed",
        state_version: 8,
        stop_reason: "completed",
        created_at: "2026-08-01T11:00:00Z",
        updated_at: "2026-08-01T11:24:00Z",
      },
      task: {
        task_id: "task-study-synthetic",
        mode: "study",
        goal: "Practice Bayesian model comparison with a synthetic dataset",
        workspace_scope: "demo-vault",
        completion_criteria: ["Complete one recall exercise"],
        budgets: { max_steps: 10, max_wall_time_seconds: 2400, max_tokens: 80000 },
      },
      budget: null,
    },
  ],
  approvals: [approval],
  taskBoard: {
    configured: true,
    tasks: [
      {
        task_id: "restork-reviewevidence",
        relative_path: "Projects/Restork.md",
        line_number: 18,
        text: "Review evidence coverage #todo [due:: 2026-08-03] [priority:: P1] ^restork-reviewevidence",
        completed: false,
        fields: { due: "2026-08-03", priority: "P1" },
        block_id: "restork-reviewevidence",
        locator_hash: "a".repeat(64),
      },
      {
        task_id: "restork-recallsession",
        relative_path: "Study/Queue.md",
        line_number: 7,
        text: "Run the next recall session #todo [priority:: P2] ^restork-recallsession",
        completed: false,
        fields: { priority: "P2" },
        block_id: "restork-recallsession",
        locator_hash: "b".repeat(64),
      },
    ],
  },
  radar: {
    configured: true,
    items: [
      {
        item_id: "radar-synthetic-star",
        lane: "my_stars",
        title: "Typed local agent harness",
        source: "GitHub · synthetic fixture",
        url: "https://example.com/restork/synthetic-harness",
        summary: "A public synthetic repository used only for the product demo.",
        score: 0.94,
        published_at: "2026-08-01T09:00:00Z",
        state: "new",
        data_class: "public",
      },
      {
        item_id: "radar-synthetic-hn",
        lane: "hn",
        title: "What should an agent remember?",
        source: "HN · synthetic fixture",
        url: "https://example.com/restork/synthetic-discussion",
        summary: "A synthetic discussion about retention boundaries.",
        score: 0.82,
        published_at: "2026-08-02T01:30:00Z",
        state: "read_later",
        data_class: "public",
      },
    ],
  },
  memory: {
    records: [
      {
        memory_id: "episode-synthetic-research",
        layer: "episodic",
        kind: "decision",
        summary: "Keep source Markdown as truth; treat indexes as rebuildable projections.",
        provenance: "user",
        data_class: "public",
        retention_class: "session",
        updated_at: NOW,
        content_hash: "c".repeat(64),
      },
    ],
    counts: { working: 3, episodic: 1, semantic: 24, profile: 4 },
    architecture: ["working", "episodic", "semantic", "profile"],
  },
  daily: {
    weather: {
      configured: true,
      status: "fresh",
      provider: "open-meteo",
      location_label: "Demo City",
      condition: "Partly cloudy",
      temperature_c: 27.4,
      apparent_temperature_c: 29.1,
      relative_humidity_percent: 71,
      is_day: true,
      observed_at: NOW,
      expires_at: "2026-08-02T03:30:00Z",
      attribution: "Weather data by Open-Meteo · synthetic response",
      message: "",
    },
    calendar: {
      configured: true,
      status: "ready",
      events: [
        {
          event_id: "event-synthetic-review",
          title: "Review evidence cards",
          starts_at: "2026-08-02T04:00:00Z",
          ends_at: "2026-08-02T04:30:00Z",
          all_day: false,
          redacted: false,
        },
        {
          event_id: "event-synthetic-private",
          title: "Busy",
          starts_at: "2026-08-02T06:00:00Z",
          ends_at: "2026-08-02T07:00:00Z",
          all_day: false,
          redacted: true,
        },
      ],
      message: "",
    },
    music: {
      configured: true,
      status: "ready",
      recommendation: {
        item_id: "track-synthetic-paper",
        title: "Paper Lanterns",
        artist: "Example Artist",
        album: "Synthetic Sessions",
        tags: ["focus", "acoustic"],
        analysis: "Selected from a deterministic daily rotation and a user-authored focus tag.",
        cover_available: false,
      },
      message: "",
    },
  },
};

class DemoApi implements DashboardApi {
  async pair(): Promise<void> {}
  async loadDashboard(): Promise<DashboardSnapshot> { return snapshot; }
  async createRun(mode: Mode, goal: string): Promise<RunSummary> {
    return { ...snapshot.runs[0].summary, run_id: `demo-${mode}`, mode, task_id: goal };
  }
  async prepareStudy(): Promise<StudyDiagnostic> { return studyDiagnostic; }
  async submitStudyDiagnostic(): Promise<StudyArtifact> { return studyArtifact; }
  async submitStudyPractice(): Promise<PracticeAttemptResult> {
    return {
      attempt_id: "attempt-" + "9".repeat(24),
      run_id: studyArtifact.run_id,
      exercise_id: studyArtifact.exercises[0].exercise_id,
      correct: false,
      feedback: "Review the concept and use the exercise hint before retrying.",
      error_count: 1,
      attempt_count: 1,
      next_review: {
        action: "retry_with_hint",
        due_at: NOW,
        interval_days: 0,
        reason: "The synthetic attempt missed a private rubric term.",
      },
      record_preview: null,
      created_at: NOW,
    };
  }
  async decideApproval(
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<ApprovalRequest> {
    return { ...approval, approval_id: approvalId, decision: decision === "approve" ? "approved" : "denied" };
  }
  async radarAction(itemId: string, action: RadarAction): Promise<RadarActionResult> {
    const item = snapshot.radar.items.find((candidate) => candidate.item_id === itemId)
      ?? snapshot.radar.items[0];
    return {
      item,
      run_id: action === "research" ? researchArtifact.run_id : null,
      research_artifact: action === "research" ? researchArtifact : null,
      task_preview_available: false,
      task_approval_id: null,
    };
  }
  async previewTask(): Promise<TaskMutationPreview> { return {} as TaskMutationPreview; }
  async captureTask(): Promise<TaskMutationPreview> { return {} as TaskMutationPreview; }
  async applyTask(approvalId: string): Promise<TaskApplyResult> {
    return { approval_id: approvalId, task_id: "synthetic", relative_path: "Tasks.md", content_hash: "d".repeat(64), applied: true };
  }
  async musicCover(): Promise<Blob | null> { return null; }
  async events(): Promise<[]> { return []; }
}

const root = document.querySelector<HTMLElement>("#app");
if (root) mountDashboard(root, { api: new DemoApi(), snapshot });
