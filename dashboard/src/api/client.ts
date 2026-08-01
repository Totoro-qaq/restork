import { EventCursor } from "./events";
import type {
  ApprovalRequest,
  DashboardApi,
  DashboardSnapshot,
  Mode,
  RadarAction,
  RadarActionResult,
  RunEvent,
  RunSummary,
  TaskApplyResult,
  TaskMutationPreview,
} from "./types";

export class LocalApiClient implements DashboardApi {
  #token: string | null = null;
  readonly #eventCursors = new Map<string, EventCursor>();

  async pair(code: string): Promise<void> {
    const response = await this.#request<{ access_token: string }>("POST", "/v1/pair", {
      code,
    }, false);
    this.#token = response.access_token;
  }

  async loadDashboard(): Promise<DashboardSnapshot> {
    const [runs, approvals, taskBoard, radar, memory, daily] = await Promise.all([
      this.#request<{ runs: DashboardSnapshot["runs"] }>("GET", "/v1/runs"),
      this.#request<{ approvals: DashboardSnapshot["approvals"] }>(
        "GET",
        "/v1/approvals?pending_only=false",
      ),
      this.#request<DashboardSnapshot["taskBoard"]>("GET", "/v1/tasks"),
      this.#request<DashboardSnapshot["radar"]>("GET", "/v1/radar"),
      this.#request<NonNullable<DashboardSnapshot["memory"]>>("GET", "/v1/memory").catch(
        () => null,
      ),
      this.#request<NonNullable<DashboardSnapshot["daily"]>>("GET", "/v1/daily").catch(
        () => null,
      ),
    ]);
    return {
      runs: runs.runs,
      approvals: approvals.approvals,
      taskBoard,
      radar,
      memory,
      daily,
    };
  }

  async createRun(mode: Mode, goal: string): Promise<RunSummary> {
    const identity = crypto.randomUUID();
    const tools = mode === "research"
      ? ["vault_search", "source_read"]
      : mode === "study"
        ? ["vault_search", "practice"]
        : ["vault_search", "handoff_export"];
    return this.#request<RunSummary>(
      "POST",
      "/v1/runs",
      {
        schema_version: 1,
        task_id: `dashboard-${identity}`,
        parent_task_id: null,
        mode,
        goal,
        workspace_scope: "dashboard",
        constraints: [],
        completion_criteria: ["produce a reviewable verified artifact"],
        data_policy: {
          schema_version: 1,
          maximum_outbound_class: "public",
          allow_private_previews: false,
        },
        tool_policy: {
          schema_version: 1,
          allowed_tools: tools,
          require_approval_for_writes: true,
          require_approval_for_external_actions: true,
        },
        budgets: {
          schema_version: 1,
          max_steps: 12,
          max_wall_time_seconds: 3600,
          max_tokens: 120000,
          max_cost_usd: null,
          max_retries: 2,
          max_child_tasks: 1,
          reasoning_effort: "high",
        },
        created_at: new Date().toISOString(),
      },
      true,
      `dashboard-create-${identity}`,
    );
  }

  async decideApproval(
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<ApprovalRequest> {
    return this.#request<ApprovalRequest>(
      "POST",
      `/v1/approvals/${encodeURIComponent(approvalId)}`,
      { decision, decided_by: "local-dashboard" },
      true,
      `dashboard-approval-${crypto.randomUUID()}`,
    );
  }

  async radarAction(itemId: string, action: RadarAction): Promise<RadarActionResult> {
    return this.#request<RadarActionResult>(
      "POST",
      `/v1/radar/${encodeURIComponent(itemId)}/action`,
      { action },
      true,
      `dashboard-radar-${crypto.randomUUID()}`,
    );
  }

  async previewTask(taskId: string, completed: boolean): Promise<TaskMutationPreview> {
    return this.#request<TaskMutationPreview>(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/preview`,
      { completed },
      true,
      `dashboard-task-preview-${crypto.randomUUID()}`,
    );
  }

  async captureTask(text: string, priority: string): Promise<TaskMutationPreview> {
    return this.#request<TaskMutationPreview>(
      "POST",
      "/v1/tasks/quick-capture/preview",
      { text, priority: priority || null },
      true,
      `dashboard-task-capture-${crypto.randomUUID()}`,
    );
  }

  async applyTask(approvalId: string): Promise<TaskApplyResult> {
    return this.#request<TaskApplyResult>(
      "POST",
      `/v1/tasks/approvals/${encodeURIComponent(approvalId)}/apply`,
      {},
      true,
      `dashboard-task-apply-${crypto.randomUUID()}`,
    );
  }

  async musicCover(): Promise<Blob | null> {
    const response = await this.#fetch(
      "/v1/daily/music/cover",
      { method: "GET", headers: { Accept: "image/png,image/jpeg,image/webp" } },
      true,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await apiError(response);
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
      throw new Error("Core returned an unsupported cover type");
    }
    return response.blob();
  }

  async events(runId: string, after: number): Promise<RunEvent[]> {
    const cursor = this.#eventCursors.get(runId) ?? new EventCursor();
    this.#eventCursors.set(runId, cursor);
    const response = await this.#fetch(
      `/v1/runs/${encodeURIComponent(runId)}/events`,
      {
        method: "GET",
        headers: { Accept: "text/event-stream", "Last-Event-ID": String(Math.max(after, cursor.cursor)) },
      },
      true,
    );
    if (!response.ok) throw await apiError(response);
    return cursor.accept(await response.text());
  }

  async #request<T>(
    method: string,
    path: string,
    body?: object,
    authenticated = true,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await this.#fetch(
      path,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      authenticated,
    );
    if (!response.ok) throw await apiError(response);
    return (await response.json()) as T;
  }

  #fetch(path: string, init: RequestInit, authenticated: boolean): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authenticated) {
      if (!this.#token) throw new Error("Pair this browser with Restork Core first");
      headers.set("Authorization", `Bearer ${this.#token}`);
    }
    return fetch(path, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  }
}

async function apiError(response: Response): Promise<Error> {
  let detail = `Core returned HTTP ${response.status}`;
  try {
    const payload = (await response.json()) as { detail?: unknown };
    if (typeof payload.detail === "string") detail = payload.detail;
  } catch {
    // Do not include arbitrary response bodies in the error surface.
  }
  return new Error(detail);
}
