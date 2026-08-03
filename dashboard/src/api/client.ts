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
  MusicConfigurationInput,
  ConversationPage,
  ConversationOperationCreateResultV2,
  ConversationOperationV2,
  ContextPreviewRecordV2,
  ConversationTurn,
  WeatherConfigurationInput,
  WeatherConfigurationResult,
  CatalogRecordV2,
  DailyContextV2,
  PersonalSettingsRecord,
  ProviderProfileRecordV2,
  ProviderRegistryV2,
  ConfigurationProfileRecordV2,
  PromptRevisionRecordV2,
  RunProposalV2,
  SessionMessageV2,
  SessionRecordV2,
  SessionExportV2,
  SessionSearchHitV2,
  ToolSearchResultV2,
  ToolCallPreviewV2,
  ToolExecutionV2,
  RenderDownloadV2,
  RenderPreviewV2,
  ManualReportInputV2,
  DeckFromReportInputV2,
  ScheduleSpecV2,
  ScheduleRunV2,
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
  readonly #operationCursors = new Map<string, EventCursor>();

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
    const emptyPage = { limit: 12, has_more: false, next_cursor: null };
    const [runs, approvals, taskBoard, radar, memory, daily, provider, musicSources] = await Promise.all([
      this.#request<{ runs: DashboardSnapshot["runs"]; page: NonNullable<DashboardSnapshot["pagination"]>["runs"] }>("GET", "/v1/runs?limit=12")
        .catch(() => ({ runs: [], page: emptyPage })),
      this.#request<{ approvals: DashboardSnapshot["approvals"]; page: NonNullable<DashboardSnapshot["pagination"]>["approvals"] }>(
        "GET",
        "/v1/approvals?pending_only=false&limit=12",
      ).catch(() => ({ approvals: [], page: emptyPage })),
      this.#request<DashboardSnapshot["taskBoard"] & { page: NonNullable<DashboardSnapshot["pagination"]>["tasks"] }>("GET", "/v1/tasks?limit=12")
        .catch(() => ({ configured: false, tasks: [], page: emptyPage })),
      this.#request<DashboardSnapshot["radar"] & { page: NonNullable<DashboardSnapshot["pagination"]>["radar"] }>("GET", "/v1/radar?limit=12")
        .catch(() => ({ configured: false, items: [], page: emptyPage })),
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
      this.#request<NonNullable<DashboardSnapshot["musicSources"]>>(
        "GET",
        "/v1/daily/music/sources",
      ).catch(() => []),
    ]);
    const [
      dailyContext,
      personal,
      sessions,
      extensions,
      deliverables,
      schedules,
      providers,
      providerRegistry,
      profiles,
      prompts,
    ] =
      await Promise.all([
        this.#request<DailyContextV2>("GET", "/v1/daily/context").catch(() => null),
        this.#request<PersonalSettingsRecord>("GET", "/v1/settings/personal").catch(
          () => null,
        ),
        this.#request<{ items: SessionRecordV2[] }>("GET", "/v1/sessions?limit=20")
          .then((page) => page.items)
          .catch(() => []),
        this.#request<{ items: CatalogRecordV2[] }>("GET", "/v1/extensions?limit=20")
          .then((page) => page.items)
          .catch(() => []),
        this.#request<{ items: CatalogRecordV2[] }>("GET", "/v1/deliverables?limit=20")
          .then((page) => page.items)
          .catch(() => []),
        this.#request<{ items: CatalogRecordV2[] }>("GET", "/v1/schedules?limit=20")
          .then((page) => page.items)
          .catch(() => []),
        this.#request<{ items: ProviderProfileRecordV2[] }>("GET", "/v1/provider-profiles")
          .then((page) => page.items)
          .catch(() => []),
        this.#request<ProviderRegistryV2>("GET", "/v1/providers").catch(() => null),
        this.#request<{ items: ConfigurationProfileRecordV2[] }>(
          "GET",
          "/v1/configuration-profiles",
        )
          .then((page) => page.items)
          .catch(() => []),
        this.#request<{ items: PromptRevisionRecordV2[] }>("GET", "/v1/prompts/personal")
          .then((page) => page.items)
          .catch(() => []),
      ]);
    const workspaceV2 = dailyContext || personal || sessions.length || extensions.length
      || deliverables.length || schedules.length || providers.length || providerRegistry || profiles.length
      || prompts.length
      ? {
          dailyContext,
          personal,
          sessions,
          extensions,
          deliverables,
          schedules,
          providers,
          providerRegistry: providerRegistry ?? undefined,
          profiles,
          prompts,
        }
      : undefined;
    return {
      runs: runs.runs,
      approvals: approvals.approvals,
      taskBoard,
      radar,
      memory,
      daily,
      provider,
      musicSources,
      pagination: {
        runs: runs.page,
        approvals: approvals.page,
        tasks: taskBoard.page,
        radar: radar.page,
        memory: memory?.page,
      },
      workspaceV2,
    };
  }

  async createSession(title: string, profileId: string): Promise<SessionRecordV2> {
    return this.#request<SessionRecordV2>("POST", "/v1/sessions", {
      title,
      profile_id: profileId,
      locale: document.documentElement.lang || "en",
    });
  }

  async sessionMessages(sessionId: string, after = 0): Promise<SessionMessageV2[]> {
    const page = await this.#request<{ items: SessionMessageV2[] }>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages?after=${after}&limit=100`,
    );
    return page.items;
  }

  async sendSessionMessage(
    sessionId: string,
    content: string,
    dataClass: WorkDataClass = "public",
  ): Promise<SessionMessageV2> {
    return this.#request<SessionMessageV2>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { content, context: {}, data_class: dataClass },
    );
  }

  async createConversationTurn(
    sessionId: string,
    content: string,
    dataClass: WorkDataClass = "public",
    contextPreviewHash: string | null = null,
  ): Promise<ConversationOperationCreateResultV2> {
    return this.#request<ConversationOperationCreateResultV2>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
      {
        content,
        context: {},
        data_class: dataClass,
        context_preview_hash: contextPreviewHash,
      },
      true,
      `dashboard-turn-${crypto.randomUUID()}`,
    );
  }

  async createContextPreview(
    sessionId: string,
    dataClass: WorkDataClass,
    items: Array<{ name: string; content: string }>,
  ): Promise<ContextPreviewRecordV2> {
    return this.#request<ContextPreviewRecordV2>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/context-preview`,
      { data_class: dataClass, items },
    );
  }

  async cancelConversationOperation(operationId: string): Promise<ConversationOperationV2> {
    return this.#request<ConversationOperationV2>(
      "POST",
      `/v1/operations/${encodeURIComponent(operationId)}/cancel`,
      {},
      true,
      `dashboard-cancel-${crypto.randomUUID()}`,
    );
  }

  async streamConversationOperation(
    operationId: string,
    after: number,
    onEvent: (event: RunEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const cursor = this.#operationCursors.get(operationId) ?? new EventCursor();
    this.#operationCursors.set(operationId, cursor);
    let terminal = false;
    while (!signal.aborted && !terminal) {
      const response = await this.#fetch(
        `/v1/operations/${encodeURIComponent(operationId)}/events?follow=true`,
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
      if (!response.body) throw new Error("Core returned an unreadable operation stream");
      const reader = response.body.getReader();
      const utf8 = new TextDecoder();
      const stream = new EventStreamDecoder();
      const deliver = (events: RunEvent[]): void => {
        for (const event of cursor.acceptEvents(events)) {
          onEvent(event);
          if ([
            "conversation.completed",
            "conversation.failed",
            "conversation.cancelled",
          ].includes(event.type)) {
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
      if (!signal.aborted && !terminal) await abortableDelay(500, signal);
    }
  }

  async createSessionProposal(
    sessionId: string,
    mode: Mode,
    goal: string,
    dataClass: WorkDataClass = "public",
  ): Promise<RunProposalV2> {
    return this.#request<RunProposalV2>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/proposals`,
      { mode, goal, data_class: dataClass },
    );
  }

  async savePersonalSettings(
    expectedVersion: number | null,
    settings: PersonalSettingsRecord["settings"],
  ): Promise<PersonalSettingsRecord> {
    return this.#request<PersonalSettingsRecord>("PUT", "/v1/settings/personal", {
      expected_version: expectedVersion,
      settings,
    });
  }

  async saveProviderProfile(
    expectedRevision: number | null,
    provider: ProviderProfileRecordV2["provider"],
  ): Promise<ProviderProfileRecordV2> {
    return this.#request<ProviderProfileRecordV2>(
      "PUT",
      `/v1/provider-profiles/${encodeURIComponent(provider.profile_id)}`,
      { expected_revision: expectedRevision, provider },
    );
  }

  async saveConfigurationProfile(
    expectedRevision: number | null,
    profile: ConfigurationProfileRecordV2["profile"],
  ): Promise<ConfigurationProfileRecordV2> {
    return this.#request<ConfigurationProfileRecordV2>(
      "PUT",
      `/v1/configuration-profiles/${encodeURIComponent(profile.profile_id)}`,
      { expected_revision: expectedRevision, profile },
    );
  }

  async createPromptRevision(
    promptId: string,
    expectedRevision: number | null,
    layer: "skill" | "personal",
    content: string,
  ): Promise<PromptRevisionRecordV2> {
    return this.#request<PromptRevisionRecordV2>(
      "POST",
      `/v1/prompts/${encodeURIComponent(promptId)}`,
      { expected_revision: expectedRevision, layer, content },
    );
  }

  async activatePromptRevision(
    promptId: string,
    revision: number,
    expectedActiveRevision: number | null,
  ): Promise<PromptRevisionRecordV2> {
    return this.#request<PromptRevisionRecordV2>(
      "PATCH",
      `/v1/prompts/${encodeURIComponent(promptId)}/active`,
      { revision, expected_active_revision: expectedActiveRevision },
    );
  }

  async archiveSession(sessionId: string, expectedVersion: number): Promise<SessionRecordV2> {
    return this.#request<SessionRecordV2>(
      "PATCH",
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      { action: "archive", expected_version: expectedVersion },
    );
  }

  async deleteSession(sessionId: string, expectedVersion: number): Promise<void> {
    await this.#requestNoContent(
      "DELETE",
      `/v1/sessions/${encodeURIComponent(sessionId)}?expected_version=${expectedVersion}`,
    );
  }

  async exportSession(sessionId: string): Promise<SessionExportV2> {
    return this.#request<SessionExportV2>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/export`,
    );
  }

  async searchSessions(query: string): Promise<SessionSearchHitV2[]> {
    const result = await this.#request<{ items: SessionSearchHitV2[] }>(
      "GET",
      `/v1/sessions/search?q=${encodeURIComponent(query)}&limit=50`,
    );
    return result.items;
  }

  async installExtension(
    packageKind: "skill" | "mcp" | "plugin",
    manifest: Record<string, unknown>,
  ): Promise<CatalogRecordV2> {
    return this.#request<CatalogRecordV2>("POST", "/v1/extensions", {
      package_kind: packageKind,
      manifest,
    });
  }

  async setExtensionState(
    packageId: string,
    action: "enable" | "disable",
    expectedHash: string,
  ): Promise<CatalogRecordV2> {
    return this.#request<CatalogRecordV2>(
      "PATCH",
      `/v1/extensions/${encodeURIComponent(packageId)}`,
      { action, expected_hash: expectedHash },
    );
  }

  async extensionRevisions(packageId: string): Promise<CatalogRecordV2[]> {
    const result = await this.#request<{ items: CatalogRecordV2[] }>(
      "GET",
      `/v1/extensions/${encodeURIComponent(packageId)}/revisions?limit=20`,
    );
    return result.items;
  }

  async rollbackExtension(
    packageId: string,
    expectedHash: string,
    targetHash: string,
  ): Promise<CatalogRecordV2> {
    const result = await this.#request<{ extension: CatalogRecordV2 }>(
      "POST",
      `/v1/extensions/${encodeURIComponent(packageId)}/rollback`,
      { expected_hash: expectedHash, target_hash: targetHash },
      true,
      `dashboard-extension-rollback-${crypto.randomUUID()}`,
    );
    return result.extension;
  }

  async searchSessionTools(sessionId: string, query: string): Promise<ToolSearchResultV2> {
    return this.#request<ToolSearchResultV2>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/tools/search?q=${encodeURIComponent(query)}&limit=20`,
    );
  }

  async previewSessionToolCall(
    sessionId: string,
    toolId: string,
    input: Record<string, unknown>,
  ): Promise<ToolCallPreviewV2> {
    return this.#request<ToolCallPreviewV2>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/tool-call-preview`,
      { tool_id: toolId, input },
    );
  }

  async executeSessionToolCall(
    sessionId: string,
    preview: ToolCallPreviewV2,
  ): Promise<ToolExecutionV2> {
    return this.#request<ToolExecutionV2>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/tool-calls`,
      {
        tool_id: preview.resolved_call.real_tool_id,
        input: preview.resolved_call.input,
        call_digest: preview.call_digest,
      },
      true,
      `dashboard-mcp-${crypto.randomUUID()}`,
    );
  }

  async composeManualReport(input: ManualReportInputV2): Promise<CatalogRecordV2> {
    return this.#request<CatalogRecordV2>(
      "POST",
      "/v1/deliverables/reports/manual",
      input,
    );
  }

  async composeDeckFromReport(input: DeckFromReportInputV2): Promise<CatalogRecordV2> {
    return this.#request<CatalogRecordV2>(
      "POST",
      "/v1/deliverables/decks/from-report",
      input,
    );
  }

  async previewDeliverableRender(
    deliverableId: string,
    revision: number,
    format: "pptx" | "pdf",
  ): Promise<RenderPreviewV2> {
    return this.#request<RenderPreviewV2>(
      "POST",
      `/v1/deliverables/${encodeURIComponent(deliverableId)}/${revision}/render-preview`,
      { format },
    );
  }

  async exportDeliverableRender(preview: RenderPreviewV2): Promise<RenderDownloadV2> {
    const { deck_id: deckId, deck_revision: revision, format, artifact_hash: hash } = preview.manifest;
    const response = await this.#fetch(
      `/v1/deliverables/${encodeURIComponent(deckId)}/${revision}/render`,
      {
        method: "POST",
        headers: {
          Accept: format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "Content-Type": "application/json",
          "Idempotency-Key": `dashboard-render-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ format, expected_artifact_hash: hash }),
      },
      true,
    );
    if (!response.ok) throw await apiError(response);
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1]
      ?? `${deckId}-v${revision}.${format}`;
    return {
      blob: await response.blob(),
      filename,
      artifactHash: response.headers.get("x-restork-artifact-sha256") ?? hash,
    };
  }

  async createSchedule(schedule: ScheduleSpecV2): Promise<CatalogRecordV2> {
    return this.#request<CatalogRecordV2>("POST", "/v1/schedules", schedule);
  }

  async changeScheduleState(
    scheduleId: string,
    action: "pause" | "resume",
    expectedRevision: number,
  ): Promise<CatalogRecordV2> {
    return this.#request<CatalogRecordV2>(
      "PATCH",
      `/v1/schedules/${encodeURIComponent(scheduleId)}`,
      { action, expected_revision: expectedRevision },
    );
  }

  async runScheduleNow(scheduleId: string): Promise<ScheduleRunV2> {
    return this.#request<ScheduleRunV2>(
      "POST",
      `/v1/schedules/${encodeURIComponent(scheduleId)}/run`,
      undefined,
      true,
      `dashboard-schedule-${crypto.randomUUID()}`,
    );
  }

  async deleteSchedule(scheduleId: string, expectedRevision: number): Promise<void> {
    await this.#requestNoContent(
      "DELETE",
      `/v1/schedules/${encodeURIComponent(scheduleId)}?expected_revision=${expectedRevision}`,
    );
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

  async connectNativeCalendar(
    detailScope: "busy_only" | "titles",
  ): Promise<NonNullable<DashboardSnapshot["daily"]>["calendar"]> {
    return this.#request<NonNullable<DashboardSnapshot["daily"]>["calendar"]>(
      "POST",
      "/v1/daily/calendar/native/connect",
      { detail_scope: detailScope },
      true,
      `dashboard-native-calendar-${crypto.randomUUID()}`,
    );
  }

  async disconnectNativeCalendar(): Promise<
    NonNullable<DashboardSnapshot["daily"]>["calendar"]
  > {
    return this.#request<NonNullable<DashboardSnapshot["daily"]>["calendar"]>(
      "DELETE",
      "/v1/daily/calendar/native",
      undefined,
      true,
      `dashboard-native-calendar-disconnect-${crypto.randomUUID()}`,
    );
  }

  async configureMusic(
    input: MusicConfigurationInput,
  ): Promise<NonNullable<DashboardSnapshot["daily"]>["music"]> {
    return this.#request<NonNullable<DashboardSnapshot["daily"]>["music"]>(
      "POST",
      "/v1/daily/music",
      input,
      true,
      `dashboard-music-${crypto.randomUUID()}`,
    );
  }

  async refreshMusic(
    localDate: string,
  ): Promise<NonNullable<DashboardSnapshot["daily"]>["music"]> {
    return this.#request<NonNullable<DashboardSnapshot["daily"]>["music"]>(
      "POST",
      "/v1/daily/music/refresh",
      { local_date: localDate },
      true,
      `dashboard-music-refresh-${crypto.randomUUID()}`,
    );
  }

  async providerDiagnostics(smoke: boolean): Promise<ProviderDiagnostic> {
    return this.#request<ProviderDiagnostic>(
      "POST",
      "/v1/providers/deepseek/diagnostics",
      { smoke },
      true,
      undefined,
      true,
    );
  }

  async musicCover(): Promise<Blob | null> {
    const response = await this.#fetch(
      `/v1/daily/music/cover?timezone=${encodeURIComponent(systemTimeZone())}`,
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
    retryTransient = false,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await this.#fetch(
      path,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      authenticated,
      retryTransient,
    );
    if (!response.ok) throw await apiError(response);
    return (await response.json()) as T;
  }

  async #requestNoContent(method: string, path: string): Promise<void> {
    const response = await this.#fetch(
      path,
      { method, headers: { Accept: "application/json" } },
      true,
    );
    if (!response.ok) throw await apiError(response);
  }

  async #fetch(
    path: string,
    init: RequestInit,
    authenticated: boolean,
    retryTransient = false,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authenticated) {
      if (!this.#token) throw new Error("Pair this browser with Restork Core first");
      if (this.#expiresAt <= Date.now() + 120_000) await this.#rotateSession();
      headers.set("Authorization", `Bearer ${this.#token}`);
    }
    return fetchWithTransientRetry(path, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    }, retryTransient);
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
    this.#rotationPromise = fetchWithTransientRetry("/v1/token/rotate", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    }, true)
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

async function fetchWithTransientRetry(
  path: string,
  init: RequestInit,
  enabled: boolean,
): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch (error) {
    if (!enabled || !(error instanceof TypeError) || init.signal?.aborted) throw error;
    if (init.signal) {
      await abortableDelay(180, init.signal);
    } else {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 180));
    }
    return fetch(path, init);
  }
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
