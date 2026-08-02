import { EventCursor, EventStreamDecoder } from "./events";
import type {
  ApprovalRequest,
  DashboardApi,
  DashboardListKind,
  DashboardListPage,
  DashboardSnapshot,
  Mode,
  RadarAction,
  RadarActionResult,
  PracticeAttemptResult,
  ProviderDiagnostic,
  RunEvent,
  RunEventPage,
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
  CalendarConfigurationInput,
  ConversationPage,
  ConversationTurn,
  WeatherConfigurationInput,
  WeatherConfigurationResult,
} from "./types";

export interface LocalSession {
  accessToken: string;
  expiresAt: string;
}

interface LocalApiClientOptions {
  onSession?: (session: LocalSession) => Promise<void>;
}

export class LocalApiClient implements DashboardApi {
  #token: string | null = null;
  #expiresAt = 0;
  #rotationTimer: number | null = null;
  #rotationPromise: Promise<void> | null = null;
  readonly #onSession: ((session: LocalSession) => Promise<void>) | undefined;
  readonly #eventCursors = new Map<string, EventCursor>();

  constructor(options: LocalApiClientOptions = {}) {
    this.#onSession = options.onSession;
  }

  async pair(code: string): Promise<void> {
    const response = await this.#request<{ access_token: string; expires_at?: string }>(
      "POST",
      "/v1/pair",
      { code },
      false,
    );
    await this.#acceptSession(response.access_token, response.expires_at);
  }

  restoreSession(session: LocalSession): void {
    const normalized = normalizeSession(session.accessToken, session.expiresAt);
    this.#token = normalized.accessToken;
    this.#expiresAt = Date.parse(normalized.expiresAt);
    this.#scheduleRotation();
  }

  async loadDashboard(): Promise<DashboardSnapshot> {
    const [runs, approvals, taskBoard, radar, memory, daily, provider] = await Promise.all([
      this.#request<{ runs: DashboardSnapshot["runs"]; page: NonNullable<DashboardSnapshot["pagination"]>["runs"] }>("GET", "/v1/runs?limit=12"),
      this.#request<{ approvals: DashboardSnapshot["approvals"]; page: NonNullable<DashboardSnapshot["pagination"]>["approvals"] }>(
        "GET",
        "/v1/approvals?pending_only=false&limit=12",
      ),
      this.#request<DashboardSnapshot["taskBoard"] & { page: NonNullable<DashboardSnapshot["pagination"]>["tasks"] }>("GET", "/v1/tasks?limit=12"),
      this.#request<DashboardSnapshot["radar"] & { page: NonNullable<DashboardSnapshot["pagination"]>["radar"] }>("GET", "/v1/radar?limit=12"),
      this.#request<NonNullable<DashboardSnapshot["memory"]> & { page: NonNullable<DashboardSnapshot["pagination"]>["memory"] }>("GET", "/v1/memory?limit=12").catch(
        () => null,
      ),
      this.#request<NonNullable<DashboardSnapshot["daily"]>>(
        "GET",
        `/v1/daily?timezone=${encodeURIComponent(systemTimeZone())}`,
      ).catch(() => null),
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
      pagination: {
        runs: runs.page,
        approvals: approvals.page,
        tasks: taskBoard.page,
        radar: radar.page,
        memory: memory?.page,
      },
    };
  }

  async loadPage(kind: DashboardListKind, cursor: string): Promise<DashboardListPage> {
    const encoded = encodeURIComponent(cursor);
    if (kind === "runs") {
      const payload = await this.#request<{ runs: DashboardSnapshot["runs"]; page: DashboardListPage["page"] }>("GET", `/v1/runs?limit=12&cursor=${encoded}`);
      return { kind, items: payload.runs, page: payload.page };
    }
    if (kind === "approvals") {
      const payload = await this.#request<{ approvals: DashboardSnapshot["approvals"]; page: DashboardListPage["page"] }>("GET", `/v1/approvals?pending_only=false&limit=12&cursor=${encoded}`);
      return { kind, items: payload.approvals, page: payload.page };
    }
    if (kind === "tasks") {
      const payload = await this.#request<DashboardSnapshot["taskBoard"] & { page: DashboardListPage["page"] }>("GET", `/v1/tasks?limit=12&cursor=${encoded}`);
      return { kind, items: payload.tasks, page: payload.page, configured: payload.configured };
    }
    if (kind === "radar") {
      const payload = await this.#request<DashboardSnapshot["radar"] & { page: DashboardListPage["page"] }>("GET", `/v1/radar?limit=12&cursor=${encoded}`);
      return { kind, items: payload.items, page: payload.page, configured: payload.configured };
    }
    const payload = await this.#request<NonNullable<DashboardSnapshot["memory"]> & { page: DashboardListPage["page"] }>("GET", `/v1/memory?limit=12&cursor=${encoded}`);
    return {
      kind,
      items: payload.records,
      page: payload.page,
      counts: payload.counts,
      architecture: payload.architecture,
    };
  }

  async eventPage(runId: string, before?: string): Promise<RunEventPage> {
    const cursor = before ? `&before=${encodeURIComponent(before)}` : "";
    return this.#request<RunEventPage>(
      "GET",
      `/v1/runs/${encodeURIComponent(runId)}/event-page?limit=50${cursor}`,
    );
  }

  async conversationPage(runId: string, before?: string): Promise<ConversationPage> {
    const cursor = before ? `&before=${encodeURIComponent(before)}` : "";
    return this.#request<ConversationPage>(
      "GET",
      `/v1/runs/${encodeURIComponent(runId)}/conversation?limit=24${cursor}`,
    );
  }

  async sendConversation(runId: string, content: string): Promise<ConversationTurn> {
    return this.#request<ConversationTurn>(
      "POST",
      `/v1/runs/${encodeURIComponent(runId)}/conversation`,
      { content },
      true,
      `dashboard-conversation-${crypto.randomUUID()}`,
    );
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

  async configureWeather(
    input: WeatherConfigurationInput,
  ): Promise<WeatherConfigurationResult> {
    return this.#request<WeatherConfigurationResult>(
      "POST",
      "/v1/daily/weather",
      input,
      true,
      `dashboard-weather-${crypto.randomUUID()}`,
    );
  }

  async configureCalendar(
    input: CalendarConfigurationInput,
  ): Promise<NonNullable<DashboardSnapshot["daily"]>["calendar"]> {
    return this.#request<NonNullable<DashboardSnapshot["daily"]>["calendar"]>(
      "POST",
      "/v1/daily/calendar",
      input,
      true,
      `dashboard-calendar-${crypto.randomUUID()}`,
    );
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

  async #fetch(path: string, init: RequestInit, authenticated: boolean): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authenticated) {
      if (!this.#token) throw new Error("Pair this browser with Restork Core first");
      if (this.#expiresAt <= Date.now() + 120_000) await this.#rotateSession();
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

  async #acceptSession(accessToken: string, expiresAt?: string): Promise<void> {
    const normalized = normalizeSession(
      accessToken,
      expiresAt ?? new Date(Date.now() + 240_000).toISOString(),
    );
    this.#token = normalized.accessToken;
    this.#expiresAt = Date.parse(normalized.expiresAt);
    if (this.#onSession) await this.#onSession(normalized);
    this.#scheduleRotation();
  }

  #rotateSession(): Promise<void> {
    if (this.#rotationPromise) return this.#rotationPromise;
    const token = this.#token;
    if (!token) return Promise.reject(new Error("Pair this browser with Restork Core first"));
    this.#rotationPromise = fetch("/v1/token/rotate", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    })
      .then(async (response) => {
        if (!response.ok) throw await apiError(response);
        const payload = (await response.json()) as {
          access_token?: unknown;
          expires_at?: unknown;
        };
        if (typeof payload.access_token !== "string" || typeof payload.expires_at !== "string") {
          throw new Error("Core returned an invalid token rotation response");
        }
        await this.#acceptSession(payload.access_token, payload.expires_at);
      })
      .finally(() => {
        this.#rotationPromise = null;
      });
    return this.#rotationPromise;
  }

  #scheduleRotation(): void {
    if (this.#rotationTimer !== null) window.clearTimeout(this.#rotationTimer);
    const delay = Math.max(1_000, Math.min(2_147_000_000, this.#expiresAt - Date.now() - 120_000));
    this.#rotationTimer = window.setTimeout(() => {
      this.#rotationTimer = null;
      void this.#rotateSession().catch(() => {
        if (this.#expiresAt > Date.now() + 15_000) {
          this.#rotationTimer = window.setTimeout(() => {
            this.#rotationTimer = null;
            void this.#rotateSession().catch(() => undefined);
          }, 15_000);
        }
      });
    }, delay);
  }
}

function normalizeSession(accessToken: string, expiresAt: string): LocalSession {
  const expiry = Date.parse(expiresAt);
  if (
    !accessToken
    || accessToken.length > 512
    || /\s/.test(accessToken)
    || !Number.isFinite(expiry)
    || expiry <= Date.now()
  ) {
    throw new Error("Core returned an invalid local session");
  }
  return { accessToken, expiresAt: new Date(expiry).toISOString() };
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

export function systemTimeZone(): string {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timezone && timezone.length <= 128 ? timezone : "UTC";
  } catch {
    return "UTC";
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
