export type Mode = "research" | "study" | "work";

export interface PageInfo {
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}

export type DashboardListKind = "runs" | "approvals" | "tasks" | "radar" | "memory";

export interface RunSummary {
  run_id: string;
  task_id: string;
  mode: Mode;
  state: string;
  state_version: number;
  stop_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskSpec {
  task_id: string;
  mode: Mode;
  goal: string;
  workspace_scope: string;
  completion_criteria: string[];
  budgets: {
    max_steps: number;
    max_wall_time_seconds: number;
    max_tokens: number | null;
  };
}

export interface RunListEntry {
  summary: RunSummary;
  task: TaskSpec | null;
  budget: {
    budget: TaskSpec["budgets"];
    usage: {
      steps: number;
      retries: number;
      tokens: number;
      cost_usd: number;
      child_tasks: number;
    };
    wall_time_exceeded: boolean;
  } | null;
}

export interface ApprovalRequest {
  approval_id: string;
  run_id: string;
  action_kind: string;
  risk_class: string;
  human_summary: string;
  action_digest: string;
  canonical_scope: string;
  resource_versions: Record<string, string>;
  policy_version: string;
  preview_ref: string | null;
  nonce: string;
  expires_at: string;
  decision: string;
}

export interface TaskMutationPreview {
  task_id: string;
  relative_path: string;
  before_line: string;
  after_line: string;
  expected_hash: string;
  postimage_hash: string;
  approval: ApprovalRequest;
}

export interface TaskApplyResult {
  approval_id: string;
  task_id: string;
  relative_path: string;
  content_hash: string;
  applied: boolean;
}

export interface MarkdownTask {
  task_id: string;
  relative_path: string;
  line_number: number;
  text: string;
  completed: boolean;
  fields: Record<string, string>;
  block_id: string | null;
  locator_hash: string;
}

export type RadarAction = "dismiss" | "read_later" | "research" | "make_task";

export interface RadarItem {
  item_id: string;
  lane: "my_stars" | "trending" | "hn" | "papers";
  title: string;
  source: string;
  url: string;
  summary: string;
  score: number;
  published_at: string | null;
  state: string;
  data_class: string;
}

export interface ResearchArtifact {
  artifact_id: string;
  run_id: string;
  question: string;
  claims: Array<{
    claim_id: string;
    statement: string;
    kind: "grounded" | "inference";
    evidence_refs: string[];
    inference_basis: string | null;
  }>;
  conflicts: Array<{ description: string; evidence_refs: string[] }>;
  unresolved_questions: string[];
  related_notes: Array<{ relative_path: string; title: string; score: number }>;
  note_preview: {
    action: "create" | "append" | "no_change";
    relative_path: string;
    expected_hash: string | null;
    markdown: string;
    markdown_hash: string;
  };
  metrics: {
    supported_claim_rate: number;
    primary_source_ratio: number;
    citation_correctness: number;
    duplicate_sources: number;
    related_note_count: number;
    conflict_count: number;
  };
}

export interface StudyDiagnostic {
  diagnostic_id: string;
  run_id: string;
  objective: string;
  questions: Array<{
    question_id: string;
    prompt: string;
    response_kind: "rating" | "free_text";
  }>;
  source_snapshot_hash: string | null;
  created_at: string;
}

export interface StudyArtifact {
  artifact_id: string;
  run_id: string;
  readiness_signal: "foundation" | "developing" | "ready";
  objective: {
    objective_id: string;
    outcome: string;
    success_criteria: string[];
  };
  prerequisites: Array<{
    relative_path: string;
    title: string;
    rationale: string;
    explicit_source: "prerequisite_section";
  }>;
  related_notes: Array<{ relative_path: string; title: string }>;
  learning_path: Array<{
    step_id: string;
    order: number;
    title: string;
    outcome: string;
    note_refs: string[];
  }>;
  exercises: Array<{
    exercise_id: string;
    concept: string;
    kind: "active_recall" | "application";
    prompt: string;
    hints: string[];
    answer_revealed: false;
  }>;
  metrics: {
    diagnostic_completed: true;
    explicit_prerequisite_ratio: number;
    practice_count: number;
    related_note_count: number;
  };
  sensitivity: string;
  created_at: string;
  validation_status: "valid";
}

export interface PracticeAttemptResult {
  attempt_id: string;
  run_id: string;
  exercise_id: string;
  correct: boolean;
  feedback: string;
  error_count: number;
  attempt_count: number;
  next_review: {
    action: "retry_with_hint" | "spaced_review";
    due_at: string;
    interval_days: number;
    reason: string;
  };
  record_preview: {
    relative_path: string;
    markdown: string;
    markdown_hash: string;
    attempt_count: number;
    apply_available: false;
  } | null;
  created_at: string;
}

export type WorkDataClass = "public" | "personal" | "confidential";

export interface WorkStartInput {
  goal: string;
  workspace_root: string;
  target_files: string[];
  context_files: string[];
  constraints: string[];
  non_goals: string[];
  completion_criteria: string[];
  verification_commands: string[];
  context_data_class: WorkDataClass;
}

export interface WorkPlanArtifact {
  artifact_id: string;
  run_id: string;
  request_hash: string;
  workspace_id: string;
  workspace_snapshot_hash: string;
  goal: string;
  scope_summary: string;
  target_files: string[];
  context_manifest: Array<{
    relative_path: string;
    content_hash: string | null;
    byte_count: number;
    language: string;
    data_class: WorkDataClass;
    included_in_handoff: boolean;
    exists_at_plan: boolean;
    redactions: string[];
  }>;
  instruction_refs: string[];
  constraints: string[];
  non_goals: string[];
  completion_criteria: string[];
  plan_steps: Array<{
    step_id: string;
    order: number;
    title: string;
    intent: string;
    target_files: string[];
    verification: string[];
  }>;
  verification_commands: string[];
  warnings: string[];
  sensitivity: WorkDataClass;
  created_at: string;
  validation_status: "valid";
}

export interface WorkHandoffPreview {
  plan: WorkPlanArtifact;
  envelope: {
    handoff_id: string;
    run_id: string;
    plan_ref: string;
    workspace_id: string;
    base_snapshot_hash: string;
    goal: string;
    target_files: string[];
    constraints: string[];
    non_goals: string[];
    completion_criteria: string[];
    proposed_verification_commands: string[];
    context: Array<{
      relative_path: string;
      content_hash: string | null;
      byte_count: number;
      data_class: WorkDataClass;
      content: string;
      exists_at_plan: boolean;
      redactions: string[];
    }>;
    executor_boundary: "external_user_started_no_restork_executor";
    created_at: string;
    validation_status: "valid";
  };
  package_hash: string;
  byte_count: number;
  approval: ApprovalRequest;
}

export interface WorkExportResult {
  run_id: string;
  approval_id: string;
  artifact_ref: string;
  package_hash: string;
  byte_count: number;
  applied: true;
  exported_at: string;
}

export interface WorkResultManifest {
  schema_version?: number;
  run_id: string;
  plan_artifact_id: string;
  base_snapshot_hash: string;
  changed_files: Array<{
    relative_path: string;
    before_hash: string | null;
    after_hash: string | null;
  }>;
  claimed_commands: Array<{ command: string; exit_code: number }>;
  artifacts: Array<{ relative_path: string; content_hash: string }>;
  summary: string;
}

export interface WorkVerificationReport {
  verification_id: string;
  run_id: string;
  manifest_hash: string;
  status: "verified" | "partial" | "failed";
  changed_files: Array<{
    relative_path: string;
    status: "matched" | "mismatched" | "unverified";
    expected_hash: string | null;
    observed_hash: string | null;
    reason: string;
  }>;
  artifacts: Array<{
    relative_path: string;
    status: "matched" | "mismatched" | "unverified";
    expected_hash: string | null;
    observed_hash: string | null;
    reason: string;
  }>;
  commands: Array<{
    command_hash: string;
    claimed_exit_code: number;
    status: "unverified";
    reason: string;
  }>;
  unexpected_changes: string[];
  completion_eligible: boolean;
  task_update_preview: {
    run_id: string;
    action: "mark_complete";
    suggested_markdown: string;
    evidence_ref: string;
    apply_available: false;
  } | null;
  created_at: string;
}

export interface RadarActionResult {
  item: RadarItem;
  run_id: string | null;
  research_artifact: ResearchArtifact | null;
  task_preview_available: boolean;
  task_approval_id: string | null;
}

export interface MemoryRecord {
  memory_id: string;
  layer: "working" | "episodic" | "semantic" | "profile";
  kind: string;
  summary: string;
  provenance: string;
  data_class: string;
  retention_class: string;
  updated_at: string;
  content_hash: string;
}

export type DailyStatus = "not_configured" | "ready" | "fresh" | "stale" | "error";

export interface WeatherSnapshot {
  configured: boolean;
  status: DailyStatus;
  provider: string;
  location_label: string;
  condition: string;
  temperature_c: number | null;
  apparent_temperature_c: number | null;
  relative_humidity_percent: number | null;
  is_day: boolean | null;
  observed_at: string | null;
  expires_at: string | null;
  attribution: string;
  message: string;
}

export type WeatherConfigurationInput =
  | { enabled: false }
  | { enabled: true; mode: "query"; query: string; language: "en" | "zh" }
  | {
      enabled: true;
      mode: "coordinates";
      label: string;
      latitude: number;
      longitude: number;
    };

export interface WeatherConfigurationResult {
  configured: boolean;
  location_label: string;
  latitude: number | null;
  longitude: number | null;
}

export type CalendarConfigurationInput =
  | { enabled: false; timezone: string }
  | { enabled: true; filename: string; content: string; timezone: string };

export interface CalendarEvent {
  event_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  redacted: boolean;
}

export interface MusicRecommendation {
  item_id: string;
  title: string;
  artist: string;
  album: string;
  tags: string[];
  analysis: string;
  cover_available: boolean;
}

export interface DailySnapshot {
  weather: WeatherSnapshot;
  calendar: {
    configured: boolean;
    status: DailyStatus;
    events: CalendarEvent[];
    message: string;
  };
  music: {
    configured: boolean;
    status: DailyStatus;
    recommendation: MusicRecommendation | null;
    message: string;
  };
}

export type ProviderStatus =
  | "not_configured"
  | "invalid_configuration"
  | "credential_missing"
  | "ready"
  | "connected"
  | "smoke_passed"
  | "authentication_failed"
  | "insufficient_balance"
  | "rate_limited"
  | "timeout"
  | "provider_unavailable"
  | "model_unavailable"
  | "invalid_response"
  | "policy_denied";

export interface ProviderDiagnostic {
  schema_version: 1;
  provider: "deepseek";
  model: "deepseek-v4-pro";
  status: ProviderStatus;
  message: string;
  setup_command: "uv run restork provider configure";
  config_present: boolean;
  config_valid: boolean;
  credential_present: boolean;
  connection_checked: boolean;
  connection_ok: boolean | null;
  model_available: boolean | null;
  smoke_checked: boolean;
  smoke_ok: boolean | null;
  restart_required: boolean;
  latency_ms: number | null;
  request_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

export interface DashboardSnapshot {
  runs: RunListEntry[];
  approvals: ApprovalRequest[];
  taskBoard: { configured: boolean; tasks: MarkdownTask[] };
  radar: { configured: boolean; items: RadarItem[] };
  memory: {
    records: MemoryRecord[];
    counts: Record<string, number>;
    architecture: string[];
  } | null;
  daily: DailySnapshot | null;
  provider: ProviderDiagnostic | null;
  pagination?: Partial<Record<DashboardListKind, PageInfo>>;
}

export type DashboardListPage =
  | { kind: "runs"; items: RunListEntry[]; page: PageInfo }
  | { kind: "approvals"; items: ApprovalRequest[]; page: PageInfo }
  | { kind: "tasks"; items: MarkdownTask[]; page: PageInfo; configured: boolean }
  | { kind: "radar"; items: RadarItem[]; page: PageInfo; configured: boolean }
  | {
      kind: "memory";
      items: MemoryRecord[];
      page: PageInfo;
      counts: Record<string, number>;
      architecture: string[];
    };

export interface RunEventPage {
  events: RunEvent[];
  page: PageInfo;
}

export interface ConversationMessage {
  message_id: string;
  run_id: string;
  turn_sequence: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  data_class: WorkDataClass;
}

export interface ConversationTurn {
  turn_id: string;
  run_id: string;
  sequence: number;
  mode: Mode;
  user: ConversationMessage;
  assistant: ConversationMessage | null;
  prompt_id: string;
  prompt_version: string;
  prompt_hash: string;
  dropped_messages: number;
  estimated_context_tokens: number;
  total_tokens: number | null;
}

export interface ConversationPage {
  turns: ConversationTurn[];
  page: PageInfo;
}

export interface RunEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

export interface DashboardApi {
  pair(code: string): Promise<void>;
  loadDashboard(): Promise<DashboardSnapshot>;
  createRun(mode: Mode, goal: string, dataClass?: WorkDataClass): Promise<RunSummary>;
  prepareStudy(
    runId: string,
    objective: string,
    targetNote: string | null,
  ): Promise<StudyDiagnostic>;
  submitStudyDiagnostic(
    runId: string,
    answers: Record<string, string>,
  ): Promise<StudyArtifact>;
  submitStudyPractice(
    runId: string,
    exerciseId: string,
    answer: string,
    confidence: number,
  ): Promise<PracticeAttemptResult>;
  planWork(runId: string, input: WorkStartInput): Promise<WorkPlanArtifact>;
  previewWorkHandoff(runId: string): Promise<WorkHandoffPreview>;
  exportWorkHandoff(runId: string, approvalId: string): Promise<WorkExportResult>;
  verifyWorkResult(
    runId: string,
    manifest: WorkResultManifest,
  ): Promise<WorkVerificationReport>;
  decideApproval(
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<ApprovalRequest>;
  radarAction(itemId: string, action: RadarAction): Promise<RadarActionResult>;
  previewTask(taskId: string, completed: boolean): Promise<TaskMutationPreview>;
  captureTask(text: string, priority: string): Promise<TaskMutationPreview>;
  applyTask(approvalId: string): Promise<TaskApplyResult>;
  configureWeather(input: WeatherConfigurationInput): Promise<WeatherConfigurationResult>;
  configureCalendar(input: CalendarConfigurationInput): Promise<DailySnapshot["calendar"]>;
  providerDiagnostics(smoke: boolean): Promise<ProviderDiagnostic>;
  musicCover(): Promise<Blob | null>;
  events(runId: string, after: number): Promise<RunEvent[]>;
  streamEvents(
    runId: string,
    after: number,
    onEvent: (event: RunEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  loadPage?(kind: DashboardListKind, cursor: string): Promise<DashboardListPage>;
  eventPage?(runId: string, before?: string): Promise<RunEventPage>;
  conversationPage?(runId: string, before?: string): Promise<ConversationPage>;
  sendConversation?(runId: string, content: string): Promise<ConversationTurn>;
}
