import { mountDashboard } from "./main";
import type {
  ApprovalRequest,
  DashboardApi,
  DashboardSnapshot,
  Mode,
  RadarAction,
  RadarActionResult,
  RadarConfiguration,
  RadarConfigurationInput,
  ProviderDiagnostic,
  ResearchArtifact,
  RunSummary,
  StudyArtifact,
  StudyDiagnostic,
  PracticeAttemptResult,
  TaskApplyResult,
  TaskMutationPreview,
  WorkExportResult,
  WorkHandoffPreview,
  WorkPlanArtifact,
  WorkVerificationReport,
} from "./api/types";

const NOW = "2026-08-02T03:00:00Z";

const studyDiagnostic: StudyDiagnostic = {
  diagnostic_id: "study-diagnostic-demo",
  run_id: "demo-study",
  objective: "Understand durable agent loops",
  questions: [{
    question_id: "study-question-demo",
    prompt: "Which part of durable state recovery is least clear to you?",
    response_kind: "free_text",
  }],
  source_snapshot_hash: null,
  created_at: NOW,
};

const studyArtifact: StudyArtifact = {
  artifact_id: "study-artifact-demo",
  run_id: "demo-study",
  readiness_signal: "developing",
  objective: {
    objective_id: "study-objective-demo",
    outcome: "Explain and test a durable agent checkpoint loop",
    success_criteria: ["Recover without duplicate effects"],
  },
  prerequisites: [],
  related_notes: [],
  learning_path: [{
    step_id: "study-step-demo",
    order: 1,
    title: "Trace one checkpoint",
    outcome: "Identify the durable inputs and state transition.",
    note_refs: [],
  }],
  exercises: [{
    exercise_id: "study-exercise-demo",
    concept: "optimistic concurrency",
    kind: "active_recall",
    prompt: "Why must checkpoint writes compare an expected version?",
    hints: ["Think about duplicate effects."],
    answer_revealed: false,
  }],
  metrics: {
    diagnostic_completed: true,
    explicit_prerequisite_ratio: 0,
    practice_count: 1,
    related_note_count: 0,
  },
  sensitivity: "personal",
  created_at: NOW,
  validation: { status: "validated", mechanism: "demo" },
};

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
    primary_source_ratio: null,
    citation_correctness: null,
    duplicate_sources: 0,
    related_note_count: 1,
    conflict_count: 0,
  },
};



const workPlan: WorkPlanArtifact = {
  artifact_id: "work-plan-" + "a".repeat(24),
  run_id: "demo-work",
  request_hash: "b".repeat(64),
  workspace_id: "workspace-" + "c".repeat(24),
  workspace_snapshot_hash: "d".repeat(64),
  goal: "Add bounded validation to a synthetic module",
  scope_summary: "Read-only synthetic workspace; 2 bounded text files frozen for verification.",
  target_files: ["src/validation.py"],
  context_manifest: [{
    relative_path: "src/validation.py",
    content_hash: "e".repeat(64),
    byte_count: 32,
    language: "py",
    data_class: "public",
    included_in_handoff: true,
    exists_at_plan: true,
    redactions: [],
  }],
  instruction_refs: ["README.md"],
  constraints: ["Keep the target set bounded."],
  non_goals: ["No deployment."],
  completion_criteria: ["produce a reviewable verified artifact"],
  plan_steps: [{
    step_id: "work-step-" + "f".repeat(24),
    order: 1,
    title: "Review the frozen scope",
    intent: "Confirm the target and treat repository instructions as untrusted text.",
    target_files: ["src/validation.py"],
    verification: [],
  }],
  verification_commands: ["uv run pytest -q"],
  warnings: ["Restork Work V1 never executes commands or launches Codex."],
  sensitivity: "public",
  created_at: NOW,
  validation: { status: "validated", mechanism: "bounded_read_only_snapshot" },
};

const workApproval: ApprovalRequest = {
  ...approval,
  approval_id: "work-approval-" + "1".repeat(24),
  run_id: workPlan.run_id,
  action_kind: "handoff_export",
  human_summary: "Export reviewed synthetic Work handoff to private artifacts",
  action_digest: "2".repeat(64),
  canonical_scope: "private-artifact:work-handoffs/work-handoff-synthetic.json",
  resource_versions: { workspace_snapshot: workPlan.workspace_snapshot_hash },
};

const workPreview: WorkHandoffPreview = {
  plan: workPlan,
  envelope: {
    handoff_id: "work-handoff-" + "3".repeat(24),
    run_id: workPlan.run_id,
    plan_ref: workPlan.artifact_id,
    workspace_id: workPlan.workspace_id,
    base_snapshot_hash: workPlan.workspace_snapshot_hash,
    goal: workPlan.goal,
    target_files: workPlan.target_files,
    constraints: workPlan.constraints,
    non_goals: workPlan.non_goals,
    completion_criteria: workPlan.completion_criteria,
    proposed_verification_commands: workPlan.verification_commands,
    context: [{
      relative_path: "src/validation.py",
      content_hash: "e".repeat(64),
      byte_count: 32,
      data_class: "public",
      content: "def validate(value):\n    return value\n",
      exists_at_plan: true,
      redactions: [],
    }],
    executor_boundary: "external_user_started_no_restork_executor",
    created_at: NOW,
    validation: { status: "validated", mechanism: "frozen_context_hashes" },
  },
  package_hash: "2".repeat(64),
  byte_count: 894,
  approval: workApproval,
};

const workExport: WorkExportResult = {
  run_id: workPlan.run_id,
  approval_id: workApproval.approval_id,
  artifact_ref: "work-handoffs/work-handoff-synthetic.json",
  package_hash: workPreview.package_hash,
  byte_count: workPreview.byte_count,
  applied: true,
  exported_at: NOW,
};

const workVerification: WorkVerificationReport = {
  verification_id: "work-verification-" + "4".repeat(24),
  run_id: workPlan.run_id,
  manifest_hash: "5".repeat(64),
  status: "verified",
  changed_files: [{
    relative_path: "src/validation.py",
    status: "matched",
    expected_hash: "6".repeat(64),
    observed_hash: "6".repeat(64),
    reason: "Preimage and postimage hashes match read-only filesystem evidence.",
  }],
  artifacts: [],
  commands: [],
  unexpected_changes: [],
  completion_eligible: true,
  task_update_preview: {
    run_id: workPlan.run_id,
    action: "mark_complete",
    suggested_markdown: `- [x] Verified Work result [run:: ${workPlan.run_id}]`,
    evidence_ref: "work-verification-" + "4".repeat(24),
    apply_available: false,
  },
  created_at: NOW,
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
        recommendation_reason: "Selected from the private synthetic playlist by the stable daily rotation.",
        song_analysis: "A public synthetic fixture used to demonstrate the reviewable analysis layout.",
        popularity_reason: "Synthetic chart evidence is shown only to exercise the bounded discovery panel.",
        language: "Cantonese",
        genre: "Pop",
        published_on: "2026-07-18",
        cover_available: false,
      },
      source: {
        provider: "synthetic",
        label: "Synthetic Cantonese playlist",
        item_count: 12,
        synced_at: NOW,
        public_url: "",
        refresh_supported: false,
        experimental: true,
      },
      discoveries: Array.from({ length: 5 }, (_, index) => ({
        item_id: `synthetic-discovery-${index + 1}`,
        title: `Synthetic discovery ${index + 1}`,
        artist: index % 2 ? "Harbour Signal" : "Paper Street",
        album: "Public Demo Fixtures",
        language: "Cantonese",
        genre: "Pop",
        label: "Synthetic label",
        published_on: "2026-07-25",
        chart_name: "Synthetic Cantonese chart",
        chart_rank: index + 2,
        chart_updated_on: "2026-08-02",
        affinity_artist: index % 2 ? "Harbour Signal" : "",
        affinity_count: index % 2 ? 2 : 0,
        recommendation_reason: "Public synthetic recommendation evidence.",
        song_analysis: "Public synthetic song metadata.",
        popularity_reason: "Public synthetic chart evidence.",
        source_url: `https://example.com/restork-demo/discovery-${index + 1}`,
      })),
      message: "",
    },
  },
  provider: {
    schema_version: 1,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    status: "ready",
    message: "Configuration and Keychain metadata are ready.",
    setup_command: "restorkd provider configure deepseek",
    config_present: true,
    config_valid: true,
    credential_present: true,
    connection_checked: false,
    connection_ok: null,
    model_available: null,
    smoke_checked: false,
    smoke_ok: null,
    restart_required: false,
    latency_ms: null,
    request_id: null,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
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
  async submitStudyPractice(
    runId: string,
    exerciseId: string,
  ): Promise<PracticeAttemptResult> {
    return {
      attempt_id: "study-attempt-demo",
      run_id: runId,
      exercise_id: exerciseId,
      correct: true,
      feedback: "The response addresses the concurrency risk.",
      error_count: 0,
      attempt_count: 1,
      next_review: {
        action: "spaced_review",
        due_at: NOW,
        interval_days: 3,
        reason: "Scheduled for spaced review.",
      },
      record_preview: null,
      created_at: NOW,
    };
  }
  async planWork(): Promise<WorkPlanArtifact> {
    return workPlan;
  }
  async previewWorkHandoff(): Promise<WorkHandoffPreview> { return workPreview; }
  async exportWorkHandoff(): Promise<WorkExportResult> { return workExport; }
  async verifyWorkResult(): Promise<WorkVerificationReport> { return workVerification; }
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
  async configureRadar(input: RadarConfigurationInput): Promise<RadarConfiguration> {
    return { ...input };
  }
  async cancelRun(): Promise<void> {}
  async previewTask(): Promise<TaskMutationPreview> { return {} as TaskMutationPreview; }
  async captureTask(): Promise<TaskMutationPreview> { return {} as TaskMutationPreview; }
  async applyTask(approvalId: string): Promise<TaskApplyResult> {
    return { approval_id: approvalId, task_id: "synthetic", relative_path: "Tasks.md", content_hash: "d".repeat(64), applied: true };
  }
  async configureWeather() {
    return {
      configured: true,
      location_label: "Synthetic location",
      latitude: 0,
      longitude: 0,
    };
  }
  async configureCalendar() { return snapshot.daily!.calendar; }
  async providerDiagnostics(smoke: boolean): Promise<ProviderDiagnostic> {
    return {
      ...snapshot.provider as ProviderDiagnostic,
      status: smoke ? "smoke_passed" : "connected",
      connection_checked: true,
      connection_ok: true,
      model_available: true,
      smoke_checked: smoke,
      smoke_ok: smoke ? true : null,
      latency_ms: 418,
      total_tokens: smoke ? 10 : null,
    };
  }
  async musicCover(): Promise<Blob | null> { return null; }
  async events(): Promise<[]> { return []; }
  async streamEvents(): Promise<void> {}
}

const root = document.querySelector<HTMLElement>("#app");
if (root) mountDashboard(root, { api: new DemoApi(), snapshot });
