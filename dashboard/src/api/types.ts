// `study` returns when the vault-grounded rebuild lands (Stage 5).
export type Mode = "research" | "work";

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

export type DailyStatus =
  | "not_configured"
  | "ready"
  | "fresh"
  | "stale"
  | "denied"
  | "restricted"
  | "unsupported"
  | "error";

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

export interface MailSnapshot {
  configured: boolean;
  status: DailyStatus;
  provider: string;
  unread_count: number | null;
  observed_at: string | null;
  message: string;
}

export interface NativeMailCapability {
  platform: string;
  adapter: string;
  available: boolean;
  status: string;
  detail_scopes: Array<"unread_count">;
  refresh_interval_seconds: number;
  message: string;
}

export interface MusicRecommendation {
  item_id: string;
  title: string;
  artist: string;
  album: string;
  tags: string[];
  analysis: string;
  recommendation_reason?: string;
  song_analysis?: string;
  popularity_reason?: string;
  language?: string;
  genre?: string;
  published_on?: string | null;
  source_url?: string;
  cover_available: boolean;
  research?: MusicResearchSummary | null;
}

export interface MusicEvidenceSource {
  title: string;
  url: string;
  publisher: string;
  published_on: string | null;
  supports: Array<"analysis" | "popularity">;
}

export interface MusicResearchSummary {
  status: "fresh" | "cached" | "stale";
  model: "deepseek-v4-flash";
  researched_at: string;
  song_analysis_en: string;
  song_analysis_zh_cn: string;
  popularity_reason_en: string;
  popularity_reason_zh_cn: string;
  popularity_supported: boolean;
  sources: MusicEvidenceSource[];
}

export type MusicConfigurationInput =
  | { enabled: false; local_date?: string }
  | {
      enabled: true;
      source: "file";
      filename: string;
      content: string;
      local_date: string;
    }
  | {
      enabled: true;
      source: "qqmusic" | "netease" | "apple-music";
      share_url: string;
      local_date: string;
    };

export interface MusicSourceCapabilities {
  read_only: boolean;
  refresh_supported: boolean;
  supports_public_playlists: boolean;
  supports_library: boolean;
  supports_charts: boolean;
  requires_user_consent: boolean;
}

export interface MusicSourceDefinition {
  provider: "local-file" | "qqmusic" | "netease" | "apple-music";
  label: string;
  stability: "stable" | "official" | "experimental";
  credential_mode: "none" | "native_secret";
  setup_status: "ready" | "credential_missing" | "unavailable";
  setup_command: string;
  capabilities: MusicSourceCapabilities;
}

export interface MusicDiscovery {
  item_id: string;
  title: string;
  artist: string;
  album: string;
  language: string;
  genre: string;
  label: string;
  published_on: string | null;
  chart_name: string;
  chart_rank: number;
  chart_updated_on: string | null;
  affinity_artist: string;
  affinity_count: number;
  recommendation_reason: string;
  song_analysis: string;
  popularity_reason: string;
  source_url: string;
}

export interface MusicSourceSummary {
  provider: string;
  label: string;
  item_count: number;
  synced_at: string | null;
  public_url: string;
  refresh_supported: boolean;
  experimental: boolean;
  official_api?: boolean;
  read_only?: boolean;
  requires_user_consent?: boolean;
  supports_charts?: boolean;
}

export interface DailySnapshot {
  weather: WeatherSnapshot;
  calendar: {
    configured: boolean;
    status: DailyStatus;
    events: CalendarEvent[];
    message: string;
  };
  native_calendar?: {
    platform: string;
    adapter: string;
    available: boolean;
    status: string;
    detail_scopes: Array<"busy_only" | "titles">;
    message: string;
  };
  mail?: MailSnapshot;
  native_mail?: NativeMailCapability;
  music: {
    configured: boolean;
    status: DailyStatus;
    recommendation: MusicRecommendation | null;
    source?: MusicSourceSummary | null;
    discoveries?: MusicDiscovery[];
    message: string;
  };
}

export type ProviderStatus =
  | "not_configured"
  | "invalid_configuration"
  | "credential_missing"
  | "ready"
  | "connected"
  | "manual_model_ready"
  | "smoke_passed"
  | "authentication_failed"
  | "insufficient_balance"
  | "rate_limited"
  | "timeout"
  | "provider_unavailable"
  | "model_unavailable"
  | "invalid_response"
  | "web_search_not_executed"
  | "structured_output_invalid"
  | "sources_missing"
  | "policy_denied";

export interface ProviderDiagnostic {
  schema_version: 1;
  provider: string;
  model: string;
  status: ProviderStatus;
  message: string;
  setup_command: string;
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

export interface PersonalSettingsRecord {
  settings: {
    display_name?: string;
    locale?: string;
    timezone?: string;
    week_start?: string;
    theme?: string;
  };
  version: number;
  updated_at: string | null;
}

export interface DailyContextV2 {
  observed_at: string;
  timezone: string;
  local_date: string;
  local_time: string;
  time_band: "morning" | "noon" | "afternoon" | "evening" | "late_night";
}

export interface SessionRecordV2 {
  session_id: string;
  title: string;
  profile_id: string;
  status: "active" | "archived";
  version: number;
  locale: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SessionMessageV2 {
  message_id: string;
  session_id: string;
  sequence: number;
  role: "user" | "assistant" | "system";
  content: string;
  context: Record<string, unknown>;
  data_class: WorkDataClass;
  created_at: string;
}

export interface SessionForkResultV2 {
  session: SessionRecordV2;
  source_session_id: string;
  copied_messages: number;
  omitted_messages: number;
  copied_bytes: number;
  profile_id: string;
}

export interface SessionSearchHitV2 {
  session_id: string;
  message_id: string;
  sequence: number;
  excerpt: string;
}

export interface SessionExportV2 {
  schema_version: 1;
  session: SessionRecordV2;
  messages: SessionMessageV2[];
  exported_at: string;
  secret_values_included: false;
  note: string;
}

export interface RunProposalV2 {
  proposal_id: string;
  session_id: string;
  profile_id: string;
  mode: Mode;
  goal: string;
  completion_criteria: string[];
  requested_data_class: WorkDataClass;
  requested_tools: string[];
  sources: unknown[];
  intake_boundary: {
    network_access: false;
    file_access: false;
    provider_access: false;
    tool_access: false;
  };
  status: "review_required";
  version: number;
  created_at: string;
}

export interface CatalogRecordV2 {
  package_id?: string;
  deliverable_id?: string;
  schedule_id?: string;
  package_kind?: string;
  kind?: string;
  state: string;
  revision?: number;
  manifest_hash?: string;
  manifest?: Record<string, unknown>;
  installed_at?: string;
  updated_at: string;
  artifact?: Record<string, unknown>;
  schedule?: Record<string, unknown>;
  next_run_at?: string | null;
}

export interface ToolSearchHitV2 {
  tool_id: string;
  name: string;
  score: number;
}

export interface ToolSearchResultV2 {
  session_id: string;
  catalog_fingerprint: string;
  items: ToolSearchHitV2[];
}

export interface ToolCallPreviewV2 {
  state: "review_required";
  execution_started: false;
  output_is_untrusted: true;
  call_digest: string;
  resolved_call: {
    real_tool_id: string;
    package_id: string;
    package_version: string;
    server_id: string;
    required_permissions: string[];
    input: Record<string, unknown>;
  };
}

export interface ToolExecutionV2 {
  execution_id: string;
  session_id: string;
  tool_id: string;
  package_id: string;
  package_hash: string;
  catalog_fingerprint: string;
  call_digest: string;
  state: "running" | "succeeded" | "failed" | "cancelled";
  result: Record<string, unknown> | null;
  error_code: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface RenderPreviewV2 {
  state: "review_required";
  download_started: false;
  manifest: {
    renderer_id: string;
    renderer_version: string;
    format: "pptx" | "pdf";
    deck_id: string;
    deck_revision: number;
    deck_spec_hash: string;
    artifact_hash: string;
    byte_count: number;
    macro_free: boolean;
    deterministic: boolean;
  };
}

export interface RenderDownloadV2 {
  blob: Blob;
  filename: string;
  artifactHash: string;
}

export interface ManualReportInputV2 {
  report_id: string;
  revision: number;
  kind: "daily" | "weekly";
  title: string;
  language: string;
  timezone: string;
  entries: Array<{
    section: "summary" | "completed" | "progress" | "decisions" | "blockers" | "next" | "notes";
    text: string;
  }>;
}

export interface DeckFromReportInputV2 {
  deck_id: string;
  revision: number;
  report_id: string;
  report_revision: number;
  language: string;
  audience: {
    audience_id: string;
    purpose: string;
    expertise: string;
  };
}

export interface ScheduleSpecV2 {
  schedule_id: string;
  timezone: string;
  recurrence:
    | { kind: "one_shot"; at: string }
    | { kind: "daily"; hour: number; minute: number }
    | { kind: "weekly"; weekday_monday_zero: number; hour: number; minute: number };
  missed_run_policy: "skip" | "create_draft";
  job:
    | { kind: "deterministic"; job: "health.check" | "daily.refresh" }
    | { kind: "model_draft"; profile_id: string; requested_effect: null };
}

export interface ScheduleRunV2 {
  schedule_id: string;
  period_key: string;
  run_id: string | null;
  result: Record<string, unknown>;
  created_at: string;
  replayed: boolean;
}

export interface ProviderProfileRecordV2 {
  provider: {
    profile_id: string;
    version: number;
    display_name: string;
    kind: ProviderKindV2;
    base_url: string;
    model: string;
    secret_ref: string | null;
    fallback: "disabled" | { require_confirmation: { provider_profile_id: string } };
    reasoning: ReasoningConfigV2;
  };
  revision: number;
  updated_at: string;
}

export type ReasoningEffortV2 =
  | "auto"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ReasoningConfigV2 {
  effort: ReasoningEffortV2;
  max_tokens: number | null;
}

export type ProviderKindV2 =
  | "deepseek"
  | "glm"
  | "kimi"
  | "qwen"
  | "ollama"
  | "open_ai_compatible"
  | "openrouter";

export interface ProviderDefinitionV2 {
  registry_version: number;
  kind: ProviderKindV2;
  id: ProviderKindV2;
  display_name: string;
  protocol: "open_ai_chat_completions" | "ollama_chat";
  default_base_url: string;
  endpoint_policy: "exact_official" | "public_https" | "loopback_only";
  auth_kind: "none" | "bearer";
  model_discovery: "open_ai_models" | "ollama_tags" | "manual_only";
  request_adapter: string;
  capabilities: {
    streaming: boolean;
    tool_calls: boolean;
    json_output: boolean;
    reasoning: boolean;
    vision: boolean;
  };
  reasoning: {
    can_disable: boolean;
    supported_efforts: ReasoningEffortV2[];
    supports_token_budget: boolean;
  };
  docs_url: string;
}

export interface ProviderRegistryV2 {
  registry_version: number;
  items: ProviderDefinitionV2[];
}

export interface ConfigurationProfileRecordV2 {
  profile: {
    profile_id: string;
    version: number;
    name: string;
    provider_profile_id: string;
    prompt_manifest_hash: string;
    enabled_skill_ids: string[];
    allowed_tools: string[];
    memory_namespace: string;
    maximum_data_class: WorkDataClass;
    include_display_name_in_prompt: boolean;
  };
  revision: number;
  builtin: boolean;
  updated_at: string;
}

export interface PromptRevisionRecordV2 {
  prompt: {
    prompt_id: string;
    revision: number;
    layer: "policy" | "skill" | "personal" | "run_context";
    content: string;
    content_hash: string;
    parent_hash: string | null;
    created_at: string;
  };
  content_hash: string;
  active: boolean;
  created_at: string;
}

export interface RustWorkspaceSnapshot {
  dailyContext: DailyContextV2 | null;
  personal: PersonalSettingsRecord | null;
  sessions: SessionRecordV2[];
  extensions: CatalogRecordV2[];
  deliverables: CatalogRecordV2[];
  schedules: CatalogRecordV2[];
  providers?: ProviderProfileRecordV2[];
  providerRegistry?: ProviderRegistryV2;
  profiles?: ConfigurationProfileRecordV2[];
  prompts?: PromptRevisionRecordV2[];
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
  musicSources?: MusicSourceDefinition[];
  pagination?: Partial<Record<DashboardListKind, PageInfo>>;
  workspaceV2?: RustWorkspaceSnapshot;
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

export interface ConversationOperationV2 {
  operation_id: string;
  session_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  state: "queued" | "preparing" | "streaming" | "validating" | "cancel_requested" | "completed" | "cancelled" | "failed";
  phase: string;
  context_preview_hash: string | null;
  provider_binding: Record<string, unknown>;
  cancel_requested: boolean;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ConversationOperationCreateResultV2 {
  operation: ConversationOperationV2;
  user_message: SessionMessageV2;
  replayed: boolean;
}

export interface ContextPreviewRecordV2 {
  preview_id: string;
  session_id: string;
  content_hash: string;
  manifest: {
    schema_version: number;
    boundary: string;
    untrusted: boolean;
    entries: Array<{
      name: string;
      content_hash: string;
      byte_count: number;
      content: string;
    }>;
  };
  data_class: WorkDataClass;
  byte_count: number;
  estimated_tokens: number;
  created_at: string;
  expires_at: string;
  used_operation_id: string | null;
}

export interface DashboardApi {
  pair(code: string): Promise<void>;
  loadDashboard(): Promise<DashboardSnapshot>;
  createRun(mode: Mode, goal: string, dataClass?: WorkDataClass): Promise<RunSummary>;
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
  connectNativeCalendar?(
    detailScope: "busy_only" | "titles",
  ): Promise<DailySnapshot["calendar"]>;
  disconnectNativeCalendar?(): Promise<DailySnapshot["calendar"]>;
  connectNativeMail?(): Promise<MailSnapshot>;
  disconnectNativeMail?(): Promise<MailSnapshot>;
  streamMail?(
    onSnapshot: (snapshot: MailSnapshot) => void,
    signal: AbortSignal,
  ): Promise<void>;
  configureMusic?(input: MusicConfigurationInput): Promise<DailySnapshot["music"]>;
  refreshMusic?(localDate: string): Promise<DailySnapshot["music"]>;
  researchMusic?(localDate: string): Promise<DailySnapshot["music"]>;
  providerDiagnostics(
    smoke: boolean,
    target?: "primary" | "web_search",
    providerProfileId?: string,
  ): Promise<ProviderDiagnostic>;
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
  createSession?(title: string, profileId: string): Promise<SessionRecordV2>;
  forkSession?(
    sessionId: string,
    title: string,
    profileId: string,
    expectedUpdatedAt: string,
    copyLimit?: number,
  ): Promise<SessionForkResultV2>;
  sessionMessages?(sessionId: string, after?: number): Promise<SessionMessageV2[]>;
  sendSessionMessage?(
    sessionId: string,
    content: string,
    dataClass?: WorkDataClass,
  ): Promise<SessionMessageV2>;
  createConversationTurn?(
    sessionId: string,
    content: string,
    dataClass?: WorkDataClass,
    contextPreviewHash?: string | null,
  ): Promise<ConversationOperationCreateResultV2>;
  createContextPreview?(
    sessionId: string,
    dataClass: WorkDataClass,
    items: Array<{ name: string; content: string }>,
  ): Promise<ContextPreviewRecordV2>;
  streamConversationOperation?(
    operationId: string,
    after: number,
    onEvent: (event: RunEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  cancelConversationOperation?(operationId: string): Promise<ConversationOperationV2>;
  createSessionProposal?(
    sessionId: string,
    mode: Mode,
    goal: string,
    dataClass?: WorkDataClass,
  ): Promise<RunProposalV2>;
  savePersonalSettings?(
    expectedVersion: number | null,
    settings: PersonalSettingsRecord["settings"],
  ): Promise<PersonalSettingsRecord>;
  saveProviderProfile?(
    expectedRevision: number | null,
    provider: ProviderProfileRecordV2["provider"],
  ): Promise<ProviderProfileRecordV2>;
  saveConfigurationProfile?(
    expectedRevision: number | null,
    profile: ConfigurationProfileRecordV2["profile"],
  ): Promise<ConfigurationProfileRecordV2>;
  createPromptRevision?(
    promptId: string,
    expectedRevision: number | null,
    layer: "skill" | "personal",
    content: string,
  ): Promise<PromptRevisionRecordV2>;
  activatePromptRevision?(
    promptId: string,
    revision: number,
    expectedActiveRevision: number | null,
  ): Promise<PromptRevisionRecordV2>;
  archiveSession?(sessionId: string, expectedVersion: number): Promise<SessionRecordV2>;
  deleteSession?(sessionId: string, expectedVersion: number): Promise<void>;
  exportSession?(sessionId: string): Promise<SessionExportV2>;
  searchSessions?(query: string): Promise<SessionSearchHitV2[]>;
  installExtension?(
    packageKind: "skill" | "mcp" | "plugin",
    manifest: Record<string, unknown>,
  ): Promise<CatalogRecordV2>;
  setExtensionState?(
    packageId: string,
    action: "enable" | "disable",
    expectedHash: string,
  ): Promise<CatalogRecordV2>;
  extensionRevisions?(packageId: string): Promise<CatalogRecordV2[]>;
  rollbackExtension?(
    packageId: string,
    expectedHash: string,
    targetHash: string,
  ): Promise<CatalogRecordV2>;
  searchSessionTools?(sessionId: string, query: string): Promise<ToolSearchResultV2>;
  previewSessionToolCall?(
    sessionId: string,
    toolId: string,
    input: Record<string, unknown>,
  ): Promise<ToolCallPreviewV2>;
  executeSessionToolCall?(
    sessionId: string,
    preview: ToolCallPreviewV2,
  ): Promise<ToolExecutionV2>;
  previewDeliverableRender?(
    deliverableId: string,
    revision: number,
    format: "pptx" | "pdf",
  ): Promise<RenderPreviewV2>;
  exportDeliverableRender?(preview: RenderPreviewV2): Promise<RenderDownloadV2>;
  composeManualReport?(input: ManualReportInputV2): Promise<CatalogRecordV2>;
  composeDeckFromReport?(input: DeckFromReportInputV2): Promise<CatalogRecordV2>;
  createSchedule?(schedule: ScheduleSpecV2): Promise<CatalogRecordV2>;
  changeScheduleState?(
    scheduleId: string,
    action: "pause" | "resume",
    expectedRevision: number,
  ): Promise<CatalogRecordV2>;
  runScheduleNow?(scheduleId: string): Promise<ScheduleRunV2>;
  deleteSchedule?(scheduleId: string, expectedRevision: number): Promise<void>;
}
