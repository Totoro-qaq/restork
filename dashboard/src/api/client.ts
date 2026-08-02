import { EventCursor, EventStreamDecoder } from "./events";
import type {
  ApprovalRequest,
  DashboardApi,
  DashboardSnapshot,
  Mode,
  RadarAction,
  RadarActionResult,
  PracticeAttemptResult,
  ProviderDiagnostic,
  RunEvent,
  RunSummary,
  StudyArtifact,
  StudyDiagnostic,
  TaskApplyResult,
  TaskMutationPreview,
  WorkDataClass,
  WorkExportResult,
  WorkHandoffPreview,
  WorkPlanArtifact,
  WorkResultManifest,
  WorkStartInput,
  WorkVerificationReport,
  WeatherConfigurationInput,
  MemoryRecord,
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
    const [runs, approvals, taskBoard, radar, memory, daily, provider] = await Promise.all([
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
      this.#request<ProviderDiagnostic>("GET", "/v1/providers/deepseek").catch(
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
      provider,
    };
  }

  async createRun(
    mode: Mode,
    goal: string,
    dataClass: WorkDataClass = "public",
  ): Promise<RunSummary> {
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
          maximum_outbound_class: dataClass,
          allow_private_previews: dataClass !== "public",
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

  async prepareStudy(
    runId: string,
    objective: string,
    targetNote: string | null,
  ): Promise<StudyDiagnostic> {
    return this.#request<StudyDiagnostic>(
      "POST",
      `/v1/study/runs/${encodeURIComponent(runId)}/diagnostic`,
      { objective, target_note: targetNote },
    );
  }

  async submitStudyDiagnostic(
    runId: string,
    answers: Record<string, string>,
  ): Promise<StudyArtifact> {
    return this.#request<StudyArtifact>(
      "POST",
      `/v1/study/runs/${encodeURIComponent(runId)}/path`,
      { answers },
    );
  }

  async submitStudyPractice(
    runId: string,
    exerciseId: string,
    answer: string,
    confidence: number,
  ): Promise<PracticeAttemptResult> {
    return this.#request<PracticeAttemptResult>(
      "POST",
      (
        `/v1/study/runs/${encodeURIComponent(runId)}/exercises/`
        + `${encodeURIComponent(exerciseId)}/attempt`
      ),
      { answer, confidence },
      true,
      `dashboard-study-attempt-${crypto.randomUUID()}`,
    );
  }

  async planWork(runId: string, input: WorkStartInput): Promise<WorkPlanArtifact> {
    return this.#request<WorkPlanArtifact>(
      "POST",
      `/v1/work/runs/${encodeURIComponent(runId)}/plan`,
      input,
    );
  }

  async previewWorkHandoff(runId: string): Promise<WorkHandoffPreview> {
    return this.#request<WorkHandoffPreview>(
      "POST",
      `/v1/work/runs/${encodeURIComponent(runId)}/handoff/preview`,
      {},
      true,
      `dashboard-work-preview-${crypto.randomUUID()}`,
    );
  }

  async exportWorkHandoff(
    runId: string,
    approvalId: string,
  ): Promise<WorkExportResult> {
    return this.#request<WorkExportResult>(
      "POST",
      `/v1/work/runs/${encodeURIComponent(runId)}/handoff/export`,
      { approval_id: approvalId },
      true,
      `dashboard-work-export-${crypto.randomUUID()}`,
    );
  }

  async verifyWorkResult(
    runId: string,
    manifest: WorkResultManifest,
  ): Promise<WorkVerificationReport> {
    return this.#request<WorkVerificationReport>(
      "POST",
      `/v1/work/runs/${encodeURIComponent(runId)}/verify`,
      manifest,
      true,
      `dashboard-work-verify-${crypto.randomUUID()}`,
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

  async configureWeather(input: WeatherConfigurationInput): Promise<void> {
    const profile = await this.#request<{ records: MemoryRecord[] }>(
      "GET",
      "/v1/memory?layer=profile",
    );
    const provider = requiredProfileRecord(profile.records, "profile:daily.weather_provider");
    const location = requiredProfileRecord(profile.records, "profile:daily.weather_location");

    const disabledProvider = await this.#correctProfile(
      provider.memory_id,
      "",
      provider.content_hash,
    );
    const locationValue = input.enabled
      ? `${input.label.trim()}|${input.latitude},${input.longitude}`
      : "";
    await this.#correctProfile(location.memory_id, locationValue, location.content_hash);
    if (input.enabled) {
      await this.#correctProfile(
        provider.memory_id,
        "open-meteo",
        disabledProvider.content_hash,
      );
    }
  }

  async providerDiagnostics(smoke: boolean): Promise<ProviderDiagnostic> {
    return this.#request<ProviderDiagnostic>(
      "POST",
      "/v1/providers/deepseek/diagnostics",
      { smoke },
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

  async streamEvents(
    runId: string,
    after: number,
    onEvent: (event: RunEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const cursor = this.#eventCursors.get(runId) ?? new EventCursor();
    this.#eventCursors.set(runId, cursor);
    let terminal = false;
    while (!signal.aborted && !terminal) {
      const response = await this.#fetch(
        `/v1/runs/${encodeURIComponent(runId)}/events?follow=true`,
        {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            "Last-Event-ID": String(Math.max(after, cursor.cursor)),
          },
          signal,
        },
        true,
      );
      if (!response.ok) throw await apiError(response);
      if (!response.body) throw new Error("Core returned an unreadable event stream");
      const reader = response.body.getReader();
      const utf8 = new TextDecoder();
      const stream = new EventStreamDecoder();
      const deliver = (events: RunEvent[]): void => {
        for (const event of cursor.acceptEvents(events)) {
          onEvent(event);
          if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) {
            terminal = true;
          }
        }
      };
      while (!signal.aborted && !terminal) {
        const { done, value } = await reader.read();
        if (done) break;
        deliver(stream.push(utf8.decode(value, { stream: true })));
      }
      deliver(stream.push(utf8.decode()));
      deliver(stream.finish());
      if (!signal.aborted && !terminal) await abortableDelay(750, signal);
    }
  }

  async #correctProfile(
    memoryId: string,
    value: string,
    expectedContentHash: string,
  ): Promise<MemoryRecord> {
    return this.#request<MemoryRecord>(
      "PATCH",
      `/v1/memory/${encodeURIComponent(memoryId)}`,
      {
        value,
        expected_content_hash: expectedContentHash,
        data_class: "personal",
      },
      true,
      `dashboard-profile-${crypto.randomUUID()}`,
    );
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

function requiredProfileRecord(records: MemoryRecord[], memoryId: string): MemoryRecord {
  const record = records.find((candidate) => candidate.memory_id === memoryId);
  if (!record) throw new Error("Core did not expose the required private Profile metadata");
  return record;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
