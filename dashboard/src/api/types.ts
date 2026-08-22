export type Mode = "research" | "study" | "work";

export interface PageInfo {
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}

export interface CatalogCursorV2 {
  updated_at: string;
  id: string;
  version: number;
}
export type PresentationThemeLayoutV2 =
  | "editorial" | "minimal" | "spotlight" | "research" | "narrative" | "blueprint"
  | "ppt_master_apple" | "ppt_master_jangpm" | "ppt_master_mckinsey" | "ppt_master_naver_ir";

export interface PresentationThemeSnapshotV2 {
  theme_id: string;
  version: number;
  name: string;
  background: string;
  foreground: string;
  muted: string;
  accent: string;
  accent_secondary: string;
  layout: PresentationThemeLayoutV2;
}

export interface PresentationTemplateInputV2 {
  name: string;
  background: string;
  foreground: string;
  muted: string;
  accent: string;
  accent_secondary: string;
  layout: PresentationThemeLayoutV2;
  source: { kind: "created" | "image" | "pptx"; label: string | null };
}

export interface PresentationTemplateRecordV2 {
  template_id: string;
  template: {
    schema_version: 1;
    theme: PresentationThemeSnapshotV2;
    source: PresentationTemplateInputV2["source"];
  };
  template_hash: string;
  state: "active" | "deleted";
  updated_at: string;
}

export interface PresentationTemplatePageV2 {
  items: PresentationTemplateRecordV2[];
  next: CatalogCursorV2 | null;
}

export interface VaultNoteMetadataV2 {
  relative_path: string;
  byte_count: number;
  modified_unix_ms: number;
}

export interface VaultNotePageV2 {
  configured: boolean;
  items: VaultNoteMetadataV2[];
  total: number;
  page: PageInfo;
}

export interface VaultSearchHitV2 {
  relative_path: string;
  excerpt: string;
  sha256: string;
}

export interface VaultNotePreviewV2 {
  relative_path: string;
  content: string;
  sha256: string;
  byte_count: number;
  output_is_untrusted: true;
}

export interface VaultChangeEventV2 {
  type: "vault.ready" | "vault.changed" | "vault.unavailable";
  data: {
    file_count?: number;
    changed_count?: number;
    added?: string[];
    modified?: string[];
    removed?: string[];
    paths_truncated?: boolean;
    detail?: string;
  };
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
  skills?: Array<{ skill_id: string; manifest_hash: string; name: string }>;
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
  relative_path: string | null;
  line_number: number | null;
  text: string;
  details?: string;
  completed: boolean;
  fields: Record<string, string | null>;
  block_id: string | null;
  locator_hash: string | null;
  origin?: "vault" | "user" | "model";
  editable?: boolean;
  updated_at?: string | null;
  deleted_at?: string | null;
}

export interface LocalTodoInput {
  title: string;
  details: string;
  priority: string | null;
  due_at: string | null;
  completed: boolean;
  origin?: "user" | "model";
}

export interface LocalTodoRecord {
  task_id: string;
  title: string;
  details: string;
  priority: string | null;
  due_at: string | null;
  status: "open" | "completed";
  origin: "user" | "model";
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface DeletedTodoPage {
  tasks: MarkdownTask[];
  page: PageInfo;
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
  stars_total?: number | null;
  stars_daily?: number | null;
  stars_weekly?: number | null;
  published_at: string | null;
  state: string;
  data_class: string;
  created_at?: string;
  updated_at?: string;
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
    primary_source_ratio: number | null;
    citation_correctness: number | null;
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
  note_preview?: {
    action: "create" | "append" | "no_change";
    relative_path: string;
    expected_hash: string | null;
    markdown: string;
    markdown_hash: string;
  } | null;
  sensitivity: string;
  created_at: string;
  validation: { status: "validated"; mechanism: string };
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
  workspace_root?: string;
  workspace_grant_id?: string;
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
  validation: { status: "validated"; mechanism: string };
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
    validation: { status: "validated"; mechanism: string };
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

export interface RadarConfigurationInput {
  enabled: boolean;
  github_discovery: boolean;
  hacker_news: boolean;
}

export interface RadarConfiguration {
  enabled: boolean;
  github_discovery: boolean;
  hacker_news: boolean;
}

export interface PendingRunSummary {
  suggestion_id: string;
  run_id: string;
  mode: Mode;
  summary: string;
  data_class: string;
  expires_at: string;
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

export interface MailMessageHeader {
  subject: string;
  sender: string;
  date_received: string;
}

export interface MailSnapshot {
  configured: boolean;
  status: DailyStatus;
  provider: string;
  unread_count: number | null;
  observed_at: string | null;
  message: string;
  messages?: MailMessageHeader[];
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
    startup_page?: "start" | "dashboard";
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
  kind?: "session" | "vault" | "task" | "memory" | "radar";
  reference?: string;
  title?: string;
  score?: number;
  session_id?: string;
  message_id?: string;
  sequence?: number;
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
  builtin?: boolean;
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
  deleted_at?: string | null;
}

export interface ExtensionInstallPreviewV2 {
  state: "review_required";
  installation_started: false;
  preview_digest: string;
  preview: Record<string, unknown>;
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

export interface AiReportDraftInputV2 {
  report_id: string;
  revision: number;
  kind: "daily" | "weekly";
  title: string;
  language: string;
  timezone: string;
  provider_profile_id: string;
  focus?: string;
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

export interface DeckDraftInputV2 {
  deck_id: string;
  revision: number;
  title: string;
  report: { report_id: string; report_revision: number } | null;
  brief: string;
  /** Absent lets Core derive the length from the brief. */
  slide_count?: number;
  theme_id: string;
  provider_profile_id: string;
  skill_id?: string;
  language: string;
  audience: {
    audience_id: string;
    purpose: string;
    expertise: string;
  };
}

export type ScheduleRecurrenceV2 =
  | { kind: "one_shot"; at: string }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday_monday_zero: number; hour: number; minute: number }
  | { kind: "every_n_days"; interval_days: number; anchor: string; hour: number; minute: number };

export type ScheduleJobV2 =
  | {
      kind: "deterministic";
      job: "health.check" | "daily.refresh";
    }
  | {
      kind: "model_draft";
      provider_profile_id: string;
      report_kind: "daily_report" | "weekly_report";
      title: string;
      language: string;
      focus: string;
      network_access_confirmed: boolean;
    };

export interface ScheduleCreateInputV2 {
  name: string;
  timezone: string;
  recurrence: ScheduleRecurrenceV2;
  missed_run_policy: "skip" | "create_draft";
  job: ScheduleJobV2;
}

export interface ScheduleSpecV2 extends ScheduleCreateInputV2 {
  schedule_id?: string;
}

/** Transitional read shape for local catalogs created before schedules had names. */
export interface ScheduleUpdateSpecV2 extends ScheduleCreateInputV2 {
  schedule_id: string;
}

export type StoredScheduleSpecV2 = Omit<ScheduleUpdateSpecV2, "schedule_id" | "name" | "missed_run_policy">
  & Partial<Pick<ScheduleUpdateSpecV2, "schedule_id" | "name" | "missed_run_policy">>;

export interface ScheduleRecordV2 {
  schedule_id: string;
  schedule: StoredScheduleSpecV2;
  revision: number;
  state: "active" | "paused";
  next_run_at: string | null;
  updated_at: string;
  deleted_at?: string | null;
}

export interface SchedulePageV2 {
  items: ScheduleRecordV2[];
  page: PageInfo;
}

export interface ScheduleRunV2 {
  schedule_id: string;
  period_key: string;
  run_id: string | null;
  result: Record<string, unknown>;
  created_at: string;
  replayed: boolean;
}

export interface ScheduleRunPageV2 {
  items: ScheduleRunV2[];
  page: PageInfo;
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

export type XSearchStatusV2 = "ready" | "not_installed" | "login_required";
export interface AvailableToolsV2 {
  tools: string[];
  web_search_supported: boolean;
  web_search_backend: "provider" | "grok_cli" | "unavailable";
  x_search_supported: boolean;
  x_search_status: XSearchStatusV2;
}

export type ProviderKindV2 =
  | "deepseek"
  | "openai"
  | "anthropic"
  | "minimax"
  | "mimo"
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
  protocol: "open_ai_chat_completions" | "anthropic_messages" | "ollama_chat";
  default_base_url: string;
  default_model?: string;
  recommended_models?: string[];
  endpoint_policy: "exact_official" | "public_https" | "loopback_only";
  auth_kind: "none" | "bearer" | "api_key_header";
  model_discovery: "open_ai_models" | "anthropic_models" | "ollama_tags" | "manual_only";
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
  setup_command: string;
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
  presentationTemplates?: PresentationTemplateRecordV2[];
  presentationTemplateNext?: CatalogCursorV2 | null;
  schedules: CatalogRecordV2[];
  providers?: ProviderProfileRecordV2[];
  providerRegistry?: ProviderRegistryV2;
  profiles?: ConfigurationProfileRecordV2[];
  prompts?: PromptRevisionRecordV2[];
}

/**
 * Why a domain has no data.
 *
 * `.catch(() => [])` cannot express this distinction, so a 500 from Core and an
 * empty install rendered identically and the user could not tell a broken
 * backend from a fresh one.
 *
 * - `ready`          Core answered. `data` is authoritative, empty or not.
 * - `not_configured` This Core does not serve the domain, or the feature is off.
 * - `unavailable`    Core should serve it and did not. Something is wrong.
 * - `forbidden`      The session lacks the scope.
 */
export type DomainState = "ready" | "not_configured" | "unavailable" | "forbidden";

export interface DomainStatus {
  state: DomainState;
  /** Core's own `detail`, when it supplied one. Never a synthesised string. */
  detail?: string;
  /** Present for an HTTP failure; absent for a transport failure. */
  status?: number;
}

/** Every domain in `DashboardSnapshot`, keyed for the UI to consult. */
export type DomainKey =
  | "runs"
  | "approvals"
  | "tasks"
  | "radar"
  | "memory"
  | "daily"
  | "provider"
  | "sessions"
  | "extensions"
  | "deliverables"
  | "schedules"
  | "providerProfiles"
  | "profiles"
  | "settings"
  | "prompts";

export type DomainStatuses = Partial<Record<DomainKey, DomainStatus>>;

export interface DashboardSnapshot {
  runs: RunListEntry[];
  approvals: ApprovalRequest[];
  taskBoard: {
    configured: boolean;
    vault_configured?: boolean;
    tasks: MarkdownTask[];
    deleted_tasks?: MarkdownTask[];
    deleted_page?: PageInfo;
  };
  radar: { configured: boolean; items: RadarItem[] };
  memory: {
    records: MemoryRecord[];
    counts: Record<string, number>;
    architecture: string[];
  } | null;
  daily: DailySnapshot | null;
  provider: ProviderDiagnostic | null;
  firstRun?: { has_completed_run: boolean };
  pendingRunSummaries?: PendingRunSummary[];
  musicSources?: MusicSourceDefinition[];
  pagination?: Partial<Record<DashboardListKind, PageInfo>>;
  workspaceV2?: RustWorkspaceSnapshot;
  /** Absent means "not measured", which the UI treats as `ready`. */
  domains?: DomainStatuses;
}

export type DashboardListPage =
  | { kind: "runs"; items: RunListEntry[]; page: PageInfo }
  | { kind: "approvals"; items: ApprovalRequest[]; page: PageInfo }
  | { kind: "tasks"; items: MarkdownTask[]; page: PageInfo; configured: boolean; vault_configured?: boolean }
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
  listVaultNotes?(cursor?: string): Promise<VaultNotePageV2>;
  searchVaultNotes?(query: string): Promise<VaultSearchHitV2[]>;
  readVaultNote?(relativePath: string): Promise<VaultNotePreviewV2>;
  streamVaultEvents?(
    onEvent: (event: VaultChangeEventV2) => void,
    signal: AbortSignal,
  ): Promise<void>;
  createRun(
    mode: Mode,
    goal: string,
    dataClass?: WorkDataClass,
    providerProfileId?: string,
    skillIds?: string[],
    allowedTools?: string[],
    reasoningEffort?: ReasoningEffortV2,
  ): Promise<RunSummary>;
  listAvailableTools?(
    providerProfileId: string,
  ): Promise<AvailableToolsV2>;
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
  configureRadar(input: RadarConfigurationInput): Promise<RadarConfiguration>;
  cancelRun(runId: string): Promise<void>;
  retryRun?(runId: string): Promise<void>;
  loadRunSummary?(runId: string): Promise<PendingRunSummary | null>;
  acceptRunSummary?(runId: string): Promise<MemoryRecord>;
  dismissRunSummary?(runId: string): Promise<void>;
  previewTask(taskId: string, completed: boolean): Promise<TaskMutationPreview>;
  captureTask(text: string, priority: string): Promise<TaskMutationPreview>;
  createLocalTodo?(input: LocalTodoInput): Promise<LocalTodoRecord>;
  updateLocalTodo?(
    taskId: string,
    input: LocalTodoInput & { expected_updated_at: string },
  ): Promise<LocalTodoRecord>;
  deleteLocalTodo?(taskId: string, expectedUpdatedAt: string): Promise<void>;
  restoreLocalTodo?(taskId: string, expectedUpdatedAt: string): Promise<LocalTodoRecord>;
  loadDeletedTodos?(cursor?: string): Promise<DeletedTodoPage>;
  applyTask(approvalId: string): Promise<TaskApplyResult>;
  previewResearchNote(runId: string): Promise<TaskMutationPreview>;
  previewStudyNote(runId: string): Promise<TaskMutationPreview>;
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
  previewExtensionInstall?(
    packageKind: "skill" | "mcp" | "plugin",
    manifest: Record<string, unknown>,
  ): Promise<ExtensionInstallPreviewV2>;
  installExtension?(
    packageKind: "skill" | "mcp" | "plugin",
    manifest: Record<string, unknown>,
    approvedPreviewDigest: string,
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
  composeAiReportDraft?(input: AiReportDraftInputV2): Promise<CatalogRecordV2>;
  composeDeckFromReport?(input: DeckFromReportInputV2): Promise<CatalogRecordV2>;
  composeDeckDraft?(input: DeckDraftInputV2): Promise<CatalogRecordV2>;
  createPresentationTemplate?(input: PresentationTemplateInputV2): Promise<PresentationTemplateRecordV2>;
  updatePresentationTemplate?(
    templateId: string,
    expectedHash: string,
    input: PresentationTemplateInputV2,
  ): Promise<PresentationTemplateRecordV2>;
  listPresentationTemplates?(cursor?: CatalogCursorV2): Promise<PresentationTemplatePageV2>;
  listDeletedPresentationTemplates?(cursor?: CatalogCursorV2): Promise<PresentationTemplatePageV2>;
  deletePresentationTemplate?(templateId: string, expectedHash: string): Promise<PresentationTemplateRecordV2>;
  restorePresentationTemplate?(templateId: string, expectedHash: string): Promise<PresentationTemplateRecordV2>;
  createSchedule?(schedule: ScheduleSpecV2): Promise<CatalogRecordV2>;
  updateSchedule?(
    scheduleId: string,
    expectedRevision: number,
    schedule: ScheduleUpdateSpecV2,
  ): Promise<ScheduleRecordV2>;
  listSchedules?(cursor?: string): Promise<SchedulePageV2>;
  listDeletedSchedules?(cursor?: string): Promise<SchedulePageV2>;
  listScheduleRuns?(scheduleId: string, cursor?: string): Promise<ScheduleRunPageV2>;
  restoreSchedule?(scheduleId: string, expectedRevision: number): Promise<ScheduleRecordV2>;
  changeScheduleState?(
    scheduleId: string,
    action: "pause" | "resume",
    expectedRevision: number,
  ): Promise<CatalogRecordV2>;
  runScheduleNow?(scheduleId: string): Promise<ScheduleRunV2>;
  deleteSchedule?(scheduleId: string, expectedRevision: number): Promise<void>;
}
