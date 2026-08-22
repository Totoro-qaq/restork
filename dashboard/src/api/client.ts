import { EventCursor, EventStreamDecoder } from "./events";
import { streamDurableEvents } from "./reconnectable-stream";
import type {
  AvailableToolsV2,
  ApprovalRequest,
  DashboardApi,
  DashboardListKind,
  DashboardListPage,
  DashboardSnapshot,
  MemoryRecord,
  Mode,
  PendingRunSummary,
  RadarAction,
  RadarActionResult,
  RadarConfiguration,
  RadarConfigurationInput,
  ProviderDiagnostic,
  RunEvent,
  RunEventPage,
  RunSummary,
  StudyArtifact,
  StudyDiagnostic,
  PracticeAttemptResult,
  TaskApplyResult,
  TaskMutationPreview,
  LocalTodoInput,
  LocalTodoRecord,
  DeletedTodoPage,
  WorkDataClass,
  WorkExportResult,
  WorkHandoffPreview,
  WorkPlanArtifact,
  WorkResultManifest,
  WorkStartInput,
  WorkVerificationReport,
  ReasoningEffortV2,
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
  ExtensionInstallPreviewV2,
  PersonalSettingsRecord,
  ProviderProfileRecordV2,
  ConfigurationProfileRecordV2,
  PromptRevisionRecordV2,
  RunProposalV2,
  SessionForkResultV2,
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
  AiReportDraftInputV2,
  MailSnapshot,
  DeckFromReportInputV2,
  DeckDraftInputV2,
  CatalogCursorV2,
  PresentationTemplateInputV2,
  PresentationTemplatePageV2,
  PresentationTemplateRecordV2,
  ScheduleCreateInputV2,
  SchedulePageV2,
  ScheduleRecordV2,
  ScheduleRunPageV2,
  ScheduleUpdateSpecV2,
  ScheduleRunV2,
  VaultChangeEventV2,
  VaultNotePageV2,
  VaultNotePreviewV2,
  VaultSearchHitV2,
} from "./types";

interface LocalApiClientOptions {
  onSession?: (session: LocalSession) => Promise<void>;
}
import {
  ApiError,
  abortableDelay,
  apiError,
  fetchWithTransientRetry,
  mailSnapshot,
  normalizeSession,
  presentationTemplatePagePath,
  schedulePagePath,
  sessionCredentialPath,
  systemTimeZone,
} from "./clientHelpers";
import type { LocalSession } from "./clientHelpers";
export { ApiError, systemTimeZone };
export type { LocalSession };

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

  async resumeSession(session?: LocalSession): Promise<boolean> {
    if (session) {
      const normalized = normalizeSession(session.accessToken, session.expiresAt, true);
      this.#token = normalized.accessToken;
      this.#expiresAt = Date.parse(normalized.expiresAt);
      try {
        if (this.#expiresAt <= Date.now() + 120_000) await this.#rotateSession();
        else this.#scheduleRotation();
        return true;
      } catch {
        this.#clearSession();
        return false;
      }
    }

    const response = await fetchWithTransientRetry("/v1/token/resume", {
      method: "POST",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
    }, true);
    if (response.status === 401) return false;
    if (!response.ok) throw await apiError(response);
    const payload = (await response.json()) as {
      access_token?: unknown;
      expires_at?: unknown;
    };
    if (typeof payload.access_token !== "string" || typeof payload.expires_at !== "string") {
      throw new Error("Core returned an invalid local session response");
    }
    await this.#acceptSession(payload.access_token, payload.expires_at);
    return true;
  }

  restoreSession(session: LocalSession): void {
    const normalized = normalizeSession(session.accessToken, session.expiresAt);
    this.#token = normalized.accessToken;
    this.#expiresAt = Date.parse(normalized.expiresAt);
    this.#scheduleRotation();
  }

  async loadDashboard(): Promise<DashboardSnapshot> {
    return this.#request<DashboardSnapshot>(
      "GET",
      `/v1/bootstrap?timezone=${encodeURIComponent(systemTimeZone())}`,
    );
  }

  async listVaultNotes(cursor?: string): Promise<VaultNotePageV2> {
    const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    return this.#request<VaultNotePageV2>("GET", `/v1/vault/files?limit=100${query}`);
  }

  async searchVaultNotes(query: string): Promise<VaultSearchHitV2[]> {
    const result = await this.#request<{ items: VaultSearchHitV2[] }>(
      "GET",
      `/v1/vault/search?q=${encodeURIComponent(query)}&limit=50`,
    );
    return result.items;
  }

  async readVaultNote(relativePath: string): Promise<VaultNotePreviewV2> {
    return this.#request<VaultNotePreviewV2>(
      "GET",
      `/v1/vault/note?path=${encodeURIComponent(relativePath)}`,
    );
  }

  async streamVaultEvents(
    onEvent: (event: VaultChangeEventV2) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let retryDelay = 750;
    while (!signal.aborted) {
      let response: Response;
      try {
        response = await this.#fetch(
          "/v1/vault/events",
          {
            method: "GET",
            headers: { Accept: "text/event-stream" },
            signal,
          },
          true,
          true,
        );
      } catch {
        if (signal.aborted) return;
        await abortableDelay(retryDelay, signal);
        retryDelay = Math.min(15_000, retryDelay * 2);
        continue;
      }
      if (!response.ok) {
        if ([408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
          await abortableDelay(retryDelay, signal);
          retryDelay = Math.min(15_000, retryDelay * 2);
          continue;
        }
        throw await apiError(response);
      }
      if (!response.body) throw new Error("Core returned an unreadable Vault stream");
      const reader = response.body.getReader();
      const utf8 = new TextDecoder();
      const decoder = new EventStreamDecoder();
      let delivered = false;
      const accept = (events: RunEvent[]): void => {
        for (const event of events) {
          if (!["vault.ready", "vault.changed", "vault.unavailable"].includes(event.type)) continue;
          delivered = true;
          onEvent({
            type: event.type as VaultChangeEventV2["type"],
            data: event.data as VaultChangeEventV2["data"],
          });
        }
      };
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          accept(decoder.push(utf8.decode(value, { stream: true })));
        }
        accept(decoder.push(utf8.decode()));
        accept(decoder.finish());
      } catch {
        if (signal.aborted) return;
      }
      if (delivered) retryDelay = 750;
      if (!signal.aborted) {
        await abortableDelay(retryDelay, signal);
        retryDelay = Math.min(15_000, retryDelay * 2);
      }
    }
  }

  async createSession(title: string, profileId: string): Promise<SessionRecordV2> {
    return this.#request<SessionRecordV2>("POST", "/v1/sessions", {
      title,
      profile_id: profileId,
      locale: document.documentElement.lang || "en",
    });
  }

  async forkSession(
    sessionId: string,
    title: string,
    profileId: string,
    expectedUpdatedAt: string,
    copyLimit = 24,
  ): Promise<SessionForkResultV2> {
    return this.#request<SessionForkResultV2>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/fork`,
      {
        title,
        profile_id: profileId,
        expected_updated_at: expectedUpdatedAt,
        copy_limit: copyLimit,
      },
    );
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
    await streamDurableEvents({
      after,
      cursor,
      open: (lastEventId) => this.#fetch(
        `/v1/operations/${encodeURIComponent(operationId)}/events?follow=true`,
        {
          method: "GET",
          headers: { Accept: "text/event-stream", "Last-Event-ID": String(lastEventId) },
          signal,
        },
        true,
      ),
      onEvent,
      terminalTypes: new Set([
        "conversation.completed",
        "conversation.failed",
        "conversation.cancelled",
      ]),
      signal,
      responseError: apiError,
      initialRetryMs: 500,
    });
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
      `/v1/search?q=${encodeURIComponent(query)}&limit=50`,
    );
    return result.items;
  }

  async previewExtensionInstall(
    packageKind: "skill" | "mcp" | "plugin",
    manifest: Record<string, unknown>,
  ): Promise<ExtensionInstallPreviewV2> {
    return this.#request<ExtensionInstallPreviewV2>("POST", "/v1/extensions", {
      package_kind: packageKind,
      manifest,
    });
  }

  async installExtension(
    packageKind: "skill" | "mcp" | "plugin",
    manifest: Record<string, unknown>,
    approvedPreviewDigest: string,
  ): Promise<CatalogRecordV2> {
    return this.#request<CatalogRecordV2>("POST", "/v1/extensions", {
      package_kind: packageKind,
      manifest,
      approved_preview_digest: approvedPreviewDigest,
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

  async composeAiReportDraft(input: AiReportDraftInputV2): Promise<CatalogRecordV2> {
    return this.#request<CatalogRecordV2>(
      "POST",
      "/v1/deliverables/reports/ai-draft",
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

  async composeDeckDraft(input: DeckDraftInputV2): Promise<CatalogRecordV2> {
    return this.#request<CatalogRecordV2>(
      "POST",
      "/v1/deliverables/decks/draft",
      input,
    );
  }

  async createPresentationTemplate(
    input: PresentationTemplateInputV2,
  ): Promise<PresentationTemplateRecordV2> {
    return this.#request<PresentationTemplateRecordV2>(
      "POST",
      "/v1/deliverable-templates",
      input,
    );
  }

  async updatePresentationTemplate(
    templateId: string,
    expectedHash: string,
    input: PresentationTemplateInputV2,
  ): Promise<PresentationTemplateRecordV2> {
    return this.#request<PresentationTemplateRecordV2>(
      "PUT",
      `/v1/deliverable-templates/${encodeURIComponent(templateId)}`,
      { expected_hash: expectedHash, template: input },
    );
  }

  async listPresentationTemplates(
    cursor?: CatalogCursorV2,
  ): Promise<PresentationTemplatePageV2> {
    return this.#request<PresentationTemplatePageV2>(
      "GET",
      presentationTemplatePagePath("/v1/deliverable-templates", cursor),
    );
  }

  async listDeletedPresentationTemplates(
    cursor?: CatalogCursorV2,
  ): Promise<PresentationTemplatePageV2> {
    return this.#request<PresentationTemplatePageV2>(
      "GET",
      presentationTemplatePagePath("/v1/deliverable-templates/deleted", cursor),
    );
  }

  async deletePresentationTemplate(
    templateId: string,
    expectedHash: string,
  ): Promise<PresentationTemplateRecordV2> {
    return this.#request<PresentationTemplateRecordV2>(
      "DELETE",
      `/v1/deliverable-templates/${encodeURIComponent(templateId)}?expected_hash=${encodeURIComponent(expectedHash)}`,
    );
  }

  async restorePresentationTemplate(
    templateId: string,
    expectedHash: string,
  ): Promise<PresentationTemplateRecordV2> {
    return this.#request<PresentationTemplateRecordV2>(
      "POST",
      `/v1/deliverable-templates/${encodeURIComponent(templateId)}/restore`,
      { expected_hash: expectedHash },
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

  async createSchedule(schedule: ScheduleCreateInputV2): Promise<ScheduleRecordV2> {
    return this.#request<ScheduleRecordV2>("POST", "/v1/schedules", schedule);
  }

  async updateSchedule(
    scheduleId: string,
    expectedRevision: number,
    schedule: ScheduleUpdateSpecV2,
  ): Promise<ScheduleRecordV2> {
    return this.#request<ScheduleRecordV2>(
      "PUT",
      `/v1/schedules/${encodeURIComponent(scheduleId)}`,
      { expected_revision: expectedRevision, schedule },
    );
  }

  async listSchedules(cursor?: string): Promise<SchedulePageV2> {
    return this.#request<SchedulePageV2>("GET", schedulePagePath("/v1/schedules", cursor));
  }

  async listDeletedSchedules(cursor?: string): Promise<SchedulePageV2> {
    return this.#request<SchedulePageV2>(
      "GET",
      schedulePagePath("/v1/schedules/deleted", cursor),
    );
  }

  async listScheduleRuns(scheduleId: string, cursor?: string): Promise<ScheduleRunPageV2> {
    return this.#request<ScheduleRunPageV2>(
      "GET",
      schedulePagePath(`/v1/schedules/${encodeURIComponent(scheduleId)}/runs`, cursor),
    );
  }

  async restoreSchedule(
    scheduleId: string,
    expectedRevision: number,
  ): Promise<ScheduleRecordV2> {
    return this.#request<ScheduleRecordV2>(
      "POST",
      `/v1/schedules/${encodeURIComponent(scheduleId)}/restore`,
      { expected_revision: expectedRevision },
      true,
      `dashboard-schedule-restore-${crypto.randomUUID()}`,
    );
  }

  async changeScheduleState(
    scheduleId: string,
    action: "pause" | "resume",
    expectedRevision: number,
  ): Promise<ScheduleRecordV2> {
    return this.#request<ScheduleRecordV2>(
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
      return { kind, items: payload.tasks, page: payload.page, configured: payload.configured, vault_configured: payload.vault_configured };
    }
    if (kind === "radar") {
      // Radar combines independently ranked GitHub and Hacker News lanes.
      // A twelve-item global page lets high GitHub star counts crowd every HN
      // item out of the first view even when both feeds are cached locally.
      const payload = await this.#request<DashboardSnapshot["radar"] & { page: DashboardListPage["page"] }>("GET", `/v1/radar?limit=50&cursor=${encoded}`);
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
    providerProfileId = "deepseek",
    skillIds: string[] = [],
    allowedTools: string[] = [],
    reasoningEffort?: ReasoningEffortV2,
  ): Promise<RunSummary> {
    const identity = crypto.randomUUID();
    const response = await this.#request<{ run: RunSummary }>(
      "POST",
      "/v1/runs",
      {
        mode,
        goal,
        provider_profile_id: providerProfileId,
        data_class: dataClass,
        auto_start: mode === "research",
        allowed_tools: allowedTools,
        skill_ids: skillIds,
        reasoning_effort: reasoningEffort,
      },
      true,
      `dashboard-create-${identity}`,
    );
    return response.run;
  }

  async listAvailableTools(
    providerProfileId: string,
  ): Promise<AvailableToolsV2> {
    return this.#request(
      "GET",
      `/v1/tools/available?provider_profile_id=${encodeURIComponent(providerProfileId)}`,
      undefined,
      true,
      `dashboard-tools-${crypto.randomUUID()}`,
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
      true,
      `dashboard-study-diagnostic-${crypto.randomUUID()}`,
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
      true,
      `dashboard-study-path-${crypto.randomUUID()}`,
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
      `/v1/study/runs/${encodeURIComponent(runId)}/exercises/${encodeURIComponent(exerciseId)}/attempt`,
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
      true,
      `dashboard-work-plan-${crypto.randomUUID()}`,
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

  async configureRadar(input: RadarConfigurationInput): Promise<RadarConfiguration> {
    return this.#request<RadarConfiguration>(
      "PUT",
      "/v1/radar/config",
      input,
      true,
      `dashboard-radar-config-${crypto.randomUUID()}`,
    );
  }

  async cancelRun(runId: string): Promise<void> {
    await this.#request<{ run_id: string; state: string }>(
      "POST",
      `/v1/runs/${encodeURIComponent(runId)}/cancel`,
      {},
      true,
      `dashboard-run-cancel-${crypto.randomUUID()}`,
    );
  }

  async retryRun(runId: string): Promise<void> {
    await this.#request<{ run_id: string; state: string }>(
      "POST",
      `/v1/runs/${encodeURIComponent(runId)}/advance`,
      { approved_tool_calls: [], denied_tool_calls: [] },
      true,
      `dashboard-run-retry-${crypto.randomUUID()}`,
    );
  }

  async loadRunSummary(runId: string): Promise<PendingRunSummary | null> {
    const path = `/v1/runs/${encodeURIComponent(runId)}/summary-suggestion`;
    const response = await this.#fetch(path, { method: "GET", headers: { Accept: "application/json" } }, true);
    if (response.status === 204) return null;
    if (!response.ok) throw await apiError(response);
    const body = await response.text();
    return body ? JSON.parse(body) as PendingRunSummary : null;
  }

  async acceptRunSummary(runId: string): Promise<MemoryRecord> {
    const path = `/v1/runs/${encodeURIComponent(runId)}/summary-suggestion/accept`;
    return this.#request<MemoryRecord>("POST", path, {}, true, `dashboard-run-summary-accept-${crypto.randomUUID()}`);
  }

  async dismissRunSummary(runId: string): Promise<void> {
    const path = `/v1/runs/${encodeURIComponent(runId)}/summary-suggestion/dismiss`;
    await this.#request<void>("POST", path, {}, true, `dashboard-run-summary-dismiss-${crypto.randomUUID()}`);
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

  async createLocalTodo(input: LocalTodoInput): Promise<LocalTodoRecord> {
    return this.#request<LocalTodoRecord>(
      "POST",
      "/v1/tasks/local",
      input,
      true,
      `dashboard-local-todo-${crypto.randomUUID()}`,
    );
  }

  async updateLocalTodo(
    taskId: string,
    input: LocalTodoInput & { expected_updated_at: string },
  ): Promise<LocalTodoRecord> {
    return this.#request<LocalTodoRecord>(
      "PATCH",
      `/v1/tasks/local/${encodeURIComponent(taskId)}`,
      input,
    );
  }

  async deleteLocalTodo(taskId: string, expectedUpdatedAt: string): Promise<void> {
    await this.#request<Record<string, never>>(
      "DELETE",
      `/v1/tasks/local/${encodeURIComponent(taskId)}`,
      { expected_updated_at: expectedUpdatedAt },
    );
  }

  async restoreLocalTodo(taskId: string, expectedUpdatedAt: string): Promise<LocalTodoRecord> {
    return this.#request<LocalTodoRecord>(
      "POST",
      `/v1/tasks/local/${encodeURIComponent(taskId)}/restore`,
      { expected_updated_at: expectedUpdatedAt },
      true,
      `dashboard-local-todo-restore-${crypto.randomUUID()}`,
    );
  }

  async loadDeletedTodos(cursor = ""): Promise<DeletedTodoPage> {
    return this.#request<DeletedTodoPage>(
      "GET",
      `/v1/tasks/local/deleted?limit=12&cursor=${encodeURIComponent(cursor)}`,
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

  async previewResearchNote(runId: string): Promise<TaskMutationPreview> {
    return this.#request<TaskMutationPreview>(
      "POST",
      `/v1/research/${encodeURIComponent(runId)}/note/preview`,
      {},
      true,
      `dashboard-research-note-${crypto.randomUUID()}`,
    );
  }

  async previewStudyNote(runId: string): Promise<TaskMutationPreview> {
    return this.#request<TaskMutationPreview>(
      "POST",
      `/v1/study/runs/${encodeURIComponent(runId)}/note/preview`,
      {},
      true,
      `dashboard-study-note-${crypto.randomUUID()}`,
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

  async connectNativeMail(): Promise<MailSnapshot> {
    return this.#request<MailSnapshot>(
      "POST",
      "/v1/daily/mail/native/connect",
      {},
      true,
      `dashboard-native-mail-${crypto.randomUUID()}`,
    );
  }

  async disconnectNativeMail(): Promise<MailSnapshot> {
    return this.#request<MailSnapshot>(
      "DELETE",
      "/v1/daily/mail/native",
      undefined,
      true,
      `dashboard-native-mail-disconnect-${crypto.randomUUID()}`,
    );
  }

  async streamMail(
    onSnapshot: (snapshot: MailSnapshot) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let retryDelay = 750;
    while (!signal.aborted) {
      let response: Response;
      try {
        response = await this.#fetch(
          "/v1/daily/mail/events",
          {
            method: "GET",
            headers: { Accept: "text/event-stream" },
            signal,
          },
          true,
          true,
        );
      } catch {
        if (signal.aborted) return;
        await abortableDelay(retryDelay, signal);
        retryDelay = Math.min(15_000, retryDelay * 2);
        continue;
      }
      if (!response.ok) {
        if ([408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
          await abortableDelay(retryDelay, signal);
          retryDelay = Math.min(15_000, retryDelay * 2);
          continue;
        }
        throw await apiError(response);
      }
      if (!response.body) throw new Error("Core returned an unreadable mail stream");
      const reader = response.body.getReader();
      const utf8 = new TextDecoder();
      const stream = new EventStreamDecoder();
      let delivered = false;
      const accept = (events: RunEvent[]): void => {
        for (const event of events) {
          if (event.type !== "mail.snapshot") continue;
          const snapshot = mailSnapshot(event.data);
          if (!snapshot) throw new Error("Core returned an invalid mail snapshot");
          delivered = true;
          onSnapshot(snapshot);
        }
      };
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          accept(stream.push(utf8.decode(value, { stream: true })));
        }
        accept(stream.push(utf8.decode()));
        accept(stream.finish());
      } catch {
        if (signal.aborted) return;
      }
      if (delivered) retryDelay = 750;
      if (!signal.aborted) {
        await abortableDelay(retryDelay, signal);
        retryDelay = Math.min(15_000, retryDelay * 2);
      }
    }
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

  async researchMusic(
    localDate: string,
  ): Promise<NonNullable<DashboardSnapshot["daily"]>["music"]> {
    return this.#request<NonNullable<DashboardSnapshot["daily"]>["music"]>(
      "POST",
      "/v1/daily/music/research",
      { local_date: localDate },
      true,
      `dashboard-music-research-${crypto.randomUUID()}`,
    );
  }

  async providerDiagnostics(
    smoke: boolean,
    target: "primary" | "web_search" = "primary",
    providerProfileId = "deepseek",
  ): Promise<ProviderDiagnostic> {
    return this.#request<ProviderDiagnostic>(
      "POST",
      `/v1/providers/${encodeURIComponent(providerProfileId)}/diagnostics`,
      target === "primary" ? { smoke } : { smoke, target },
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
    await streamDurableEvents({
      after,
      cursor,
      open: (lastEventId) => this.#fetch(
        `/v1/runs/${encodeURIComponent(runId)}/events?follow=true`,
        {
          method: "GET",
          headers: { Accept: "text/event-stream", "Last-Event-ID": String(lastEventId) },
          signal,
        },
        true,
      ),
      onEvent,
      terminalTypes: new Set(["run.completed", "run.failed", "run.cancelled", "run.stopped"]),
      signal,
      responseError: apiError,
    });
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
    if (response.status === 204) return undefined as T;
    const responseBody = await response.text();
    if (!responseBody) return undefined as T;
    return JSON.parse(responseBody) as T;
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
      credentials: sessionCredentialPath(path) ? "same-origin" : "omit",
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
      credentials: "same-origin",
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

  #clearSession(): void {
    if (this.#rotationTimer !== null) window.clearTimeout(this.#rotationTimer);
    this.#rotationTimer = null;
    this.#token = null;
    this.#expiresAt = 0;
  }
}
