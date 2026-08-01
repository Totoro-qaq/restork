export type Mode = "research" | "study" | "work";

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
}

export interface RunEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

export interface DashboardApi {
  pair(code: string): Promise<void>;
  loadDashboard(): Promise<DashboardSnapshot>;
  createRun(mode: Mode, goal: string): Promise<RunSummary>;
  decideApproval(
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<ApprovalRequest>;
  radarAction(itemId: string, action: RadarAction): Promise<void>;
  previewTask(taskId: string, completed: boolean): Promise<TaskMutationPreview>;
  captureTask(text: string, priority: string): Promise<TaskMutationPreview>;
  applyTask(approvalId: string): Promise<TaskApplyResult>;
  musicCover(): Promise<Blob | null>;
  events(runId: string, after: number): Promise<RunEvent[]>;
}
