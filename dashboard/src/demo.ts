import { mountDashboard } from "./main";
import type {
  ApprovalRequest,
  DashboardApi,
  DashboardSnapshot,
  Mode,
  RunSummary,
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
  async decideApproval(
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<ApprovalRequest> {
    return { ...approval, approval_id: approvalId, decision: decision === "approve" ? "approved" : "denied" };
  }
  async radarAction(): Promise<void> {}
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
