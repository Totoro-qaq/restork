import "./styles.css";

import { LocalApiClient, systemTimeZone } from "./api/client";
import { bindDesktopExternalLinks, detectDesktopBridge } from "./desktop";
import type { DesktopBridge } from "./desktop";
import type {
  ConversationTurn,
  DashboardApi,
  DashboardListKind,
  DashboardSnapshot,
  MailSnapshot,
  Mode,
  RadarAction,
  ReasoningEffortV2,
  ProviderKindV2,
  RunEvent,
  RunSummary,
  WorkDataClass,
  WorkHandoffPreview,
  WorkResultManifest,
} from "./api/types";
import {
  agentWaitMarkup,
  approvalsView,
  assistantStreamMarkup,
  conversationOperationWaitMarkup,
  errorText,
  eventRow,
  mailHeadersMarkup,
  memoryView,
  radarView,
  runsView,
  tasksView,
  pairingMarkup,
  providerDiagnosticMarkup,
  providerErrorMarkup,
  providerWaitMarkup,
  researchPreviewMarkup,
  studyArtifactMarkup,
  studyAttemptMarkup,
  studyDiagnosticMarkup,
  workExportMarkup,
  workHandoffMarkup,
  workPlanMarkup,
  workVerificationMarkup,
  runEventsMarkup,
  runProposalMarkup,
  sessionMessagesMarkup,
  toolCallPreviewMarkup,
  toolSearchMarkup,
  workspaceMarkup,
} from "./ui/render";
import type { AgentWaitStage } from "./ui/render";
import { startClock } from "./ui/clock";
import { activeView, bindRovingFocus, escapeMarkup } from "./ui/dom";
import { configureAutomation } from "./features/automation";
import {
  bindRadarConfig,
  configureWeather,
  refreshRadarPanel,
} from "./features/daily";
import type { DailyEffects } from "./features/daily";
import { configureDeliverables } from "./features/deliverables";
import {
  configureNativeSetup,
  friendlyNativeSetupError,
} from "./features/nativeSetup";
import {
  configureVaultBrowser,
  openVaultWorkspace,
  stopVaultStream,
} from "./features/vault";
import { configureStartWorkspace } from "./features/start";
import {
  alternateLocale,
  detectLocale,
  isLocale,
  localeOf,
  persistLocale,
  tr,
} from "./i18n";
import type { Locale } from "./i18n";

interface MountOptions {
  api?: DashboardApi;
  snapshot?: DashboardSnapshot;
  locale?: Locale;
}

const coverUrls = new WeakMap<HTMLElement, string>();
interface EventStreamEntry {
  runId: string;
  controller: AbortController;
  listeners: Map<string, (event: RunEvent) => void>;
}

const eventStreams = new WeakMap<HTMLElement, EventStreamEntry>();
const mailStreams = new WeakMap<HTMLElement, AbortController>();
const conversationStreams = new WeakMap<HTMLElement, {
  controller: AbortController;
  operationId: string;
}>();
// `renderWorkspace` replaces `root.innerHTML`, so any selection held in the DOM
// is destroyed on every refresh, locale switch, settings save, and pagination.
// The user's choice therefore lives outside the DOM and is restored after render.
const selectedSessions = new WeakMap<HTMLElement, string>();
const dismissHandlers = new WeakMap<HTMLElement, (event: KeyboardEvent) => void>();
// A locale change or ordinary workspace refresh rebuilds the DOM on the same
// root. Radar's startup refresh should happen once per opened workspace, not
// once per render. Manual navigation and the Refresh button remain available.
const radarStartupRefreshes = new WeakSet<HTMLElement>();

/**
 * Escape closes the topmost dismissible surface regardless of where focus sits.
 * Binding it to `#action-panel` alone meant Escape did nothing unless the user
 * had already tabbed into the panel.
 *
 * A native `<dialog>` handles its own Escape, so an open modal is left alone.
 */
function bindDismissStack(root: HTMLElement): void {
  const previous = dismissHandlers.get(root);
  if (previous) document.removeEventListener("keydown", previous);

  const handler = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (!root.isConnected) {
      document.removeEventListener("keydown", handler);
      return;
    }
    if (root.querySelector("dialog[open]")) return;

    const panel = root.querySelector<HTMLElement>("#action-panel");
    if (panel && !panel.hidden) {
      event.preventDefault();
      closeRunForm(root, true);
      return;
    }
    const region = root.querySelector<HTMLElement>("#global-status-region");
    if (region?.dataset.visible === "true") {
      event.preventDefault();
      clearAnnouncement(root);
    }
  };

  document.addEventListener("keydown", handler);
  dismissHandlers.set(root, handler);
}

const THEMES = new Set(["system", "light", "dark"]);

/**
 * Apply the stored theme to the document root. `styles.css` resolves its colour
 * tokens from `[data-theme]`, with `system` deferring to `prefers-color-scheme`.
 * Without this the Theme control round-trips to Core and changes nothing.
 */
export function applyTheme(theme: string | undefined): void {
  const selected = theme && THEMES.has(theme) ? theme : "system";
  document.documentElement.dataset.theme = selected;
}

function syncReasoningControls(form: HTMLFormElement): void {
  const kind = form.elements.namedItem("kind") as HTMLSelectElement | null;
  const effort = form.elements.namedItem("reasoning_effort") as HTMLSelectElement | null;
  const budget = form.elements.namedItem("reasoning_max_tokens") as HTMLInputElement | null;
  const budgetField = form.querySelector<HTMLElement>("[data-reasoning-budget-field]");
  const selected = kind?.selectedOptions[0];
  if (!effort || !selected) return;
  const supported = new Set(
    (selected.dataset.reasoningEfforts ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  supported.add("auto");
  if (selected.dataset.reasoningCanDisable === "true") supported.add("none");
  for (const option of effort.options) {
    const available = supported.has(option.value);
    option.disabled = !available;
    option.hidden = !available;
  }
  if (!supported.has(effort.value)) effort.value = "auto";
  const supportsBudget = selected.dataset.reasoningBudget === "true";
  if (budgetField) budgetField.hidden = !supportsBudget;
  if (budget) {
    budget.disabled = !supportsBudget || ["auto", "none"].includes(effort.value);
    if (!supportsBudget) budget.value = "";
  }
}

const RECOMMENDED_PROVIDER_MODELS: Record<string, string[]> = {
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
  openai: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
  anthropic: ["claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-haiku-4-5"],
  minimax: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed"],
  mimo: ["mimo-v2.5-pro", "mimo-v2.5"],
  glm: ["glm-5.2"],
  kimi: ["kimi-k2.5"],
  qwen: ["qwen-max", "qwen-plus", "qwen-turbo"],
};

function syncProviderModelControls(form: HTMLFormElement, requestedModel?: string): void {
  const kind = form.elements.namedItem("kind") as HTMLSelectElement | null;
  const selected = kind?.selectedOptions[0];
  const pickerField = form.querySelector<HTMLElement>("[data-provider-model-picker]");
  const picker = form.querySelector<HTMLSelectElement>("[data-provider-model-select]");
  const customField = form.querySelector<HTMLElement>("[data-provider-custom-model-field]");
  const custom = form.querySelector<HTMLInputElement>("[data-provider-custom-model]");
  const hidden = form.elements.namedItem("model") as HTMLInputElement | null;
  const baseUrl = form.elements.namedItem("base_url") as HTMLInputElement | null;
  const endpointNote = form.querySelector<HTMLElement>("[data-provider-endpoint-note]");
  if (!kind || !selected || !picker || !custom || !hidden || !baseUrl) return;

  let models: string[] = [];
  try {
    const parsed = JSON.parse(selected.dataset.recommendedModels ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      models = parsed.filter((value): value is string => (
        typeof value === "string" && value.length > 0 && value.length <= 256
      ));
    }
  } catch {
    models = [];
  }
  if (!models.length) models = RECOMMENDED_PROVIDER_MODELS[kind.value] ?? [];
  const defaultModel = selected.dataset.defaultModel
    || RECOMMENDED_PROVIDER_MODELS[kind.value]?.[0]
    || "";
  const current = requestedModel?.trim() || hidden.value.trim() || defaultModel;
  if (current && !models.includes(current)) models.unshift(current);
  models = models.filter((value, index, values) => values.indexOf(value) === index);

  const customMode = kind.value === "open_ai_compatible" || models.length === 0;
  pickerField?.toggleAttribute("hidden", customMode);
  customField?.toggleAttribute("hidden", !customMode);
  picker.disabled = customMode;
  custom.disabled = !customMode;
  if (customMode) {
    custom.value = current;
    hidden.value = custom.value;
  } else {
    picker.innerHTML = models.map((model) => {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      return option.outerHTML;
    }).join("");
    picker.value = models.includes(current) ? current : (defaultModel || models[0]);
    hidden.value = picker.value;
  }

  const editableEndpoint = selected.dataset.endpointPolicy === "public_https";
  baseUrl.readOnly = !editableEndpoint;
  if (endpointNote) endpointNote.textContent = editableEndpoint
    ? tr(localeOf(form), "Custom endpoints can be edited.", "自定义兼容端点可以修改地址。")
    : tr(localeOf(form), "Official providers use a locked verified endpoint.", "官方供应商使用经过确认的固定地址。")
}

export function mountDashboard(root: HTMLElement, options: MountOptions = {}): void {
  const api = options.api ?? new LocalApiClient();
  applyLocale(root, options.locale ?? detectLocale());
  if (options.snapshot) {
    renderWorkspace(root, api, options.snapshot);
    return;
  }
  renderPairing(root, api);
}

export async function mountBrowserDashboard(
  root: HTMLElement,
  api = new LocalApiClient(),
): Promise<void> {
  applyLocale(root, detectLocale());
  renderSessionRecovery(root);
  try {
    if (await api.resumeSession()) {
      renderWorkspace(root, api, await api.loadDashboard());
      return;
    }
    renderPairing(root, api);
  } catch {
    renderPairing(root, api);
    const status = root.querySelector<HTMLElement>("#pair-status");
    if (status) {
      status.textContent = tr(
        localeOf(root),
        "The saved local session could not be renewed. Enter the current pairing code once.",
        "已保存的本地会话未能续期，请输入当前配对码一次。",
      );
    }
  }
}

function renderSessionRecovery(root: HTMLElement): void {
  root.innerHTML = `
    <main class="desktop-bootstrap" aria-labelledby="session-recovery-title">
      <p class="kicker">RESTORK · LOCAL SESSION</p>
      <h1 id="session-recovery-title">${tr(localeOf(root), "Opening your local workspace", "正在打开本地工作台")}</h1>
      <p role="status">${tr(localeOf(root), "Renewing the protected loopback session…", "正在续期受保护的本地会话……")}</p>
      <span class="agent-wait-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    </main>`;
}

function renderPairing(root: HTMLElement, api: DashboardApi): void {
  const locale = localeOf(root);
  root.innerHTML = pairingMarkup(locale);
  bindLocaleSwitch(root, () => renderPairing(root, api));
  const form = root.querySelector<HTMLFormElement>("#pair-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void pairAndLoad(root, api, new FormData(form));
  });
}

async function pairAndLoad(root: HTMLElement, api: DashboardApi, data: FormData): Promise<void> {
  const status = root.querySelector<HTMLElement>("#pair-status");
  const code = String(data.get("code") ?? "").trim();
  if (!code) return;
  if (status) status.textContent = tr(localeOf(root), "Pairing with the local Core…", "正在与本地 Core 配对…");
  try {
    await api.pair(code);
    renderWorkspace(root, api, await api.loadDashboard());
  } catch (error) {
    if (status) status.textContent = errorText(error, localeOf(root));
  }
}

function renderWorkspace(root: HTMLElement, api: DashboardApi, snapshot: DashboardSnapshot): void {
  const locale = localeOf(root);
  stopEventStream(root);
  stopMailStream(root);
  stopVaultStream(root);
  releaseCover(root);
  root.innerHTML = workspaceMarkup(snapshot, locale);
  applyTheme(snapshot.workspaceV2?.personal?.settings.theme);
  startClock(root);
  bindProviderDiagnosticDismiss(root);
  root.querySelector<HTMLButtonElement>("#global-status-dismiss")?.addEventListener("click", () => {
    clearAnnouncement(root);
  });
  bindDismissStack(root);
  bindLocaleSwitch(root, () => {
    const view = root.querySelector<HTMLElement>("[data-view].is-active")?.dataset.view ?? "start";
    renderWorkspace(root, api, snapshot);
    selectView(root, view);
    if (view === "vault") void openVaultWorkspace(root, api);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      closeRunForm(root, false);
      const view = button.dataset.view ?? "overview";
      selectView(root, view);
      if (view === "vault") void openVaultWorkspace(root, api);
      if (view === "radar") void refreshRadarPanel(root, api, snapshot, dailyEffects(root, api, snapshot));
      if (view === "start") resumeStartRunFromSnapshot(root, api, snapshot);
    });
  });
  const nav = root.querySelector<HTMLElement>(".sidebar nav");
  if (nav) bindRovingFocus(nav, "[data-view]");
  root.querySelectorAll<HTMLElement>("[data-roving-group]").forEach((group) => {
    bindRovingFocus(group, "button");
  });
  root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => openRunForm(root, button.dataset.mode as Mode, button, snapshot));
  });
  const desktopBridge = detectDesktopBridge();
  bindDesktopExternalLinks(root, desktopBridge, (error) => {
    announceError(root, errorText(error, localeOf(root)));
  });
  configureStartWorkspace(root, snapshot, {
    submit: (form) => { void createRun(root, api, form, snapshot); },
    selectView: (view) => {
      selectView(root, view);
      if (view === "vault") void openVaultWorkspace(root, api);
      if (view === "start") resumeStartRunFromSnapshot(root, api, snapshot);
    },
    resume: (runId, state) => resumeStartRun(root, api, runId, state),
    cancel: (runId) => { void cancelStartRun(root, api, runId); },
    ...(desktopBridge ? { chooseWorkspace: async () => {
      const selection = await desktopBridge.chooseWorkspace();
      if (!selection || selection.status === "cancelled") return null;
      return { grantId: selection.grantId, label: selection.label };
    } } : {}),
  });
  root.querySelector<HTMLButtonElement>("[data-run-panel-close]")?.addEventListener("click", () => {
    closeRunForm(root, true);
  });
  root.querySelector<HTMLElement>("#action-panel")?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeRunForm(root, true);
  });
  root.querySelector<HTMLFormElement>("#run-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void createRun(root, api, event.currentTarget as HTMLFormElement, snapshot);
  });
  root.querySelector<HTMLButtonElement>("#refresh")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (button.getAttribute("aria-busy") === "true") return;
    const view = root.querySelector<HTMLElement>("[data-view].is-active")?.dataset.view ?? "start";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    void refresh(root, api, view).finally(() => {
      // A successful refresh replaces the whole workspace. Only restore the
      // original control when the request failed and it is still mounted.
      if (!root.contains(button)) return;
      button.disabled = false;
      button.removeAttribute("aria-busy");
    });
  });
  bindListInteractions(root, api, snapshot, root);
  configureMusic(root, api);
  configureWeather(root, api, dailyEffects(root, api, snapshot));
  configureCalendar(root, api);
  configureMail(root, api, snapshot);
  configureProvider(root, api, snapshot);
  configureNativeSetup(root, {
    selectView: (view) => selectView(root, view),
  });
  configureRustWorkspace(root, api, snapshot);
  bindRadarConfig(root, api, snapshot, dailyEffects(root, api, snapshot));
  configureVaultBrowser(root, api);
  // Last, so it overrides any enabled state the feature wiring just set.
  applyCapabilityGuards(root, api, locale);
  if (snapshot.daily?.music?.recommendation?.cover_available) {
    void loadMusicCover(root, api);
  }
  if (snapshot.radar.configured && api.loadPage && !radarStartupRefreshes.has(root)) {
    radarStartupRefreshes.add(root);
    void refreshRadarPanel(root, api, snapshot, dailyEffects(root, api, snapshot));
  }
}

function dailyEffects(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
): DailyEffects {
  return {
    error: (message) => announceError(root, message),
    refresh: () => refresh(root, api),
    renderRadar: () => renderListPanel(root, api, snapshot, "radar"),
    status: (message) => announceStatus(root, message),
  };
}

function configureRustWorkspace(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
): void {
  if (!snapshot.workspaceV2) return;
  const profileMaximumDataClass = (profileId: string): WorkDataClass => {
    if (profileId === "safe-mode") return "confidential";
    if (profileId === "deepseek") return "public";
    return snapshot.workspaceV2?.profiles?.find(
      ({ profile }) => profile.profile_id === profileId,
    )?.profile.maximum_data_class ?? "public";
  };
  const syncProfileControls = (profileId: string, updatedAt: string): void => {
    const pane = root.querySelector<HTMLElement>(".conversation-pane");
    if (pane) {
      pane.dataset.activeProfile = profileId;
      pane.dataset.activeUpdatedAt = updatedAt;
    }
    const forkForm = root.querySelector<HTMLFormElement>("#session-fork-form");
    if (forkForm) forkForm.dataset.sourceUpdatedAt = updatedAt;
    const forkSelect = forkForm?.elements.namedItem("profile_id") as HTMLSelectElement | null;
    const currentOption = forkSelect
      ? Array.from(forkSelect.options).find((option) => option.value === profileId)
      : undefined;
    const profileLabel = root.querySelector<HTMLElement>("#conversation-profile-label");
    if (profileLabel) profileLabel.textContent = currentOption?.textContent ?? profileId;
    if (forkSelect) {
      for (const option of forkSelect.options) option.disabled = option.value === profileId;
      if (!forkSelect.value || forkSelect.value === profileId) {
        forkSelect.value = Array.from(forkSelect.options).find((option) => !option.disabled)?.value ?? "";
      }
    }
    const rank: Record<WorkDataClass, number> = {
      public: 0,
      personal: 1,
      confidential: 2,
    };
    const maximum = profileMaximumDataClass(profileId);
    root.querySelectorAll<HTMLSelectElement>(
      '#session-message-form [name="data_class"], #context-preview-form [name="data_class"]',
    ).forEach((select) => {
      for (const option of select.options) {
        option.disabled = rank[option.value as WorkDataClass] > rank[maximum];
      }
      if (rank[select.value as WorkDataClass] > rank[maximum]) select.value = maximum;
    });
  };
  const selectSession = async (
    sessionId: string,
    title: string,
    profileId = "safe-mode",
  ): Promise<void> => {
    const pane = root.querySelector<HTMLElement>(".conversation-pane");
    const host = root.querySelector<HTMLElement>("#conversation-messages");
    const heading = root.querySelector<HTMLElement>("#conversation-title");
    if (!pane || !host || !api.sessionMessages) return;
    selectedSessions.set(root, sessionId);
    pane.dataset.activeSession = sessionId;
    pane.dataset.activeProfile = profileId;
    const selectedRecord = snapshot.workspaceV2?.sessions.find(
      (session) => session.session_id === sessionId,
    );
    pane.dataset.activeVersion = String(selectedRecord?.version ?? 0);
    syncProfileControls(profileId, selectedRecord?.updated_at ?? "");
    if (heading) heading.textContent = title;
    root.querySelectorAll<HTMLElement>("[data-session-select]").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.sessionSelect === sessionId);
    });
    root.querySelectorAll<HTMLFormElement>("#session-message-form, #proposal-form").forEach(
      (form) => { form.hidden = false; },
    );
    const contextPreview = root.querySelector<HTMLDetailsElement>(".context-preview");
    if (contextPreview) contextPreview.hidden = profileId === "safe-mode";
    delete pane.dataset.contextPreviewHash;
    delete pane.dataset.contextPreviewClass;
    root.querySelectorAll<HTMLButtonElement>("[data-session-export], [data-session-archive], [data-session-delete]")
      .forEach((button) => { button.disabled = false; });
    host.setAttribute("aria-busy", "true");
    host.innerHTML = `<p class="empty">${tr(localeOf(root), "Loading local messages…", "正在加载本地消息…")}</p>`;
    try {
      const messages = await api.sessionMessages(sessionId);
      if (pane.dataset.activeSession !== sessionId) return;
      const latest = messages.at(-1);
      if (latest && selectedRecord) {
        selectedRecord.updated_at = latest.created_at;
        syncProfileControls(profileId, latest.created_at);
        const sessionButton = Array.from(
          root.querySelectorAll<HTMLButtonElement>("[data-session-select]"),
        ).find((button) => button.dataset.sessionSelect === sessionId);
        if (sessionButton) sessionButton.dataset.sessionUpdatedAt = latest.created_at;
      }
      host.innerHTML = sessionMessagesMarkup(messages, localeOf(root));
      host.scrollTop = host.scrollHeight;
    } catch (error) {
      host.innerHTML = `<p class="empty">${escapeStatus(errorText(error, localeOf(root)))}</p>`;
    } finally {
      host.removeAttribute("aria-busy");
    }
  };

  root.querySelectorAll<HTMLButtonElement>("[data-session-select]").forEach((button) => {
    button.addEventListener("click", () => {
      void selectSession(
        button.dataset.sessionSelect ?? "",
        button.dataset.sessionTitle ?? "",
        button.dataset.sessionProfile ?? "safe-mode",
      );
    });
  });
  root.querySelector<HTMLFormElement>("#session-search-form")?.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const query = String(new FormData(form).get("query") ?? "").trim();
      const host = root.querySelector<HTMLElement>("#session-search-results");
      if (!query || !host || !api.searchSessions) return;
      host.innerHTML = `<p class="fine">${tr(localeOf(root), "Searching local knowledge…", "正在搜索本地知识…")}</p>`;
      void api.searchSessions(query).then((hits) => {
        const rows = hits.map((hit) => {
          const sessionAttribute = hit.session_id
            ? ` data-session-hit="${escapeStatus(hit.session_id)}"`
            : "";
          const kind = hit.kind ?? "session";
          const label = hit.title ?? hit.reference ?? kind;
          const suffix = hit.sequence == null ? kind : `${kind} · #${hit.sequence}`;
          return `<button type="button"${sessionAttribute} ${hit.session_id ? "" : "disabled"}>`
            + `<strong>${escapeStatus(label)}</strong><span>${escapeStatus(hit.excerpt)}</span>`
            + `<small>${escapeStatus(suffix)}</small></button>`;
        }).join("");
        host.innerHTML = rows
          || `<p class="fine">${tr(localeOf(root), "No match.", "没有匹配项。")}</p>`;
        host.querySelectorAll<HTMLButtonElement>("[data-session-hit]").forEach((button) => {
          button.addEventListener("click", () => {
            const session = snapshot.workspaceV2?.sessions.find(
              (item) => item.session_id === button.dataset.sessionHit,
            );
            if (session) void selectSession(session.session_id, session.title, session.profile_id);
          });
        });
      }).catch((error) => { host.textContent = errorText(error, localeOf(root)); });
    },
  );

  root.querySelector<HTMLButtonElement>("[data-session-export]")?.addEventListener("click", () => {
    const pane = root.querySelector<HTMLElement>(".conversation-pane");
    const sessionId = pane?.dataset.activeSession ?? "";
    if (!sessionId || !api.exportSession) return;
    void api.exportSession(sessionId).then((payload) => {
      downloadJson(`restork-${safeFilename(payload.session.title)}.json`, payload);
      announceStatus(root, tr(localeOf(root), "Conversation export downloaded locally.", "对话导出已下载到本地。"));
    }).catch((error) => announceError(root, errorText(error, localeOf(root))));
  });

  root.querySelector<HTMLButtonElement>("[data-session-archive]")?.addEventListener("click", () => {
    const pane = root.querySelector<HTMLElement>(".conversation-pane");
    const sessionId = pane?.dataset.activeSession ?? "";
    const version = Number(pane?.dataset.activeVersion ?? "0");
    if (!sessionId || !version || !api.archiveSession) return;
    void api.archiveSession(sessionId, version)
      .then(() => reloadWorkspaceView(root, api, "conversation"))
      .catch((error) => announceError(root, errorText(error, localeOf(root))));
  });

  root.querySelector<HTMLButtonElement>("[data-session-delete]")?.addEventListener("click", async () => {
    const pane = root.querySelector<HTMLElement>(".conversation-pane");
    const sessionId = pane?.dataset.activeSession ?? "";
    const version = Number(pane?.dataset.activeVersion ?? "0");
    if (!sessionId || !version || !api.deleteSession) return;
    const confirmed = await confirmAction(root, tr(localeOf(root), "Delete this local conversation permanently?", "永久删除这个本地对话？"));
    if (!confirmed) return;
    void api.deleteSession(sessionId, version)
      .then(() => reloadWorkspaceView(root, api, "conversation"))
      .catch((error) => announceError(root, errorText(error, localeOf(root))));
  });
  root.querySelector<HTMLFormElement>("#session-create-form")?.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const title = String(data.get("title") ?? "").trim();
      const profileId = String(data.get("profile_id") ?? "safe-mode").trim();
      if (!title || !api.createSession) return;
      const button = form.querySelector<HTMLButtonElement>("button");
      if (button) button.disabled = true;
      void api.createSession(title, profileId).then((session) => {
        snapshot.workspaceV2?.sessions.unshift(session);
        renderWorkspace(root, api, snapshot);
        selectView(root, "conversation");
        return selectSession(session.session_id, session.title, session.profile_id);
      }).catch((error) => announceError(root, errorText(error, localeOf(root))));
    },
  );

  root.querySelector<HTMLButtonElement>("[data-open-provider-settings]")?.addEventListener(
    "click",
    () => selectView(root, "settings"),
  );
  root.querySelector<HTMLFormElement>("#session-fork-form")?.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const pane = root.querySelector<HTMLElement>(".conversation-pane");
      const status = form.querySelector<HTMLElement>("#session-fork-status");
      const sessionId = pane?.dataset.activeSession ?? "";
      const expectedUpdatedAt = pane?.dataset.activeUpdatedAt
        ?? form.dataset.sourceUpdatedAt
        ?? "";
      const profileId = String(new FormData(form).get("profile_id") ?? "").trim();
      const source = snapshot.workspaceV2?.sessions.find(
        (session) => session.session_id === sessionId,
      );
      if (!source || !profileId || !expectedUpdatedAt || !api.forkSession) return;
      const title = boundedForkTitle(source.title, profileId);
      form.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select")
        .forEach((control) => { control.disabled = true; });
      if (status) {
        status.textContent = tr(
          localeOf(root),
          "Checking what the new model may receive and creating a conversation branch…",
          "正在检查新模型可以接收哪些内容，并创建对话分支…",
        );
      }
      void api.forkSession(sessionId, title, profileId, expectedUpdatedAt, 24).then((fork) => {
        snapshot.workspaceV2?.sessions.unshift(fork.session);
        renderWorkspace(root, api, snapshot);
        selectView(root, "conversation");
        return selectSession(fork.session.session_id, fork.session.title, fork.session.profile_id)
          .then(() => announceStatus(root, tr(
            localeOf(root),
            `Conversation branched with ${fork.copied_messages} messages; the original is unchanged.`,
            `已携带 ${fork.copied_messages} 条消息创建对话分支；原对话保持不变。`,
          )));
      }).catch((error) => {
        if (status) status.textContent = errorText(error, localeOf(root));
      }).finally(() => {
        form.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select")
          .forEach((control) => { control.disabled = false; });
      });
    },
  );

  root.querySelector<HTMLFormElement>("#context-preview-form")?.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const pane = root.querySelector<HTMLElement>(".conversation-pane");
      const result = root.querySelector<HTMLElement>("#context-preview-result");
      const sessionId = pane?.dataset.activeSession ?? "";
      const files = Array.from(
        (form.elements.namedItem("files") as HTMLInputElement | null)?.files ?? [],
      );
      const dataClass = String(
        (form.elements.namedItem("data_class") as HTMLSelectElement | null)?.value ?? "public",
      ) as WorkDataClass;
      if (!sessionId || !result || !api.createContextPreview) return;
      if (!files.length || files.length > 16 || files.some((file) => file.size > 128_000)) {
        result.textContent = tr(
          localeOf(root),
          "Choose 1–16 UTF-8 text files, at most 128 KB each.",
          "请选择 1–16 个 UTF-8 文本文件，每个不超过 128 KB。",
        );
        return;
      }
      const totalBytes = files.reduce((total, file) => total + file.size, 0);
      if (totalBytes > 256_000) {
        result.textContent = tr(
          localeOf(root),
          "The selected context exceeds 256 KB.",
          "所选上下文超过 256 KB。",
        );
        return;
      }
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
        "input, select, button",
      ).forEach((control) => { control.disabled = true; });
      result.textContent = tr(
        localeOf(root),
        "Reading only the files you selected…",
        "正在读取你明确选择的文件…",
      );
      void Promise.all(files.map(async (file) => ({ name: file.name, content: await file.text() })))
        .then((items) => api.createContextPreview?.(sessionId, dataClass, items))
        .then((preview) => {
          if (!preview || !pane) return;
          pane.dataset.contextPreviewHash = preview.content_hash;
          pane.dataset.contextPreviewClass = preview.data_class;
          const messageClass = root.querySelector<HTMLSelectElement>(
            '#session-message-form [name="data_class"]',
          );
          if (messageClass) messageClass.value = preview.data_class;
          const heading = document.createElement("p");
          heading.className = "fine";
          heading.textContent = tr(
            localeOf(root),
            `${preview.manifest.entries.length} files · ${preview.byte_count} bytes · about ${preview.estimated_tokens} tokens · attached once`,
            `${preview.manifest.entries.length} 个文件 · ${preview.byte_count} 字节 · 约 ${preview.estimated_tokens} tokens · 单次附加`,
          );
          const filesHost = document.createElement("div");
          filesHost.className = "context-preview-files";
          for (const entry of preview.manifest.entries) {
            const card = document.createElement("article");
            const name = document.createElement("strong");
            name.textContent = entry.name;
            const metadata = document.createElement("small");
            metadata.textContent = `${entry.byte_count} B · ${entry.content_hash.slice(0, 12)}…`;
            const excerpt = document.createElement("pre");
            excerpt.textContent = entry.content.slice(0, 1_200);
            card.append(name, metadata, excerpt);
            filesHost.append(card);
          }
          result.replaceChildren(heading, filesHost);
        })
        .catch((error) => {
          result.textContent = errorText(error, localeOf(root));
        })
        .finally(() => {
          form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
            "input, select, button",
          ).forEach((control) => { control.disabled = false; });
        });
    },
  );

  const messageForm = root.querySelector<HTMLFormElement>("#session-message-form");
  const messageText = messageForm?.querySelector<HTMLTextAreaElement>("textarea");
  messageText?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      messageForm?.requestSubmit();
    }
  });
  messageForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const pane = root.querySelector<HTMLElement>(".conversation-pane");
    const wait = root.querySelector<HTMLElement>("#conversation-wait");
    const sessionId = pane?.dataset.activeSession ?? "";
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const content = String(data.get("content") ?? "").trim();
    const dataClass = String(data.get("data_class") ?? "public") as WorkDataClass;
    const contextPreviewHash = pane?.dataset.contextPreviewHash ?? null;
    const contextPreviewClass = pane?.dataset.contextPreviewClass;
    const activeProfileId = snapshot.workspaceV2?.sessions.find(
      (session) => session.session_id === sessionId,
    )?.profile_id ?? pane?.dataset.activeProfile ?? "safe-mode";
    if (!sessionId || !content || (!api.sendSessionMessage && !api.createConversationTurn)) return;
    if (contextPreviewHash && contextPreviewClass !== dataClass) {
      announceError(root, tr(
        localeOf(root),
        "The message data class must match the attached context preview.",
        "消息的数据分类必须与附加的上下文预览一致。",
      ));
      return;
    }
    form.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>(
      "button, textarea, select",
    ).forEach((control) => { control.disabled = true; });
    const modelBacked = activeProfileId !== "safe-mode";
    const restoreComposer = (): void => {
      if (wait) {
        wait.innerHTML = "";
        wait.removeAttribute("aria-busy");
      }
      form.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>(
        "button, textarea, select",
      ).forEach((control) => { control.disabled = false; });
      messageText?.focus();
    };
    const reloadMessages = (): Promise<void> => selectSession(
      sessionId,
      root.querySelector<HTMLElement>("#conversation-title")?.textContent ?? "",
      activeProfileId,
    );
    if (
      modelBacked
      && api.createConversationTurn
      && api.streamConversationOperation
      && api.cancelConversationOperation
    ) {
      conversationStreams.get(root)?.controller.abort();
      if (wait) {
        wait.setAttribute("aria-busy", "true");
        wait.innerHTML = conversationOperationWaitMarkup("queued", localeOf(root));
      }
      void api.createConversationTurn(
        sessionId,
        content,
        dataClass,
        contextPreviewHash,
      ).then((created) => {
        form.reset();
        if (pane) {
          delete pane.dataset.contextPreviewHash;
          delete pane.dataset.contextPreviewClass;
        }
        const operationId = created.operation.operation_id;
        const controller = new AbortController();
        conversationStreams.set(root, { controller, operationId });
        const showPhase = (phase: string, canCancel = true): void => {
          if (!wait) return;
          wait.innerHTML = conversationOperationWaitMarkup(phase, localeOf(root), canCancel);
          const stop = wait.querySelector<HTMLButtonElement>("[data-conversation-cancel]");
          stop?.addEventListener("click", () => {
            stop.disabled = true;
            wait.innerHTML = conversationOperationWaitMarkup(
              "cancelling",
              localeOf(root),
              false,
            );
            void api.cancelConversationOperation?.(operationId).catch((error) => {
              announceError(root, errorText(error, localeOf(root)));
            });
          });
        };
        showPhase(created.operation.phase || "queued");
        return api.streamConversationOperation?.(
          operationId,
          0,
          (operationEvent) => {
            if (operationEvent.type === "conversation.model_started") showPhase("model");
            if (operationEvent.type === "conversation.validating") showPhase("validating");
            if (operationEvent.type === "conversation.cancel_requested") {
              showPhase("cancelling", false);
            }
            if (operationEvent.type === "conversation.cancelled") {
              showPhase("cancelled", false);
            }
            if (operationEvent.type === "conversation.failed") {
              showPhase("failed", false);
            }
          },
          controller.signal,
        );
      }).then(() => reloadMessages()).catch((error) => {
        announceError(root, errorText(error, localeOf(root)));
        return reloadMessages();
      }).finally(() => {
        conversationStreams.get(root)?.controller.abort();
        conversationStreams.delete(root);
        restoreComposer();
      });
      return;
    }
    if (wait) {
      wait.setAttribute("aria-busy", "true");
      wait.innerHTML = `<div class="conversation-wait"><i></i><span>${modelBacked
        ? tr(localeOf(root), "Waiting for the configured model · tools remain off…", "正在等待已配置的模型 · 工具仍保持关闭…")
        : tr(localeOf(root), "Saving this message to the local session…", "正在将消息保存到本地会话…")}</span></div>`;
    }
    if (!api.sendSessionMessage) {
      restoreComposer();
      return;
    }
    void api.sendSessionMessage(sessionId, content, dataClass).then(() => {
      form.reset();
      return reloadMessages();
    }).catch((error) => {
      announceError(root, errorText(error, localeOf(root)));
      return reloadMessages();
    }).finally(restoreComposer);
  });

  root.querySelector<HTMLFormElement>("#proposal-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const pane = root.querySelector<HTMLElement>(".conversation-pane");
    const sessionId = pane?.dataset.activeSession ?? "";
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const mode = String(data.get("mode") ?? "research") as Mode;
    const goal = String(data.get("goal") ?? "").trim();
    const preview = root.querySelector<HTMLElement>("#proposal-preview");
    if (!sessionId || !goal || !api.createSessionProposal || !preview) return;
    form.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
      "button, input, select",
    ).forEach((control) => { control.disabled = true; });
    preview.innerHTML = `<div class="conversation-wait"><i></i><span>${tr(localeOf(root), "Preparing a run preview on this device…", "正在这台设备上准备运行预览…")}</span></div>`;
    void api.createSessionProposal(sessionId, mode, goal).then((proposal) => {
      preview.innerHTML = runProposalMarkup(proposal, localeOf(root));
    }).catch((error) => {
      preview.innerHTML = `<p class="empty">${escapeStatus(errorText(error, localeOf(root)))}</p>`;
    }).finally(() => {
      form.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
        "button, input, select",
      ).forEach((control) => { control.disabled = false; });
    });
  });

  root.querySelector<HTMLFormElement>("#tool-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const pane = root.querySelector<HTMLElement>(".conversation-pane");
    const sessionId = pane?.dataset.activeSession ?? "";
    const query = String(new FormData(event.currentTarget as HTMLFormElement).get("query") ?? "").trim();
    const host = root.querySelector<HTMLElement>("#tool-search-results");
    if (!sessionId || !query || !host || !api.searchSessionTools) return;
    host.innerHTML = `<div class="conversation-wait"><i></i><span>${tr(localeOf(root), "Searching this conversation's tools…", "正在搜索本次对话可用的工具…")}</span></div>`;
    void api.searchSessionTools(sessionId, query).then((result) => {
      host.innerHTML = toolSearchMarkup(result, localeOf(root));
      bindToolPreview(root, api, host, sessionId);
    }).catch((error) => { host.textContent = errorText(error, localeOf(root)); });
  });

  root.querySelector<HTMLFormElement>("#personal-settings-form")?.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const version = Number(form.dataset.version ?? "0");
      const status = form.querySelector<HTMLElement>("#personal-settings-status");
      if (!api.savePersonalSettings) return;
      const settings = {
        display_name: String(data.get("display_name") ?? "").trim() || undefined,
        locale: String(data.get("locale") ?? "") || undefined,
        timezone: String(data.get("timezone") ?? "").trim() || undefined,
        week_start: "monday",
        theme: String(data.get("theme") ?? "system"),
      };
      if (status) status.textContent = tr(localeOf(root), "Saving locally…", "正在保存到本地…");
      // Apply before the round trip so the control is not a placebo if the save
      // is slow; the reconciliation below corrects it if Core stored something else.
      applyTheme(settings.theme);
      void api.savePersonalSettings(version || null, settings).then((record) => {
        if (snapshot.workspaceV2) snapshot.workspaceV2.personal = record;
        const savedLocale = record.settings?.locale;
        if (isLocale(savedLocale)) {
          persistLocale(savedLocale);
          applyLocale(root, savedLocale);
        }
        applyTheme(record.settings?.theme);
        renderWorkspace(root, api, snapshot);
        selectView(root, "settings");
        announceStatus(root, tr(
          localeOf(root),
          "Name, language, and appearance were saved on this device.",
          "称呼、语言与外观已保存在本设备。",
        ));
      }).catch((error) => {
        if (status) status.textContent = errorText(error, localeOf(root));
      });
    },
  );

  root.querySelector<HTMLButtonElement>("[data-update-recovery]")?.addEventListener(
    "click",
    () => {
      const host = root.querySelector<HTMLElement>("#update-recovery-results");
      if (!host) return;
      const bridge = detectDesktopBridge();
      if (!bridge) {
        host.textContent = tr(
          localeOf(root),
          "Open Settings in the desktop app to inspect verified recovery copies.",
          "请在桌面应用的设置中查看已验证恢复副本。",
        );
        return;
      }
      host.textContent = tr(localeOf(root), "Reading the private recovery ledger…", "正在读取私有恢复记录…");
      void bridge.recovery().then((artifacts) => {
        host.innerHTML = artifacts.map((artifact) => `<article>`
          + `<strong>Restork ${escapeStatus(artifact.version)}</strong>`
          + `<span>${escapeStatus(artifact.target)}</span>`
          + `<small>SHA-256 ${escapeStatus(artifact.sha256.slice(0, 16))}…</small>`
          + `<code>${escapeStatus(artifact.filename)}</code></article>`).join("")
          || `<p class="empty">${tr(localeOf(root), "No previous verified updater package is retained yet.", "暂时还没有保留过已验证更新包。")}</p>`;
      }).catch((error) => {
        host.textContent = errorText(error, localeOf(root));
      });
    },
  );

  const providerForm = root.querySelector<HTMLFormElement>("#provider-profile-form");
  root.querySelector<HTMLSelectElement>('#provider-profile-form [name="kind"]')
    ?.addEventListener("change", (event) => {
      const select = event.currentTarget as HTMLSelectElement;
      const kind = select.value;
      const selected = select.selectedOptions[0];
      const form = root.querySelector<HTMLFormElement>("#provider-profile-form");
      const baseUrl = form?.elements.namedItem("base_url") as HTMLInputElement | null;
      const secretRef = form?.elements.namedItem("secret_ref") as HTMLInputElement | null;
      const secretButton = form?.querySelector<HTMLButtonElement>("[data-provider-secret-configure]");
      const secretStatus = form?.querySelector<HTMLElement>("[data-provider-secret-status]");
      const authKind = selected?.dataset.authKind ?? (kind === "ollama" ? "none" : "bearer");
      const registryBaseUrl = selected?.dataset.baseUrl;
      if (baseUrl && registryBaseUrl) baseUrl.value = registryBaseUrl;
      if (authKind === "none") {
        if (secretRef) {
          secretRef.value = "";
          secretRef.disabled = true;
        }
        if (secretButton) secretButton.disabled = true;
        if (secretStatus) secretStatus.textContent = tr(
          localeOf(root),
          "Local Ollama needs no API key",
          "本地 Ollama 无需 API Key",
        );
      } else {
        if (secretRef) secretRef.disabled = false;
        if (secretButton) secretButton.disabled = false;
        if (secretStatus && !secretRef?.value) secretStatus.textContent = tr(
          localeOf(root),
          "Not saved on this device",
          "尚未保存在这台设备上",
        );
      }
      if (form) {
        syncProviderModelControls(form, selected?.dataset.defaultModel);
        syncReasoningControls(form);
      }
    });
  providerForm?.querySelector<HTMLSelectElement>("[data-provider-model-select]")
    ?.addEventListener("change", (event) => {
      const hidden = providerForm.elements.namedItem("model") as HTMLInputElement | null;
      if (hidden) hidden.value = (event.currentTarget as HTMLSelectElement).value;
    });
  providerForm?.querySelector<HTMLInputElement>("[data-provider-custom-model]")
    ?.addEventListener("input", (event) => {
      const hidden = providerForm.elements.namedItem("model") as HTMLInputElement | null;
      if (hidden) hidden.value = (event.currentTarget as HTMLInputElement).value;
    });
  providerForm?.querySelector<HTMLSelectElement>('[name="reasoning_effort"]')
    ?.addEventListener("change", () => syncReasoningControls(providerForm));
  if (providerForm) {
    syncProviderModelControls(providerForm);
    syncReasoningControls(providerForm);
  }

  providerForm?.querySelector<HTMLButtonElement>("[data-provider-secret-configure]")
    ?.addEventListener("click", (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const kind = providerForm.elements.namedItem("kind") as HTMLSelectElement | null;
      const secretRef = providerForm.elements.namedItem("secret_ref") as HTMLInputElement | null;
      const status = providerForm.querySelector<HTMLElement>("[data-provider-secret-status]");
      const bridge = detectDesktopBridge();
      if (!kind || kind.value === "ollama") return;
      if (!bridge) {
        if (status) status.textContent = tr(
          localeOf(root),
          "Open Restork Desktop to use the secure system prompt.",
          "请在 Restork 桌面版中使用系统安全输入框。",
        );
        return;
      }
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      if (status) status.textContent = tr(
        localeOf(root),
        "Waiting for the system credential prompt…",
        "正在等待系统凭据弹窗…",
      );
      void bridge.configureProviderSecret(kind.value).then((result) => {
        if (result.status === "cancelled") {
          if (status) status.textContent = tr(localeOf(root), "Nothing changed.", "没有更改任何内容。");
          return;
        }
        if (secretRef) secretRef.value = result.secretRef;
        if (status) status.textContent = tr(
          localeOf(root),
          "Saved securely. No model request was sent.",
          "已安全保存；尚未发送任何模型请求。",
        );
      }).catch((error: unknown) => {
        if (status) status.textContent = friendlyNativeSetupError(error, localeOf(root));
      }).finally(() => {
        if (root.contains(button)) {
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }
      });
    });

  root.querySelectorAll<HTMLButtonElement>("[data-provider-profile-test]").forEach((button) => {
    button.addEventListener("click", () => {
      void runProviderProfileDiagnostic(root, api, button);
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-provider-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const form = root.querySelector<HTMLFormElement>("#provider-profile-form");
      if (!form) return;
      try {
        const record = JSON.parse(button.dataset.providerRecord ?? "{}") as {
          revision: number;
          provider: Record<string, unknown>;
        };
        form.dataset.version = String(record.revision);
        for (const name of ["profile_id", "display_name", "kind", "base_url", "model", "secret_ref"]) {
          const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
          if (field) field.value = String(record.provider[name] ?? "");
        }
        syncProviderModelControls(form, String(record.provider.model ?? ""));
        const reasoning = record.provider.reasoning as
          | { effort?: string; max_tokens?: number | null }
          | undefined;
        const effort = form.elements.namedItem("reasoning_effort") as HTMLSelectElement | null;
        const budget = form.elements.namedItem("reasoning_max_tokens") as HTMLInputElement | null;
        if (effort) effort.value = reasoning?.effort ?? "auto";
        if (budget) budget.value = reasoning?.max_tokens ? String(reasoning.max_tokens) : "";
        const secret = form.elements.namedItem("secret_ref") as HTMLInputElement | null;
        if (secret) secret.disabled = record.provider.kind === "ollama";
        syncReasoningControls(form);
        const id = form.elements.namedItem("profile_id") as HTMLInputElement | null;
        if (id) id.readOnly = true;
        form.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {
        announceError(root, tr(localeOf(root), "Provider record could not be opened.", "无法打开此供应商记录。"));
      }
    });
  });

  root.querySelector<HTMLFormElement>("#provider-profile-form")?.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const expected = Number(form.dataset.version ?? "0") || null;
      const kind = String(data.get("kind") ?? "deepseek") as
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
      const secretRef = String(data.get("secret_ref") ?? "").trim() || null;
      const reasoningEffort = String(data.get("reasoning_effort") ?? "auto") as ReasoningEffortV2;
      const reasoningBudget = String(data.get("reasoning_max_tokens") ?? "").trim();
      const status = form.querySelector<HTMLElement>("#provider-profile-status");
      if (!api.saveProviderProfile) return;
      if (kind !== "ollama" && !secretRef) {
        if (status) status.textContent = tr(
          localeOf(root),
          "Choose a native secret reference; never paste the API key here.",
          "请选择原生密钥引用；不要在这里粘贴 API Key。",
        );
        return;
      }
      if (status) status.textContent = tr(localeOf(root), "Validating locally…", "正在本地校验…");
      void api.saveProviderProfile(expected, {
        profile_id: String(data.get("profile_id") ?? "").trim(),
        version: (expected ?? 0) + 1,
        display_name: String(data.get("display_name") ?? "").trim(),
        kind,
        base_url: String(data.get("base_url") ?? "").trim(),
        model: String(data.get("model") ?? "").trim(),
        secret_ref: kind === "ollama" ? null : secretRef,
        fallback: "disabled",
        reasoning: {
          effort: reasoningEffort,
          max_tokens: reasoningBudget ? Number(reasoningBudget) : null,
        },
      }).then(() => reloadWorkspaceView(root, api, "settings")).catch((error) => {
        if (status) status.textContent = errorText(error, localeOf(root));
      });
    },
  );

  root.querySelector<HTMLFormElement>("#prompt-revision-form")?.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const promptId = String(data.get("prompt_id") ?? "").trim();
      const expected = promptId === "personal"
        ? Number(form.dataset.version ?? "0") || null
        : null;
      const layer = String(data.get("layer") ?? "personal") as "skill" | "personal";
      const content = String(data.get("content") ?? "");
      const status = form.querySelector<HTMLElement>("#prompt-revision-status");
      if (!api.createPromptRevision) return;
      if (status) status.textContent = tr(localeOf(root), "Saving an immutable revision…", "正在保存不可变修订…");
      void api.createPromptRevision(promptId, expected, layer, content)
        .then(() => reloadWorkspaceView(root, api, "settings"))
        .catch((error) => {
          if (status) status.textContent = errorText(error, localeOf(root));
        });
    },
  );

  root.querySelectorAll<HTMLButtonElement>("[data-prompt-activate]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!api.activatePromptRevision) return;
      const promptId = button.dataset.promptId ?? "";
      const revision = Number(button.dataset.promptActivate ?? "0");
      const active = Number(button.dataset.activeRevision ?? "0") || null;
      button.disabled = true;
      void api.activatePromptRevision(promptId, revision, active)
        .then(() => reloadWorkspaceView(root, api, "settings"))
        .catch((error) => {
          button.disabled = false;
          announceError(root, errorText(error, localeOf(root)));
        });
    });
  });

  root.querySelector<HTMLFormElement>("#configuration-profile-form")?.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const expected = Number(form.dataset.version ?? "0") || null;
      const promptHash = form.dataset.promptHash ?? "";
      const status = form.querySelector<HTMLElement>("#configuration-profile-status");
      if (!api.saveConfigurationProfile || promptHash.length !== 64) return;
      const profileId = String(data.get("profile_id") ?? "").trim();
      if (status) status.textContent = tr(localeOf(root), "Preparing this run setup…", "正在准备这份运行配置…");
      void api.saveConfigurationProfile(expected, {
        profile_id: profileId,
        version: (expected ?? 0) + 1,
        name: String(data.get("name") ?? "").trim(),
        provider_profile_id: String(data.get("provider_profile_id") ?? "").trim(),
        prompt_manifest_hash: promptHash,
        enabled_skill_ids: commaList(data.get("enabled_skill_ids")),
        allowed_tools: commaList(data.get("allowed_tools")),
        memory_namespace: profileId,
        maximum_data_class: String(data.get("maximum_data_class") ?? "public") as WorkDataClass,
        include_display_name_in_prompt: data.get("include_display_name_in_prompt") === "on",
      }).then(() => reloadWorkspaceView(root, api, "settings")).catch((error) => {
        if (status) status.textContent = errorText(error, localeOf(root));
      });
    },
  );

  configureExtensionCenter(root, api, snapshot);
  configureDeliverables(root, api, snapshot, {
    confirm: (message, detail) => confirmAction(root, message, detail),
    error: (message) => announceError(root, message),
    reload: () => reloadWorkspaceView(root, api, "deliverables"),
    status: (message) => announceStatus(root, message),
  });
  configureAutomation(root, api, snapshot, {
    announceError: (message) => announceError(root, message),
    announceStatus: (message) => announceStatus(root, message),
    confirm: (message) => confirmAction(root, message),
    reload: () => reloadWorkspaceView(root, api, "automation"),
  });

  // Restore the user's own selection. Falling back to the first active session is
  // only correct when the user has not chosen one, or their choice is gone.
  const sessions = snapshot.workspaceV2.sessions;
  const remembered = selectedSessions.get(root);
  const restored = remembered
    ? sessions.find((session) => session.session_id === remembered)
    : undefined;
  const target = restored ?? sessions.find((session) => session.status === "active");
  if (target) void selectSession(target.session_id, target.title, target.profile_id);
  else selectedSessions.delete(root);
}

function bindToolPreview(
  root: HTMLElement,
  api: DashboardApi,
  host: HTMLElement,
  sessionId: string,
): void {
  host.querySelectorAll<HTMLButtonElement>("[data-tool-preview]").forEach((button) => {
    button.addEventListener("click", () => {
      const toolId = button.dataset.toolPreview ?? "";
      if (!toolId || !api.previewSessionToolCall) return;
      button.disabled = true;
      void api.previewSessionToolCall(sessionId, toolId, {}).then((preview) => {
        host.innerHTML = toolCallPreviewMarkup(preview, localeOf(root));
        const execute = host.querySelector<HTMLButtonElement>("[data-tool-execute]");
        execute?.addEventListener("click", async () => {
          if (!api.executeSessionToolCall) return;
          const confirmed = await confirmAction(root, tr(
            localeOf(root),
            `Run ${preview.resolved_call.real_tool_id} with the input shown above?`,
            `使用上面显示的输入运行 ${preview.resolved_call.real_tool_id}？`,
          ));
          if (!confirmed) return;
          execute.disabled = true;
          execute.textContent = tr(localeOf(root), "RUNNING IN SANDBOX…", "正在沙箱中运行…");
          void api.executeSessionToolCall(sessionId, preview).then((execution) => {
            const untrusted = tr(
              localeOf(root),
              "Tool output is reference material, not a permission grant.",
              "工具输出只能作为参考，不会因此获得新权限。",
            );
            host.innerHTML = `<article class="proposal-card"><header>`
              + `<strong>${tr(localeOf(root), "MCP execution", "MCP 执行")}</strong>`
              + `<span>${escapeMarkup(execution.state)}</span></header>`
              + `<p>${untrusted}</p>`
              + `<pre>${escapeMarkup(JSON.stringify(execution, null, 2))}</pre></article>`;
          }).catch((error) => {
            execute.disabled = false;
            execute.textContent = tr(localeOf(root), "APPROVE & RUN", "批准并运行");
            announceError(root, errorText(error, localeOf(root)));
          });
        });
      }).catch((error) => {
        button.disabled = false;
        announceError(root, errorText(error, localeOf(root)));
      });
    });
  });
}

function configureExtensionCenter(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
): void {
  root.querySelectorAll<HTMLButtonElement>("[data-core-skill-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.coreSkillMode;
      if (mode === "research" || mode === "study" || mode === "work") {
        openRunForm(root, mode, button, snapshot);
      }
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-core-skill-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const view = button.dataset.coreSkillView;
      if (view) {
        selectView(root, view);
        const heading = root.querySelector<HTMLElement>(`[data-view-panel="${view}"] h2`);
        if (heading) {
          heading.tabIndex = -1;
          heading.focus();
        }
      }
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-extension-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.extensionFilter ?? "all";
      root.querySelectorAll<HTMLButtonElement>("[data-extension-filter]")
        .forEach((item) => {
          const selected = item === button;
          item.classList.toggle("is-active", selected);
          item.setAttribute("aria-pressed", String(selected));
          item.tabIndex = selected ? 0 : -1;
        });
      root.querySelectorAll<HTMLElement>("[data-extension-card-kind]").forEach((card) => {
        card.hidden = kind !== "all" && card.dataset.extensionCardKind !== kind;
      });
    });
  });
  root.querySelector<HTMLFormElement>("#extension-install-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const status = form.querySelector<HTMLElement>("#extension-install-status");
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!api.previewExtensionInstall || !api.installExtension || !status) return;
    let manifest: Record<string, unknown>;
    try {
      const input = form.elements.namedItem("manifest_file");
      const file = input instanceof HTMLInputElement ? input.files?.[0] : null;
      if (!(file instanceof File) || file.size === 0 || file.size > 2_000_000) throw new Error();
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      manifest = parsed as Record<string, unknown>;
    } catch {
      if (status) status.textContent = tr(localeOf(root), "Choose a valid extension manifest file no larger than 2 MB.", "请选择一个不超过 2 MB 的有效扩展清单文件。");
      return;
    }
    const packageKind = String(data.get("package_kind") ?? "skill") as
      | "skill"
      | "mcp"
      | "plugin";
    if (submit) submit.disabled = true;
    status.textContent = tr(
      localeOf(root),
      "Validating the manifest without installing it…",
      "正在验证清单，尚未开始安装…",
    );
    void api.previewExtensionInstall(packageKind, manifest).then((preview) => {
      status.replaceChildren();
      const card = document.createElement("article");
      card.className = "extension-install-preview";
      const title = document.createElement("strong");
      title.textContent = tr(
        localeOf(root),
        "Review the install details",
        "查看安装内容",
      );
      const explanation = document.createElement("p");
      explanation.textContent = tr(
        localeOf(root),
        "Nothing has been installed. Confirm this immutable digest to create a quarantined package.",
        "尚未安装任何内容。确认这份不可变摘要后，才会创建隔离中的扩展。",
      );
      const digest = document.createElement("code");
      digest.textContent = `SHA-256 · ${preview.preview_digest}`;
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = tr(localeOf(root), "Technical details", "技术详情");
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(preview.preview, null, 2);
      details.append(summary, pre);
      const approve = document.createElement("button");
      approve.type = "button";
      approve.textContent = tr(
        localeOf(root),
        "INSTALL REVIEWED VERSION",
        "安装已核验版本",
      );
      approve.addEventListener("click", async () => {
        const confirmed = await confirmAction(
          root,
          tr(
            localeOf(root),
            "Install this manifest in quarantine? It will stay off until you enable it separately.",
            "将这份清单安装到隔离区？另行启用前，它不会运行。",
          ),
          preview.preview_digest,
        );
        if (!confirmed) return;
        approve.disabled = true;
        approve.textContent = tr(localeOf(root), "INSTALLING…", "正在安装…");
        void api.installExtension?.(packageKind, manifest, preview.preview_digest)
          .then(() => reloadWorkspaceView(root, api, "extensions"))
          .catch((error) => {
            approve.disabled = false;
            approve.textContent = tr(
              localeOf(root),
              "INSTALL REVIEWED VERSION",
              "安装已核验版本",
            );
            announceError(root, errorText(error, localeOf(root)));
          });
      });
      card.append(title, explanation, digest, details, approve);
      status.append(card);
    }).catch((error) => {
      status.textContent = errorText(error, localeOf(root));
    }).finally(() => {
      if (submit) submit.disabled = false;
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-extension-state]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.extensionState as "enable" | "disable";
      const packageId = button.dataset.extensionId ?? "";
      const hash = button.dataset.extensionHash ?? "";
      if (!packageId || !hash || !api.setExtensionState) return;
      if (action === "enable") {
        const confirmed = await confirmAction(
          root,
          tr(localeOf(root), `Enable the verified version of ${packageId}?`, `启用已经核验的 ${packageId} 版本？`),
          hash,
        );
        if (!confirmed) return;
      }
      button.disabled = true;
      void api.setExtensionState(packageId, action, hash)
        .then(() => reloadWorkspaceView(root, api, "extensions"))
        .catch((error) => { button.disabled = false; announceError(root, errorText(error, localeOf(root))); });
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-extension-history]").forEach((button) => {
    button.addEventListener("click", () => {
      const packageId = button.dataset.extensionId ?? "";
      const currentHash = button.dataset.extensionHash ?? "";
      const host = button.closest("article")?.querySelector<HTMLElement>("[data-extension-history-results]");
      if (!packageId || !currentHash || !host || !api.extensionRevisions) return;
      button.disabled = true;
      host.textContent = tr(localeOf(root), "Loading immutable versions…", "正在加载不可变版本…");
      void api.extensionRevisions(packageId).then((records) => {
        host.replaceChildren();
        for (const record of records) {
          if (!record.manifest_hash) continue;
          const row = document.createElement("article");
          const label = document.createElement("strong");
          label.textContent = `${record.manifest_hash.slice(0, 16)}…`;
          const meta = document.createElement("small");
          meta.textContent = `${record.state} · ${new Date(record.updated_at).toLocaleString()}`;
          row.append(label, meta);
          if (record.manifest_hash !== currentHash && api.rollbackExtension) {
            const rollback = document.createElement("button");
            rollback.type = "button";
            rollback.textContent = tr(localeOf(root), "VIEW ROLLBACK", "查看回滚内容");
            rollback.addEventListener("click", async () => {
              const confirmed = await confirmAction(
                root,
                tr(localeOf(root), "Create this rollback record? It will not run a tool.", "创建这条回滚记录？它不会运行工具。"),
                record.manifest_hash ?? "",
              );
              if (!confirmed) return;
              rollback.disabled = true;
              void api.rollbackExtension?.(packageId, currentHash, record.manifest_hash ?? "")
                .then(() => reloadWorkspaceView(root, api, "extensions"))
                .catch((error) => {
                  rollback.disabled = false;
                  announceError(root, errorText(error, localeOf(root)));
                });
            });
            row.append(rollback);
          }
          host.append(row);
        }
        if (!host.childElementCount) {
          host.textContent = tr(localeOf(root), "No verified older version is installed.", "没有已安装且通过验证的旧版本。");
        }
      }).catch((error) => {
        host.textContent = errorText(error, localeOf(root));
      }).finally(() => { button.disabled = false; });
    });
  });
  root.querySelector<HTMLFormElement>("#extension-tool-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const sessionId = String(data.get("session_id") ?? "");
    const query = String(data.get("query") ?? "").trim();
    const host = form.querySelector<HTMLElement>("#extension-tool-results");
    if (!sessionId || !query || !host || !api.searchSessionTools) return;
    host.innerHTML = `<p class="fine">${tr(localeOf(root), "Searching available tools…", "正在搜索可用工具…")}</p>`;
    void api.searchSessionTools(sessionId, query).then((result) => {
      host.innerHTML = toolSearchMarkup(result, localeOf(root));
      bindToolPreview(root, api, host, sessionId);
    }).catch((error) => { host.textContent = errorText(error, localeOf(root)); });
  });
}


function safeFilename(value: string): string {
  return value.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "conversation";
}

function boundedForkTitle(sourceTitle: string, profileId: string): string {
  const suffix = ` · ${profileId}`;
  let title = sourceTitle.trim();
  const encoder = new TextEncoder();
  while (title && encoder.encode(`${title}${suffix}`).byteLength > 240) {
    title = title.slice(0, -1);
  }
  return `${title || "Conversation"}${suffix}`;
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function commaList(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function reloadWorkspaceView(
  root: HTMLElement,
  api: DashboardApi,
  view: string,
): Promise<void> {
  const snapshot = await api.loadDashboard();
  renderWorkspace(root, api, snapshot);
  selectView(root, view);
}

function escapeStatus(value: string): string {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

interface OverviewProviderSelection {
  value: string;
  profileId: string;
  kind: ProviderKindV2;
  model: string;
  displayName: string;
  authKind: "none" | "bearer";
  setupCommand: string;
  configured: boolean;
}

function overviewProviderSelection(root: HTMLElement): OverviewProviderSelection | null {
  const selector = root.querySelector<HTMLSelectElement>("[data-provider-selector]");
  const option = selector?.selectedOptions[0];
  if (!selector || !option) return null;
  return {
    value: selector.value,
    profileId: option.dataset.providerProfileId ?? "",
    kind: (option.dataset.providerKind ?? "deepseek") as ProviderKindV2,
    model: option.dataset.providerModel ?? "",
    displayName: option.dataset.providerName ?? option.textContent ?? "Provider",
    authKind: option.dataset.providerAuthKind === "none" ? "none" : "bearer",
    setupCommand: option.dataset.providerSetupCommand
      ?? overviewProviderCommand((option.dataset.providerKind ?? "deepseek") as ProviderKindV2),
    configured: option.dataset.providerConfigured === "true",
  };
}

function overviewProviderCommand(kind: ProviderKindV2): string {
  return kind === "ollama"
    ? "ollama serve"
    : `restorkd provider configure ${kind}`;
}

function bindProviderDiagnosticDismiss(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(
    "#provider-diagnostic-result, [data-provider-profile-result]",
  ).forEach((host) => {
    host.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const dismiss = target.closest<HTMLButtonElement>("[data-provider-diagnostic-dismiss]");
      if (!dismiss || !host.contains(dismiss)) return;
      const profileCard = host.closest<HTMLElement>("[data-provider-profile-card]");
      const returnFocus = profileCard?.querySelector<HTMLButtonElement>("[data-provider-profile-test]")
        ?? root.querySelector<HTMLButtonElement>('[data-provider-diagnostic="smoke"]');
      host.replaceChildren();
      if (!host.hasAttribute("data-provider-profile-result")) {
        const placeholder = document.createElement("p");
        placeholder.textContent = tr(
          localeOf(root),
          "Test result closed. Run another check whenever you need it.",
          "测试结果已关闭，需要时可以重新测试。",
        );
        host.append(placeholder);
      }
      returnFocus?.focus();
    });
  });
}

function setOverviewProviderActionAvailability(root: HTMLElement): void {
  const selected = overviewProviderSelection(root);
  root.querySelectorAll<HTMLButtonElement>("[data-provider-diagnostic]").forEach((button) => {
    button.disabled = !selected?.configured;
  });
}

function syncOverviewProvider(
  root: HTMLElement,
  snapshot: DashboardSnapshot,
): void {
  const selected = overviewProviderSelection(root);
  if (!selected) return;
  root.dataset.providerOverviewSelection = selected.value;
  const locale = localeOf(root);
  const title = root.querySelector<HTMLElement>("[data-provider-selected-name]");
  const model = root.querySelector<HTMLElement>("[data-provider-selected-model]");
  const command = root.querySelector<HTMLElement>("[data-provider-command]");
  const help = root.querySelector<HTMLElement>("[data-provider-setup-help]");
  const secretButton = root.querySelector<HTMLButtonElement>("[data-provider-overview-secret]");
  const secretStatus = root.querySelector<HTMLElement>("[data-provider-overview-secret-status]");
  const summary = root.querySelector<HTMLElement>("[data-provider-summary]");
  const result = root.querySelector<HTMLElement>("#provider-diagnostic-result");
  const manage = root.querySelector<HTMLButtonElement>("[data-open-provider-settings]");
  if (title) title.textContent = selected.configured
    ? selected.displayName
    : tr(locale, `Configure ${selected.displayName}`, `配置 ${selected.displayName}`);
  if (model) model.textContent = selected.configured
    ? `${selected.kind} / ${selected.model}`
    : tr(locale, "No model saved", "尚未保存模型");
  if (command) command.textContent = selected.setupCommand;
  if (help) help.textContent = selected.kind === "ollama"
    ? tr(
      locale,
      "No API key is needed. Start Ollama locally, then save the local model setup.",
      "无需 API Key。请先在本机启动 Ollama，再保存本地模型配置。",
    )
    : tr(
      locale,
      "The native prompt saves the key without testing the model or starting a paid request.",
      "原生弹窗只负责保存 Key，不会测试模型，也不会产生计费请求。",
    );
  if (secretButton) secretButton.disabled = selected.kind === "ollama";
  if (secretStatus) secretStatus.textContent = selected.kind === "ollama"
    ? tr(locale, "Local Ollama needs no API key.", "本地 Ollama 无需 API Key。")
    : tr(locale, "The browser never receives it.", "浏览器永远不会接收到 Key。");
  const matchingReport = selected.configured
    && snapshot.provider?.provider === selected.profileId
      ? snapshot.provider
      : null;
  if (summary) {
    const status = matchingReport?.status
      ?? (selected.configured ? "not_tested" : "setup_required");
    summary.dataset.providerSummary = status;
    summary.textContent = status.replaceAll("_", " ");
  }
  if (result) {
    result.innerHTML = matchingReport
      ? providerDiagnosticMarkup(matchingReport, locale)
      : `<p>${escapeStatus(selected.configured
        ? tr(locale, "Run Test model to check this saved model.", "请点击“测试模型”检查这个已保存的模型。")
        : tr(locale, "Open Settings to choose a model and save this provider.", "请打开设置，选择模型并保存这个供应商。"))}</p>`;
  }
  if (manage) manage.textContent = selected.configured
    ? tr(locale, "MANAGE MODELS", "管理模型")
    : tr(locale, "CONFIGURE PROVIDER", "配置供应商");
  setOverviewProviderActionAvailability(root);
}

function configureProvider(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
): void {
  const selector = root.querySelector<HTMLSelectElement>("[data-provider-selector]");
  const remembered = root.dataset.providerOverviewSelection;
  if (selector && remembered && Array.from(selector.options).some((option) => option.value === remembered)) {
    selector.value = remembered;
  }
  syncOverviewProvider(root, snapshot);
  selector?.addEventListener("change", () => syncOverviewProvider(root, snapshot));
  root.querySelector<HTMLButtonElement>("[data-provider-overview-secret]")?.addEventListener(
    "click",
    (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const selected = overviewProviderSelection(root);
      const status = root.querySelector<HTMLElement>("[data-provider-overview-secret-status]");
      const bridge = detectDesktopBridge();
      if (!selected || selected.kind === "ollama") return;
      if (!bridge) {
        if (status) status.textContent = tr(
          localeOf(root),
          "Open Restork Desktop, or expand the source-build command below.",
          "请使用 Restork 桌面版，或展开下方源码运行命令。",
        );
        return;
      }
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      if (status) status.textContent = tr(
        localeOf(root),
        "Waiting for the system credential prompt…",
        "正在等待系统凭据弹窗…",
      );
      void bridge.configureProviderSecret(selected.kind).then((result) => {
        if (status) status.textContent = result.status === "saved"
          ? tr(localeOf(root), "Saved securely. Test the model when ready.", "已安全保存；准备好后再单独测试模型。")
          : tr(localeOf(root), "Nothing changed.", "没有更改任何内容。");
      }).catch((error: unknown) => {
        if (status) status.textContent = friendlyNativeSetupError(error, localeOf(root));
      }).finally(() => {
        if (root.contains(button)) {
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }
      });
    },
  );
  root.querySelector<HTMLButtonElement>("[data-open-provider-settings]")?.addEventListener(
    "click", () => {
      const selected = overviewProviderSelection(root);
      root.querySelector<HTMLButtonElement>('[data-view="settings"]')?.click();
      const kind = root.querySelector<HTMLSelectElement>('#provider-profile-form [name="kind"]');
      if (selected && kind && Array.from(kind.options).some((option) => option.value === selected.kind)) {
        kind.value = selected.kind;
        kind.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
  );
  root.querySelectorAll<HTMLButtonElement>("[data-provider-diagnostic]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.providerDiagnostic;
      void runProviderDiagnostic(
        root,
        api,
        action !== "connect",
        "primary",
      );
    });
  });
}

async function runProviderDiagnostic(
  root: HTMLElement,
  api: DashboardApi,
  smoke: boolean,
  target: "primary" | "web_search",
): Promise<void> {
  const selected = overviewProviderSelection(root);
  const host = root.querySelector<HTMLElement>("#provider-diagnostic-result");
  const buttons = root.querySelectorAll<HTMLButtonElement>("[data-provider-diagnostic]");
  if (!host || !selected?.configured || !selected.profileId) return;
  buttons.forEach((button) => { button.disabled = true; });
  host.innerHTML = providerWaitMarkup(smoke, localeOf(root), target, selected.model);
  try {
    const report = await api.providerDiagnostics(smoke, target, selected.profileId);
    if (root.contains(host)) {
      host.innerHTML = providerDiagnosticMarkup(report, localeOf(root));
      const summary = root.querySelector<HTMLElement>("[data-provider-summary]");
      if (summary) {
        summary.dataset.providerSummary = report.status;
        summary.textContent = report.status.replaceAll("_", " ");
      }
    }
  } catch (error) {
    if (root.contains(host)) {
      const activeLocale = localeOf(root);
      host.innerHTML = providerErrorMarkup(
        activeLocale,
        safeProviderFailureDetail(error, activeLocale),
      );
    }
  } finally {
    setOverviewProviderActionAvailability(root);
  }
}

async function runProviderProfileDiagnostic(
  root: HTMLElement,
  api: DashboardApi,
  trigger: HTMLButtonElement,
): Promise<void> {
  const profileId = trigger.dataset.providerProfileTest ?? "";
  const model = trigger.dataset.providerModel ?? "";
  const target = "primary";
  const card = trigger.closest<HTMLElement>("[data-provider-profile-card]");
  const host = card?.querySelector<HTMLElement>("[data-provider-profile-result]");
  if (!profileId || !model || !card || !host) return;
  const buttons = card.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  host.innerHTML = providerWaitMarkup(true, localeOf(root), target, model);
  try {
    const report = await api.providerDiagnostics(true, target, profileId);
    if (root.contains(host)) {
      host.innerHTML = providerDiagnosticMarkup(report, localeOf(root));
    }
  } catch (error) {
    if (root.contains(host)) {
      const activeLocale = localeOf(root);
      host.innerHTML = providerErrorMarkup(
        activeLocale,
        safeProviderFailureDetail(error, activeLocale),
      );
    }
  } finally {
    buttons.forEach((button) => {
      if (root.contains(button)) button.disabled = false;
    });
  }
}

function safeProviderFailureDetail(error: unknown, activeLocale: Locale): string {
  const message = errorText(error, activeLocale).toLowerCase();
  if (message.includes("invalid or expired access token") || message.includes("bearer authorization")) {
    return tr(
      activeLocale,
      "The private local session expired and could not be renewed. Restart Restork once.",
      "本地私有会话已过期且未能续期，请重启一次 Restork。",
    );
  }
  if (error instanceof TypeError || /fetch|network|connection|unreachable/.test(message)) {
    return tr(
      activeLocale,
      "The local Core was still unreachable after one retry.",
      "再次尝试后，仍无法连接本地 Core。",
    );
  }
  return tr(
    activeLocale,
    "Core rejected the request before a safe provider report was available.",
    "Core 在生成安全的模型检查报告前拒绝了请求。",
  );
}


function configureCalendar(root: HTMLElement, api: DashboardApi): void {
  bindSettingsDialog(root, "#calendar-settings-dialog", "[data-calendar-open]");
  const form = root.querySelector<HTMLFormElement>("#calendar-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveCalendar(root, api, form);
  });
  form?.querySelector<HTMLButtonElement>("[data-native-calendar-connect]")?.addEventListener(
    "click",
    () => void connectNativeCalendar(root, api, form),
  );
  form?.querySelector<HTMLButtonElement>("[data-calendar-disable]")?.addEventListener(
    "click",
    () => void disableCalendar(root, api, form),
  );
}

function configureMail(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
): void {
  bindSettingsDialog(root, "#mail-settings-dialog", "[data-mail-open]");
  root.querySelector<HTMLButtonElement>("[data-native-mail-connect]")?.addEventListener(
    "click",
    (event) => void connectNativeMail(
      root,
      api,
      event.currentTarget as HTMLButtonElement,
    ),
  );
  root.querySelector<HTMLButtonElement>("[data-native-mail-disconnect]")?.addEventListener(
    "click",
    (event) => void disconnectNativeMail(
      root,
      api,
      event.currentTarget as HTMLButtonElement,
    ),
  );
  const mail = snapshot.daily?.mail;
  if (mail?.configured && api.streamMail) startMailStream(root, api, mail);
}

async function connectNativeMail(
  root: HTMLElement,
  api: DashboardApi,
  button: HTMLButtonElement,
): Promise<void> {
  if (!api.connectNativeMail) return;
  const view = activeView(root);
  button.disabled = true;
  const status = root.querySelector<HTMLElement>("[data-mail-dialog-status]");
  if (status) {
    status.textContent = tr(
      localeOf(root),
      "Waiting for macOS permission…",
      "正在等待 macOS 权限确认…",
    );
  }
  try {
    const mail = await api.connectNativeMail();
    if (!mail.configured) {
      updateMailUi(root, mail);
      button.disabled = false;
      announceStatus(root, localizedMailStatus(mail, localeOf(root)));
      return;
    }
    await refresh(root, api, view);
    announceStatus(root, tr(
      localeOf(root),
      "Mail connected. Restork can read the unread count and unread headers; bodies stay in Mail.",
      "邮件已连接；Restork 可读取未读数量与消息头，正文仍留在邮件应用内。",
    ));
  } catch (error) {
    button.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function disconnectNativeMail(
  root: HTMLElement,
  api: DashboardApi,
  button: HTMLButtonElement,
): Promise<void> {
  if (!api.disconnectNativeMail) return;
  const view = activeView(root);
  button.disabled = true;
  try {
    stopMailStream(root);
    await api.disconnectNativeMail();
    await refresh(root, api, view);
    announceStatus(root, tr(
      localeOf(root),
      "Mail awareness disconnected. No email account data was retained.",
      "邮件提醒已断开；未保留任何邮件账户数据。",
    ));
  } catch (error) {
    button.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

function startMailStream(
  root: HTMLElement,
  api: DashboardApi,
  initial: MailSnapshot,
): void {
  if (!api.streamMail) return;
  stopMailStream(root);
  updateMailUi(root, initial);
  const controller = new AbortController();
  mailStreams.set(root, controller);
  void api.streamMail(
    (mail) => {
      if (!controller.signal.aborted) updateMailUi(root, mail);
    },
    controller.signal,
  ).catch((error: unknown) => {
    if (controller.signal.aborted) return;
    const status = root.querySelector<HTMLElement>("[data-mail-dialog-status]");
    if (status) {
      status.textContent = tr(
        localeOf(root),
        "Live update stopped. Use Refresh to reconnect.",
        "实时更新已停止，请点刷新重新连接。",
      );
    }
    announceError(root, errorText(error, localeOf(root)));
  });
}

function stopMailStream(root: HTMLElement): void {
  mailStreams.get(root)?.abort();
  mailStreams.delete(root);
}

function updateMailUi(root: HTMLElement, mail: MailSnapshot): void {
  const locale = localeOf(root);
  const label = mail.configured && mail.unread_count !== null
    ? tr(locale, `${mail.unread_count} unread`, `${mail.unread_count} 封未读`)
    : mail.configured
      ? tr(locale, "Mail paused", "邮件暂停")
      : tr(locale, "Mail off", "邮件未启用");
  const indicator = root.querySelector<HTMLButtonElement>("[data-mail-open]");
  if (indicator) {
    [...indicator.classList]
      .filter((name) => name.startsWith("status-"))
      .forEach((name) => indicator.classList.remove(name));
    indicator.classList.add(`status-${mail.status}`);
    indicator.setAttribute("aria-label", tr(locale, `Mail: ${label}`, `邮件：${label}`));
  }
  const count = root.querySelector<HTMLElement>("[data-mail-count]");
  if (count) count.textContent = label;
  const dialogStatus = root.querySelector<HTMLElement>("[data-mail-dialog-status]");
  if (dialogStatus) dialogStatus.textContent = localizedMailStatus(mail, locale);
  const list = root.querySelector<HTMLElement>("[data-mail-list]");
  if (list) list.innerHTML = mailHeadersMarkup(mail, locale);
}

function localizedMailStatus(mail: MailSnapshot, locale: Locale): string {
  if (!mail.configured) {
    if (mail.status === "stale") {
      return tr(locale, "Open macOS Mail, then try Connect again.", "请先打开 macOS 邮件，再重新连接。");
    }
    if (mail.status === "denied") {
      return tr(locale, "Mail permission was denied in System Settings.", "系统设置中的邮件权限已被拒绝。");
    }
    return tr(locale, "Off — no access requested", "未启用 · 尚未请求权限");
  }
  if (mail.status === "fresh" && mail.unread_count !== null) {
    return tr(locale, `${mail.unread_count} unread · live`, `${mail.unread_count} 封未读 · 实时`);
  }
  if (mail.status === "stale") return tr(locale, "Waiting for macOS Mail", "正在等待 macOS 邮件");
  if (mail.status === "denied") return tr(locale, "Permission denied", "权限已被拒绝");
  return tr(locale, "Temporarily unavailable", "暂时不可用");
}

async function connectNativeCalendar(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  if (!api.connectNativeCalendar) return;
  const scope = String(
    (form.elements.namedItem("native_detail_scope") as HTMLSelectElement | null)?.value
      ?? "busy_only",
  ) as "busy_only" | "titles";
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const calendar = await api.connectNativeCalendar(scope);
    await refresh(root, api);
    announceStatus(root, calendar.configured
      ? tr(
          localeOf(root),
          "System Calendar connected in read-only mode.",
          "系统日历已以只读方式连接。",
        )
      : calendar.message);
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announceError(root, errorText(error, localeOf(root)));
  }
}

function bindSettingsDialog(
  root: HTMLElement,
  dialogSelector: string,
  triggerSelector: string,
): void {
  const dialog = root.querySelector<HTMLDialogElement>(dialogSelector);
  const trigger = root.querySelector<HTMLButtonElement>(triggerSelector);
  trigger?.addEventListener("click", () => {
    if (dialog && !dialog.open) dialog.showModal();
  });
  dialog?.querySelector<HTMLButtonElement>("[data-settings-close]")?.addEventListener(
    "click",
    () => dialog.close(),
  );
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

async function saveCalendar(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const input = form.querySelector<HTMLInputElement>('input[type="file"]');
  const file = input?.files?.[0];
  if (!file) return;
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    if (!file.name.toLowerCase().endsWith(".ics") || file.size > 2_000_000) {
      throw new Error(tr(
        localeOf(root),
        "Select an ICS file no larger than 2 MB.",
        "请选择不超过 2 MB 的 ICS 文件。",
      ));
    }
    await api.configureCalendar({
      enabled: true,
      filename: file.name,
      content: await file.text(),
      timezone: systemTimeZone(),
    });
    form.reset();
    await refresh(root, api);
    announceStatus(root, tr(
      localeOf(root),
      "Calendar imported in read-only mode using system time.",
      "日历已按系统时间以只读方式导入。",
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function disableCalendar(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    if (api.disconnectNativeCalendar) {
      await api.disconnectNativeCalendar();
    } else {
      await api.configureCalendar({ enabled: false, timezone: systemTimeZone() });
    }
    form.reset();
    await refresh(root, api);
    announceStatus(root, tr(
      localeOf(root),
      "Calendar disabled and its private import removed.",
      "日历已停用，私有导入副本已移除。",
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announceError(root, errorText(error, localeOf(root)));
  }
}

function selectView(root: HTMLElement, view: string): void {
  const panels = [...root.querySelectorAll<HTMLElement>("[data-view-panel]")];
  const resolvedView = panels.some((panel) => panel.dataset.viewPanel === view) ? view : "start";
  const previousView = root.querySelector<HTMLElement>("[data-view].is-active")?.dataset.view;
  if (resolvedView !== "runs" && resolvedView !== "start") stopEventStream(root);
  if (resolvedView !== "vault") stopVaultStream(root);
  panels.forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== resolvedView;
    panel.classList.toggle("is-visible", !panel.hidden);
  });
  root.querySelectorAll<HTMLElement>("[data-view]").forEach((button) => {
    const active = button.dataset.view === resolvedView;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (previousView && previousView !== resolvedView) {
    const workspace = root.querySelector<HTMLElement>(".workspace");
    if (workspace) workspace.scrollTop = 0;
  }
  syncNavBadges(root);
}

/**
 * Nav badges count unseen items. Visiting a view marks its current count as
 * seen; the badge then shows only what arrived since that visit. Counts live
 * on the root so a full workspace re-render keeps the seen baseline.
 */
const navSeenCounts = new WeakMap<HTMLElement, Map<string, number>>();

function syncNavBadges(root: HTMLElement): void {
  let seen = navSeenCounts.get(root);
  if (!seen) {
    seen = new Map();
    navSeenCounts.set(root, seen);
  }
  root.querySelectorAll<HTMLElement>("[data-view]").forEach((button) => {
    const badge = button.querySelector<HTMLElement>("[data-nav-count]");
    if (!badge) return;
    const view = badge.dataset.navCount ?? "";
    const raw = Number(badge.dataset.rawCount ?? "0");
    if (button.classList.contains("is-active")) seen.set(view, raw);
    const unseen = raw - (seen.get(view) ?? 0);
    badge.hidden = unseen <= 0;
    badge.textContent = String(Math.max(unseen, 0));
  });
}

function openRunForm(root: HTMLElement, mode: Mode, trigger?: HTMLButtonElement, snapshot?: DashboardSnapshot): void {
  const panel = root.querySelector<HTMLElement>("#action-panel");
  const field = root.querySelector<HTMLInputElement>("#run-mode");
  if (!panel || !field) return;
  if (!panel.hidden && field.value === mode) {
    closeRunForm(root, true);
    return;
  }
  const previousMode = field.value;
  panel.hidden = false;
  const workspace = root.querySelector<HTMLElement>(".workspace");
  if (workspace) workspace.scrollTop = 0;
  panel.dataset.activeMode = mode;
  field.value = mode;
  root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-expanded", String(active));
    button.setAttribute("aria-pressed", String(active));
  });
  if (trigger) panel.dataset.returnFocusMode = trigger.dataset.mode ?? mode;
  const locale = localeOf(root);
  const title = root.querySelector<HTMLElement>("#action-panel-title");
  if (title) {
    title.textContent = tr(locale, `Start a ${capitalizedMode(mode)} run`, `新建 ${capitalizedMode(mode)} 运行`);
  }
  if (previousMode !== mode) {
    const status = root.querySelector<HTMLElement>("#action-status");
    if (status) status.textContent = "";
  }
  const target = root.querySelector<HTMLInputElement>("#study-target-note");
  const targetLabel = root.querySelector<HTMLElement>("#study-target-label");
  if (target) target.hidden = mode !== "study";
  if (targetLabel) targetLabel.hidden = mode !== "study";
  const workFields = root.querySelector<HTMLFieldSetElement>("#work-fields");
  if (workFields) workFields.hidden = mode !== "work";
  const workRoot = root.querySelector<HTMLInputElement>("#work-root");
  const workTargets = root.querySelector<HTMLTextAreaElement>("#work-targets");
  if (workRoot) workRoot.required = mode === "work";
  if (workTargets) workTargets.required = mode === "work";
  const studyHost = root.querySelector<HTMLElement>("#study-workspace");
  if (studyHost) studyHost.hidden = mode !== "study";
  const workHost = root.querySelector<HTMLElement>("#work-workspace");
  if (workHost) workHost.hidden = mode !== "work";
  // Pre-submit guard: Study cannot start without a Core-side Vault. Disable
  // the submit button up front instead of failing the run after creation.
  const vaultReady = snapshot?.taskBoard.configured ?? true;
  const studyBlocked = mode === "study" && !vaultReady;
  const hint = root.querySelector<HTMLElement>("#study-vault-hint");
  if (hint) hint.hidden = !studyBlocked;
  const submit = root.querySelector<HTMLButtonElement>("#run-submit");
  if (submit) {
    submit.disabled = studyBlocked;
    submit.setAttribute("aria-disabled", String(studyBlocked));
  }
  root.querySelector<HTMLInputElement>("#run-goal")?.focus();
}

function closeRunForm(root: HTMLElement, restoreFocus: boolean): void {
  const panel = root.querySelector<HTMLElement>("#action-panel");
  if (!panel || panel.hidden) return;
  const returnFocusMode = panel.dataset.returnFocusMode ?? panel.dataset.activeMode;
  panel.hidden = true;
  delete panel.dataset.activeMode;
  root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
    button.classList.remove("is-active");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-pressed", "false");
  });
  if (restoreFocus && returnFocusMode) {
    root.querySelector<HTMLButtonElement>(`[data-mode="${returnFocusMode}"]`)?.focus();
  }
}

function capitalizedMode(mode: Mode): string {
  return `${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;
}

async function createRun(root: HTMLElement, api: DashboardApi, form: HTMLFormElement, snapshot?: DashboardSnapshot): Promise<void> {
  const surface = form.closest<HTMLElement>("[data-run-surface]") ?? root;
  const data = new FormData(form);
  const mode = String(data.get("mode")) as Mode;
  const goal = String(data.get("goal") ?? "").trim();
  const dataClass = String(data.get("context_data_class") ?? "public") as WorkDataClass;
  const providerProfileId = String(data.get("provider_profile_id") ?? "deepseek").trim();
  const workspaceRoot = String(data.get("workspace_root") ?? "").trim();
  const workspaceGrantId = String(data.get("workspace_grant_id") ?? "").trim();
  const targetFiles = lines(data.get("target_files"));
  const targetNote = String(data.get("target_note") ?? "").trim() || null;
  const status = surface.querySelector<HTMLElement>("[data-run-status]");
  const waitHost = surface.querySelector<HTMLElement>("[data-run-wait]");
  if (!goal) return;
  const vaultReady = snapshot
    ? (snapshot.taskBoard.vault_configured ?? snapshot.taskBoard.configured)
    : true;
  if (mode === "study" && !vaultReady) {
    if (status) {
      status.textContent = tr(
        localeOf(root),
        "Study needs the Core to be started with a Vault (--vault-dir). Configure your knowledge base in Settings, then restart the app.",
        "Study 需要 Core 以 --vault-dir 指定知识库。请先在设置中配置知识库目录并重启应用。",
      );
    }
    return;
  }
  if (mode === "work" && !workspaceRoot && !workspaceGrantId) {
    if (status) {
      status.textContent = tr(
        localeOf(root),
        "Choose a project folder before starting Work.",
        "开始推进工作前，请先选择项目文件夹。",
      );
    }
    return;
  }
  if (status) status.textContent = tr(localeOf(root), "Creating a local run…", "正在创建本地运行…");
  if (waitHost) waitHost.innerHTML = agentWaitMarkup("prepare", localeOf(root));
  if (form.id === "start-run-form") setStartRunBusy(form, true);
  let stream: AbortController | null = null;
  let createdRun: RunSummary | null = null;
  try {
    const run = await api.createRun(mode, goal, dataClass, providerProfileId);
    createdRun = run;
    if (form.id === "start-run-form") prepareStartRunFeedback(surface, run.run_id);
    let waitStage: AgentWaitStage = "prepare";
    stream = startEventStream(root, api, run.run_id, 0, (event) => {
      waitStage = waitStageForEvent(waitStage, event);
      if (waitHost?.isConnected) waitHost.innerHTML = agentWaitMarkup(waitStage, localeOf(root));
      if (form.id === "start-run-form") paintStartRunEvent(surface, event, localeOf(root));
    }, form.id === "start-run-form" ? "start" : "launcher");
    if (status) {
      status.textContent = tr(
        localeOf(root),
        `Created ${run.run_id}`,
        `已创建 ${run.run_id}`,
      );
    }
    if (mode === "study") {
      if (waitHost) waitHost.innerHTML = agentWaitMarkup("sources", localeOf(root));
      const diagnostic = await api.prepareStudy(run.run_id, goal, targetNote);
      const host = surface.querySelector<HTMLElement>("[data-study-workspace]");
      if (host) {
        host.innerHTML = studyDiagnosticMarkup(diagnostic, localeOf(root));
        bindStudyDiagnostic(root, api, host);
      }
    } else if (mode === "work") {
      if (waitHost) waitHost.innerHTML = agentWaitMarkup("sources", localeOf(root));
      const plan = await api.planWork(run.run_id, {
        goal,
        workspace_root: workspaceRoot || undefined,
        workspace_grant_id: workspaceGrantId || undefined,
        target_files: targetFiles,
        context_files: lines(data.get("context_files")),
        constraints: lines(data.get("constraints")),
        non_goals: lines(data.get("non_goals")),
        completion_criteria: [tr(
          localeOf(root),
          "produce a result the user can inspect and verify",
          "产出用户能够查看并核对的结果",
        )],
        verification_commands: lines(data.get("verification_commands")),
        context_data_class: dataClass,
      });
      const host = surface.querySelector<HTMLElement>("[data-work-workspace]");
      if (host) {
        host.innerHTML = workPlanMarkup(plan, localeOf(root));
        bindWorkPlan(root, api, host);
      }
      clearWorkFields(form);
    } else {
      if (form.id === "start-run-form") {
        if (status) status.textContent = tr(
          localeOf(root),
          `Task started · ${run.run_id}`,
          `任务已开始 · ${run.run_id}`,
        );
      } else {
        // The compact sidebar launcher keeps its legacy hand-off to Dashboard.
        await refresh(root, api);
        announceStatus(root, tr(
          localeOf(root),
          `Created ${run.run_id}. Track progress and the answer in Runs.`,
          `已创建 ${run.run_id}，可在「运行」页查看进度和回答。`,
        ));
      }
    }
    if (mode !== "research" && waitHost?.isConnected) {
      waitHost.innerHTML = agentWaitMarkup("complete", localeOf(root));
    }
    if (mode !== "research" && form.id === "start-run-form") setStartRunBusy(form, false);
  } catch (error) {
    // A Study/Work run never auto-starts: if preparation or planning failed,
    // the run is still `proposed` and would stay in the run list forever.
    // Cancel it best-effort so a failed start leaves no zombie run behind.
    if (createdRun && mode !== "research") {
      try {
        await api.cancelRun(createdRun.run_id);
      } catch {
        // Cancellation is best-effort; the original error is what matters.
      }
    }
    const neverStarted = createdRun != null && mode !== "research";
    if (waitHost?.isConnected) {
      waitHost.innerHTML = agentWaitMarkup(neverStarted ? "blocked" : "error", localeOf(root));
    }
    if (status) status.textContent = errorText(error, localeOf(root));
    if (form.id === "start-run-form") setStartRunBusy(form, false);
  } finally {
    if (stream && eventStreams.get(root)?.controller === stream && form.id !== "start-run-form") {
      stopEventStream(root);
    }
  }
}

function resumeStartRunFromSnapshot(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
): void {
  const active = snapshot.runs.find(
    (entry) => !["completed", "failed", "cancelled"].includes(entry.summary.state),
  );
  if (active) resumeStartRun(root, api, active.summary.run_id, active.summary.state);
}

function resumeStartRun(
  root: HTMLElement,
  api: DashboardApi,
  runId: string,
  state: string,
): void {
  const surface = root.querySelector<HTMLElement>(".start-workspace");
  const panel = surface?.closest<HTMLElement>("[data-view-panel]");
  if (!surface || panel?.hidden) return;
  prepareStartRunFeedback(surface, runId);
  setStartRunBusy(surface, true);
  const status = surface.querySelector<HTMLElement>("[data-run-status]");
  const waitHost = surface.querySelector<HTMLElement>("[data-run-wait]");
  if (status) status.textContent = tr(
    localeOf(root),
    `Continuing ${runId} · ${state}`,
    `继续显示任务 · ${runId}`,
  );
  let waitStage: AgentWaitStage = state === "running" ? "model" : "prepare";
  if (waitHost) waitHost.innerHTML = agentWaitMarkup(waitStage, localeOf(root));
  startEventStream(root, api, runId, 0, (event) => {
    waitStage = waitStageForEvent(waitStage, event);
    if (waitHost?.isConnected) waitHost.innerHTML = agentWaitMarkup(waitStage, localeOf(root));
    paintStartRunEvent(surface, event, localeOf(root));
  }, "start");
}

function prepareStartRunFeedback(surface: ParentNode, runId: string): void {
  const cancel = surface.querySelector<HTMLButtonElement>("[data-start-cancel]");
  const output = surface.querySelector<HTMLElement>("[data-start-output]");
  const text = surface.querySelector<HTMLElement>("[data-start-output-text]");
  if (cancel) {
    cancel.hidden = false;
    cancel.disabled = false;
    cancel.dataset.runId = runId;
  }
  if (output) output.hidden = true;
  if (text) text.replaceChildren();
}

function setStartRunBusy(surface: ParentNode, busy: boolean): void {
  const form = surface instanceof HTMLFormElement
    ? surface
    : surface.querySelector<HTMLFormElement>("#start-run-form");
  if (!form) return;
  form.dataset.runBusy = String(busy);
  form.setAttribute("aria-busy", String(busy));
  const submit = form.querySelector<HTMLButtonElement>("[data-start-submit]");
  if (!submit) return;
  const disabled = busy || form.dataset.modeBlocked === "true";
  submit.disabled = disabled;
  submit.setAttribute("aria-disabled", String(disabled));
}

function paintStartRunEvent(surface: ParentNode, event: RunEvent, locale: Locale): void {
  const status = surface.querySelector<HTMLElement>("[data-run-status]");
  const cancel = surface.querySelector<HTMLButtonElement>("[data-start-cancel]");
  const output = surface.querySelector<HTMLElement>("[data-start-output]");
  const text = surface.querySelector<HTMLElement>("[data-start-output-text]");
  if (event.type === "assistant.delta" && typeof event.data.content === "string" && text) {
    if (output) output.hidden = false;
    text.append(document.createTextNode(event.data.content));
  }
  if (event.type === "run.completed") {
    if (status) status.textContent = tr(locale, "Task completed.", "任务已完成。");
    if (cancel) cancel.hidden = true;
    if (text?.textContent) {
      const upgraded = assistantStreamMarkup(text.textContent, locale);
      if (!upgraded.startsWith("<pre")) text.outerHTML = upgraded;
    }
    setStartRunBusy(surface, false);
  } else if (event.type === "run.failed") {
    if (status) status.textContent = tr(
      locale,
      "Task failed. Open Runs for details.",
      "任务未完成，可到「运行」查看原因。",
    );
    if (cancel) cancel.hidden = true;
    setStartRunBusy(surface, false);
  } else if (event.type === "run.cancelled") {
    if (status) status.textContent = tr(locale, "Task stopped.", "任务已停止。");
    if (cancel) cancel.hidden = true;
    setStartRunBusy(surface, false);
  }
}

async function cancelStartRun(root: HTMLElement, api: DashboardApi, runId: string): Promise<void> {
  const surface = root.querySelector<HTMLElement>("#start-run-form");
  const cancel = surface?.querySelector<HTMLButtonElement>("[data-start-cancel]");
  const status = surface?.querySelector<HTMLElement>("[data-run-status]");
  if (cancel) cancel.disabled = true;
  try {
    await api.cancelRun(runId);
    stopEventStream(root);
    if (cancel) cancel.hidden = true;
    if (status) status.textContent = tr(localeOf(root), "Task stopped.", "任务已停止。");
    if (surface) setStartRunBusy(surface, false);
  } catch (error) {
    if (cancel) cancel.disabled = false;
    if (status) status.textContent = errorText(error, localeOf(root));
  }
}

function bindStudyDiagnostic(root: HTMLElement, api: DashboardApi, scope: ParentNode = root): void {
  const form = scope.querySelector<HTMLFormElement>("[data-study-diagnostic]");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitStudyDiagnostic(root, api, form);
  });
}

async function submitStudyDiagnostic(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  const answers: Record<string, string> = {};
  for (const field of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "[data-diagnostic-question]",
  )) answers[field.name] = field.value;
  form.reset();
  try {
    const artifact = await api.submitStudyDiagnostic(form.dataset.runId ?? "", answers);
    const host = form.closest<HTMLElement>("[data-run-surface]")
      ?.querySelector<HTMLElement>("[data-study-workspace]");
    if (host) {
      host.innerHTML = studyArtifactMarkup(artifact, localeOf(root));
      bindStudyPractice(root, api, host);
      bindNoteSave(root, api, host);
    }
  } catch (error) {
    if (submit) submit.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

function bindStudyPractice(root: HTMLElement, api: DashboardApi, scope: ParentNode = root): void {
  scope.querySelectorAll<HTMLFormElement>("[data-study-practice]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitStudyPractice(root, api, form);
    });
  });
}

function bindNoteSave(root: HTMLElement, api: DashboardApi, host: ParentNode = root): void {
  host.querySelectorAll<HTMLButtonElement>("[data-note-save]").forEach((button) => {
    button.addEventListener("click", () => void saveArtifactNote(root, api, button));
  });
}

async function submitStudyPractice(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const data = new FormData(form);
  const answer = String(data.get("answer") ?? "");
  const confidence = Number(data.get("confidence"));
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const feedback = form.querySelector<HTMLElement>(".study-attempt");
  if (submit) submit.disabled = true;
  form.reset();
  try {
    const result = await api.submitStudyPractice(
      form.dataset.runId ?? "",
      form.dataset.exerciseId ?? "",
      answer,
      confidence,
    );
    if (feedback) feedback.innerHTML = studyAttemptMarkup(result, localeOf(root));
  } catch (error) {
    announceError(root, errorText(error, localeOf(root)));
  } finally {
    if (submit) submit.disabled = false;
  }
}

function bindWorkPlan(root: HTMLElement, api: DashboardApi, scope: ParentNode = root): void {
  const button = scope.querySelector<HTMLButtonElement>("[data-work-preview]");
  button?.addEventListener("click", () => void previewWorkHandoff(root, api, button));
}

async function previewWorkHandoff(
  root: HTMLElement,
  api: DashboardApi,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    const preview = await api.previewWorkHandoff(button.dataset.runId ?? "");
    const host = button.closest<HTMLElement>("[data-run-surface]")
      ?.querySelector<HTMLElement>("[data-work-workspace]");
    if (host) {
      host.innerHTML = workHandoffMarkup(preview, localeOf(root));
      bindWorkHandoff(root, api, preview, host);
    }
  } catch (error) {
    button.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

function bindWorkHandoff(
  root: HTMLElement,
  api: DashboardApi,
  preview: WorkHandoffPreview,
  scope: ParentNode = root,
): void {
  const exportButton = scope.querySelector<HTMLButtonElement>("[data-work-export]");
  exportButton?.addEventListener("click", () => {
    void approveAndExportWork(root, api, preview, exportButton);
  });
  const rejectButton = scope.querySelector<HTMLButtonElement>("[data-work-reject]");
  rejectButton?.addEventListener("click", () => void rejectWork(root, api, rejectButton));
}

async function approveAndExportWork(
  root: HTMLElement,
  api: DashboardApi,
  preview: WorkHandoffPreview,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    const approvalId = button.dataset.approvalId ?? "";
    await api.decideApproval(approvalId, "approve");
    const result = await api.exportWorkHandoff(button.dataset.runId ?? "", approvalId);
    const host = button.closest<HTMLElement>("[data-run-surface]")
      ?.querySelector<HTMLElement>("[data-work-workspace]");
    if (host) {
      host.innerHTML = workExportMarkup(result, preview.plan, localeOf(root));
      bindWorkVerification(root, api, host);
    }
  } catch (error) {
    button.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function rejectWork(
  root: HTMLElement,
  api: DashboardApi,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    await api.decideApproval(button.dataset.approvalId ?? "", "reject");
    const host = button.closest<HTMLElement>("[data-run-surface]")
      ?.querySelector<HTMLElement>("[data-work-workspace]");
    if (host) host.replaceChildren();
    announceStatus(root, tr(
      localeOf(root),
      "Work handoff rejected. No package was exported.",
      "Work 交接已拒绝。没有导出任何交接包。",
    ));
  } catch (error) {
    button.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

function bindWorkVerification(root: HTMLElement, api: DashboardApi, scope: ParentNode = root): void {
  const form = scope.querySelector<HTMLFormElement>("[data-work-verify]");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void verifyWorkResult(root, api, form);
  });
}

async function verifyWorkResult(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const raw = String(new FormData(form).get("manifest") ?? "");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error(tr(
        localeOf(root),
        "Result manifest must be one JSON object",
        "结果清单必须是一个 JSON 对象",
      ));
    }
    const report = await api.verifyWorkResult(
      form.dataset.runId ?? "",
      parsed as unknown as WorkResultManifest,
    );
    form.reset();
    const host = form.closest<HTMLElement>("[data-run-surface]")
      ?.querySelector<HTMLElement>("[data-work-workspace]");
    if (host) host.innerHTML = workVerificationMarkup(report, localeOf(root));
  } catch (error) {
    if (submit) submit.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}


async function decide(root: HTMLElement, api: DashboardApi, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const decision = button.dataset.decision === "approve" ? "approve" : "reject";
    const approval = await api.decideApproval(
      button.dataset.approvalId ?? "",
      decision,
    );
    if (
      decision === "approve" &&
      (approval.action_kind === "task_write" || approval.action_kind === "vault_write")
    ) {
      await api.applyTask(approval.approval_id);
      await refresh(root, api, approval.action_kind === "task_write" ? "tasks" : "approvals");
    } else if (decision === "approve" && approval.action_kind === "handoff_export") {
      await api.exportWorkHandoff(approval.run_id, approval.approval_id);
      await refresh(root, api, "runs");
    } else {
      await refresh(root, api, "approvals");
    }
  } catch (error) {
    button.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function actOnRadar(root: HTMLElement, api: DashboardApi, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  const target = root.querySelector<HTMLElement>("#research-result");
  if (target) target.innerHTML = agentWaitMarkup("sources", localeOf(root));
  try {
    const action = button.dataset.radarAction as RadarAction;
    const result = await api.radarAction(
      button.dataset.radarId ?? "",
      action,
    );
    await refresh(root, api, action === "make_task" ? "approvals" : "radar");
    if (result.research_artifact) {
      const resultTarget = root.querySelector<HTMLElement>("#research-result");
      if (resultTarget) {
        resultTarget.innerHTML = researchPreviewMarkup(result.research_artifact, localeOf(root));
        bindNoteSave(root, api, resultTarget);
      }
    }
  } catch (error) {
    if (target) target.innerHTML = agentWaitMarkup("error", localeOf(root));
    button.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function previewTask(
  root: HTMLElement,
  api: DashboardApi,
  input: HTMLInputElement,
): Promise<void> {
  input.disabled = true;
  try {
    await api.previewTask(input.dataset.taskId ?? "", input.checked);
    announceStatus(root, tr(
      localeOf(root),
      "Markdown diff ready for approval.",
      "已生成 Markdown diff，等待审批。",
    ));
    await refresh(root, api, "approvals");
  } catch (error) {
    input.checked = !input.checked;
    input.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function saveArtifactNote(
  root: HTMLElement,
  api: DashboardApi,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  const runId = button.dataset.noteRunId ?? "";
  try {
    if (button.dataset.noteSave === "research") {
      await api.previewResearchNote(runId);
    } else {
      await api.previewStudyNote(runId);
    }
    announceStatus(root, tr(
      localeOf(root),
      "Vault note preview ready for approval.",
      "知识库笔记预览已生成，等待审批。",
    ));
    await refresh(root, api, "approvals");
  } catch (error) {
    button.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function captureTask(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const data = new FormData(form);
  const text = String(data.get("text") ?? "").trim();
  const priority = String(data.get("priority") ?? "");
  if (!text) return;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    await api.captureTask(text, priority);
    await refresh(root, api, "approvals");
  } catch (error) {
    if (submit) submit.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

function todoDueAt(value: FormDataEntryValue | null): string | null {
  const date = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T23:59:59`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function createLocalTodo(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  if (!api.createLocalTodo) return;
  const data = new FormData(form);
  const status = form.querySelector<HTMLElement>("#local-todo-status");
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = true;
  if (status) status.textContent = tr(localeOf(root), "Adding the task locally…", "正在添加到本地任务…");
  try {
    await api.createLocalTodo({
      title: String(data.get("title") ?? "").trim(),
      details: String(data.get("details") ?? "").trim(),
      priority: String(data.get("priority") ?? "").trim() || null,
      due_at: todoDueAt(data.get("due_date")),
      completed: false,
      origin: "user",
    });
    await refresh(root, api, "tasks");
  } catch (error) {
    if (submit) submit.disabled = false;
    if (status) status.textContent = errorText(error, localeOf(root));
  }
}

async function updateLocalTodo(
  root: HTMLElement,
  api: DashboardApi,
  task: DashboardSnapshot["taskBoard"]["tasks"][number],
  patch: { completed?: boolean; form?: HTMLFormElement },
): Promise<void> {
  if (!api.updateLocalTodo || !task.updated_at) return;
  const data = patch.form ? new FormData(patch.form) : null;
  await api.updateLocalTodo(task.task_id, {
    title: data ? String(data.get("title") ?? "").trim() : task.text,
    details: data ? String(data.get("details") ?? "").trim() : task.details ?? "",
    priority: data ? String(data.get("priority") ?? "").trim() || null : task.fields.priority ?? null,
    due_at: data ? todoDueAt(data.get("due_date")) : task.fields.due ?? null,
    completed: patch.completed ?? task.completed,
    origin: task.origin === "model" ? "model" : "user",
    expected_updated_at: task.updated_at,
  });
  await refresh(root, api, "tasks");
}

async function deleteLocalTodo(
  root: HTMLElement,
  api: DashboardApi,
  taskId: string,
  expectedUpdatedAt: string,
): Promise<void> {
  if (!api.deleteLocalTodo) return;
  const confirmed = await confirmAction(root, tr(
    localeOf(root),
    "Remove this task? It will be kept locally for recovery.",
    "移除这条任务？数据会保留在本地，便于恢复。",
  ));
  if (!confirmed) return;
  await api.deleteLocalTodo(taskId, expectedUpdatedAt);
  await refresh(root, api, "tasks");
}

async function restoreLocalTodo(
  root: HTMLElement,
  api: DashboardApi,
  taskId: string,
  expectedUpdatedAt: string,
): Promise<void> {
  if (!api.restoreLocalTodo) return;
  await api.restoreLocalTodo(taskId, expectedUpdatedAt);
  await refresh(root, api, "tasks");
}

function openTodoSuggestionConversation(
  root: HTMLElement,
  snapshot: DashboardSnapshot,
): void {
  const locale = localeOf(root);
  if (!snapshot.workspaceV2) {
    announceError(root, tr(
      locale,
      "Conversations are unavailable in the connected Core.",
      "当前连接的 Core 尚未提供对话功能。",
    ));
    return;
  }
  selectView(root, "conversation");
  const prompt = tr(
    locale,
    "Review my current tasks and suggest a short, prioritized Todo list. Explain why each item matters. Do not create or change tasks until I confirm.",
    "请结合我当前的任务，建议一份简短且有优先级的 Todo 清单，并说明每项为什么重要。在我确认前，不要创建或修改任务。",
  );
  const pane = root.querySelector<HTMLElement>(".conversation-pane");
  const activeSession = pane?.dataset.activeSession ?? "";
  const activeProfile = pane?.dataset.activeProfile ?? "safe-mode";
  const composer = root.querySelector<HTMLTextAreaElement>('#session-message-form [name="content"]');
  if (activeSession && activeProfile !== "safe-mode" && composer) {
    composer.value = prompt;
    composer.focus();
    announceStatus(root, tr(
      locale,
      "Suggestion request is ready. Review it, then send when you are comfortable.",
      "建议请求已经填好；请确认内容后再发送。",
    ));
    return;
  }
  const title = root.querySelector<HTMLInputElement>('#session-create-form [name="title"]');
  const profile = root.querySelector<HTMLSelectElement>('#session-create-form [name="profile_id"]');
  if (title) title.value = tr(locale, "Plan my next tasks", "安排我的下一步任务");
  profile?.focus();
  announceStatus(root, tr(
    locale,
    "Choose a model and create the conversation. Restork will show the request before anything changes.",
    "请选择模型并创建对话；实际修改任务前，Restork 会展示准备执行的请求。",
  ));
}

async function applyApprovedTask(
  root: HTMLElement,
  api: DashboardApi,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    await api.applyTask(button.dataset.taskApply ?? "");
    await refresh(root, api, button.dataset.actionKind === "vault_write" ? "approvals" : "tasks");
  } catch (error) {
    button.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function showRun(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  button: HTMLButtonElement,
): Promise<void> {
  const detail = root.querySelector<HTMLElement>("#run-detail");
  const run = snapshot.runs.find((entry) => entry.summary.run_id === button.dataset.runId);
  if (!detail || !run) return;
  detail.textContent = tr(localeOf(root), "Reading local events and conversation…", "读取本地事件与对话…");
  try {
    const [firstPage, firstConversation] = await Promise.all([
      api.eventPage
        ? api.eventPage(run.summary.run_id)
        : api.events(run.summary.run_id, 0).then((events) => ({
            events,
            page: { limit: 50, has_more: false, next_cursor: null },
          })),
      api.conversationPage
        ? api.conversationPage(run.summary.run_id).catch(() => null)
        : Promise.resolve(null),
    ]);
    const received = [...firstPage.events];
    const turns = [...(firstConversation?.turns ?? [])];
    let historyPage = firstPage.page;
    let conversationPage = firstConversation?.page ?? { limit: 24, has_more: false, next_cursor: null };
    let conversationBusy = false;
    let conversationDraft = "";
    let conversationError = "";
    let preservePrepend = false;
    const render = (forceBottom = false): void => {
      if (!detail.isConnected) return;
      const previousInput = detail.querySelector<HTMLTextAreaElement>("#conversation-input");
      const previousScroll = detail.querySelector<HTMLElement>("[data-conversation-scroll]");
      const inputFocused = document.activeElement === previousInput;
      const selectionStart = previousInput?.selectionStart ?? 0;
      const selectionEnd = previousInput?.selectionEnd ?? 0;
      if (previousInput && !conversationBusy) conversationDraft = previousInput.value;
      const oldScrollTop = previousScroll?.scrollTop ?? 0;
      const oldScrollHeight = previousScroll?.scrollHeight ?? 0;
      const nearBottom = previousScroll
        ? previousScroll.scrollHeight - previousScroll.scrollTop - previousScroll.clientHeight < 56
        : true;
      detail.innerHTML = runEventsMarkup(run, received, localeOf(root), historyPage, {
        turns,
        page: conversationPage,
        enabled: Boolean(api.sendConversation),
        busy: conversationBusy,
        draft: conversationDraft,
        error: conversationError,
      });
      detail.querySelector<HTMLButtonElement>('[data-page-kind="events"]')?.addEventListener(
        "click",
        (event) => {
          const button = event.currentTarget as HTMLButtonElement;
          void loadEarlierEvents(api, run.summary.run_id, button, received, (page) => {
            historyPage = page;
            render();
          });
        },
      );
      detail.querySelector<HTMLButtonElement>('[data-page-kind="conversation"]')?.addEventListener(
        "click",
        (event) => {
          void loadEarlierConversation(
            api,
            run.summary.run_id,
            event.currentTarget as HTMLButtonElement,
            turns,
            (page) => {
              conversationPage = page;
              preservePrepend = true;
              render();
            },
          );
        },
      );
      detail.querySelector<HTMLFormElement>("[data-conversation-form]")?.addEventListener(
        "submit",
        (event) => {
          event.preventDefault();
          void sendConversation(
            root,
            api,
            run.summary.run_id,
            event.currentTarget as HTMLFormElement,
            {
              started: (content) => {
                conversationDraft = content;
                conversationError = "";
                conversationBusy = true;
                render(true);
              },
              completed: (turn) => {
                if (!turns.some((item) => item.turn_id === turn.turn_id)) turns.push(turn);
                conversationDraft = "";
                conversationBusy = false;
                render(true);
              },
              failed: (message) => {
                conversationError = message;
                conversationBusy = false;
                render(true);
              },
            },
          );
        },
      );
      const nextScroll = detail.querySelector<HTMLElement>("[data-conversation-scroll]");
      if (nextScroll) {
        if (forceBottom || nearBottom) {
          nextScroll.scrollTop = nextScroll.scrollHeight;
        } else if (preservePrepend) {
          nextScroll.scrollTop = oldScrollTop + (nextScroll.scrollHeight - oldScrollHeight);
        } else {
          nextScroll.scrollTop = oldScrollTop;
        }
      }
      preservePrepend = false;
      const nextInput = detail.querySelector<HTMLTextAreaElement>("#conversation-input");
      if (inputFocused && nextInput && !nextInput.disabled) {
        nextInput.focus();
        nextInput.setSelectionRange(selectionStart, selectionEnd);
      }
    };
    render(true);
    const after = received.at(-1)?.id ?? 0;
    if (!["completed", "failed", "cancelled"].includes(run.summary.state)) {
      startEventStream(root, api, run.summary.run_id, after, (event) => {
        received.push(event);
        // Append one row. Re-rendering the whole run per event made live
        // streaming quadratic and destroyed focus, selection, and scroll.
        if (!appendRunEvent(detail, event, localeOf(root))) render();
      }, "run-detail");
    }
  } catch (error) {
    detail.textContent = errorText(error, localeOf(root));
  }
}

/**
 * Live events are appended, never re-serialised. Returns false when the list is
 * not mounted so the caller can fall back to a full render.
 *
 * The DOM is bounded: older rows are dropped once the cap is reached, because
 * a long-running agent loop can emit far more events than a page can hold.
 * Full history stays reachable through `LOAD EARLIER EVENTS`.
 */
const LIVE_EVENT_DOM_CAP = 400;

function appendRunEvent(detail: HTMLElement, event: RunEvent, locale: Locale): boolean {
  if (!detail.isConnected) return false;
  if (event.type === "assistant.delta") {
    const output = detail.querySelector<HTMLElement>("[data-assistant-stream]");
    const stream = output?.closest<HTMLElement>(".assistant-stream");
    const content = typeof event.data.content === "string" ? event.data.content : "";
    if (!output || !stream) return false;
    stream.hidden = false;
    output.append(document.createTextNode(content));
    return true;
  }
  if (event.type === "run.completed" || event.type === "run.stopped") {
    // The run is done streaming: swap the raw stream for the readable
    // envelope when the final output matches the research JSON contract.
    const output = detail.querySelector<HTMLElement>("[data-assistant-stream]");
    const text = output?.textContent ?? "";
    if (output && text) {
      const upgraded = assistantStreamMarkup(text, locale);
      if (!upgraded.startsWith("<pre")) output.outerHTML = upgraded;
    }
  }
  const list = detail.querySelector<HTMLOListElement>(".event-list");
  if (!list) return false;
  // Server-supplied. Validate rather than escape: `CSS.escape` is absent under jsdom.
  const id = String(event.id);
  if (!/^[\w-]+$/.test(id)) return false;
  if (list.querySelector(`[data-event-id="${id}"]`)) return true;

  // The empty-state row carries no identity; it is replaced by the first event.
  list.querySelector("li:not([data-event-id])")?.remove();

  const scroller = list.closest<HTMLElement>("[data-conversation-scroll]") ?? list;
  const nearBottom =
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 56;
  list.insertAdjacentHTML("beforeend", eventRow(event, locale));
  while (list.children.length > LIVE_EVENT_DOM_CAP) list.firstElementChild?.remove();
  if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
  return true;
}

async function loadEarlierConversation(
  api: DashboardApi,
  runId: string,
  button: HTMLButtonElement,
  turns: ConversationTurn[],
  onPage: (page: { limit: number; has_more: boolean; next_cursor: string | null }) => void,
): Promise<void> {
  if (!api.conversationPage || !button.dataset.pageCursor) return;
  button.disabled = true;
  try {
    const page = await api.conversationPage(runId, button.dataset.pageCursor);
    const known = new Set(turns.map((turn) => turn.turn_id));
    turns.unshift(...page.turns.filter((turn) => !known.has(turn.turn_id)));
    onPage(page.page);
  } catch {
    button.disabled = false;
  }
}

async function sendConversation(
  root: HTMLElement,
  api: DashboardApi,
  runId: string,
  form: HTMLFormElement,
  state: {
    started: (content: string) => void;
    completed: (turn: ConversationTurn) => void;
    failed: (message: string) => void;
  },
): Promise<void> {
  if (!api.sendConversation) return;
  const content = String(new FormData(form).get("content") ?? "").trim();
  if (!content) return;
  state.started(content);
  try {
    state.completed(await api.sendConversation(runId, content));
  } catch (error) {
    state.failed(errorText(error, localeOf(root)));
  }
}

async function loadEarlierEvents(
  api: DashboardApi,
  runId: string,
  button: HTMLButtonElement,
  received: RunEvent[],
  onPage: (page: { limit: number; has_more: boolean; next_cursor: string | null }) => void,
): Promise<void> {
  if (!api.eventPage || !button.dataset.pageCursor) return;
  button.disabled = true;
  try {
    const page = await api.eventPage(runId, button.dataset.pageCursor);
    const known = new Set(received.map((event) => event.id));
    received.unshift(...page.events.filter((event) => !known.has(event.id)));
    onPage(page.page);
  } catch {
    button.disabled = false;
  }
}

/**
 * In-app destructive confirmation.
 *
 * `window.confirm` blocks the event loop, cannot be styled or themed, ignores the
 * active locale's typography, and is untestable without stubbing a global. A
 * native `<dialog>` gives the focus trap, Escape handling, and inert background
 * for free — the same pattern the settings modals already use.
 */
function confirmAction(root: HTMLElement, message: string, detail = ""): Promise<boolean> {
  const locale = localeOf(root);
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";
  dialog.innerHTML = `
    <p class="confirm-message"></p>
    ${detail ? '<p class="confirm-detail"></p>' : ""}
    <div class="confirm-actions">
      <button type="button" data-confirm="cancel">${tr(locale, "Cancel", "取消")}</button>
      <button type="button" data-confirm="confirm" class="confirm-primary">${tr(locale, "Confirm", "确认")}</button>
    </div>`;
  // `form method="dialog"` is not implemented consistently outside browsers, so
  // the buttons close the dialog explicitly.
  dialog.querySelectorAll<HTMLButtonElement>("[data-confirm]").forEach((button) => {
    button.addEventListener("click", () => closeModal(dialog, button.dataset.confirm ?? "cancel"));
  });
  // textContent, not innerHTML: the message can carry Core-supplied identifiers.
  const messageNode = dialog.querySelector<HTMLElement>(".confirm-message");
  if (messageNode) messageNode.textContent = message;
  const detailNode = dialog.querySelector<HTMLElement>(".confirm-detail");
  if (detailNode) detailNode.textContent = detail;

  root.append(dialog);
  openModal(dialog);
  dialog.querySelector<HTMLButtonElement>(".confirm-primary")?.focus();

  return new Promise<boolean>((resolve) => {
    dialog.addEventListener("close", () => {
      // Escape closes with an empty returnValue, which must mean "do not act".
      const accepted = dialog.returnValue === "confirm";
      dialog.remove();
      resolve(accepted);
    }, { once: true });
  });
}

/**
 * `<dialog>` is native in every browser Restork targets, but `showModal` and
 * `close` are absent under jsdom. Prefer the native implementation and fall back
 * to the observable parts of its contract so behaviour stays testable.
 */
function openModal(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    return;
  }
  dialog.setAttribute("open", "");
}

function closeModal(dialog: HTMLDialogElement, returnValue: string): void {
  if (typeof dialog.close === "function") {
    dialog.close(returnValue);
    return;
  }
  dialog.returnValue = returnValue;
  dialog.removeAttribute("open");
  dialog.dispatchEvent(new Event("close"));
}

/**
 * Controls whose backing capability the connected Core does not expose. 49 of the
 * 78 `DashboardApi` members are optional, so a button can render enabled and then
 * do nothing at all when pressed. A control the user cannot use MUST say so.
 */
const CAPABILITY_CONTROLS: ReadonlyArray<[keyof DashboardApi, string]> = [
  ["listVaultNotes", "[data-vault-clear]"],
  ["searchVaultNotes", "#vault-search-form button[type=submit]"],
  ["previewExtensionInstall", "#extension-install-form button[type=submit]"],
  ["installExtension", "#extension-install-form button[type=submit]"],
  ["setExtensionState", "[data-extension-state]"],
  ["extensionRevisions", "[data-extension-history]"],
  ["searchSessionTools", "#extension-tool-search-form button[type=submit], #tool-search-form button[type=submit]"],
  ["createSchedule", "#schedule-create-form button[type=submit]"],
  ["updateSchedule", "[data-schedule-action=edit]"],
  ["listSchedules", "[data-schedule-active-load], [data-schedule-active-more]"],
  ["listDeletedSchedules", "[data-schedule-trash-load], [data-schedule-trash-more]"],
  ["listScheduleRuns", "[data-schedule-history], [data-schedule-runs-more]"],
  ["restoreSchedule", "[data-schedule-action=restore]"],
  ["changeScheduleState", "[data-schedule-action=pause], [data-schedule-action=resume]"],
  ["runScheduleNow", "[data-schedule-action=run]"],
  ["deleteSchedule", "[data-schedule-action=delete]"],
  ["composeManualReport", "#manual-report-form button[type=submit]"],
  ["composeAiReportDraft", "#ai-report-form button[type=submit]"],
  ["composeDeckDraft", "#presentation-studio-form button[type=submit]"],
  ["previewDeliverableRender", "[data-render-format]"],
  ["exportDeliverableRender", "[data-render-format]"],
  ["saveProviderProfile", "#provider-profile-form button[type=submit]"],
  ["createPromptRevision", "#prompt-revision-form button[type=submit]"],
  ["activatePromptRevision", "[data-prompt-activate]"],
  ["savePersonalSettings", "#personal-settings-form button[type=submit]"],
  ["saveConfigurationProfile", "#configuration-profile-form button[type=submit]"],
  ["searchSessions", "#session-search-form button[type=submit]"],
  ["exportSession", "[data-session-export]"],
  ["archiveSession", "[data-session-archive]"],
  ["deleteSession", "[data-session-delete]"],
  ["createContextPreview", "#context-preview-form button[type=submit]"],
  ["createSessionProposal", "#proposal-form button[type=submit]"],
  ["executeSessionToolCall", "[data-tool-execute]"],
  ["previewSessionToolCall", "[data-tool-preview]"],
  ["connectNativeMail", "[data-native-mail-connect]"],
  ["disconnectNativeMail", "[data-native-mail-disconnect]"],
  ["connectNativeCalendar", "[data-native-calendar-connect]"],
  ["configureMusic", "[data-music-file], [data-music-sync]"],
  ["refreshMusic", "[data-music-refresh]"],
  ["researchMusic", "[data-music-research]"],
  ["forkSession", "#session-fork-form button[type=submit]"],
  ["createSession", "#session-create-form button[type=submit]"],
];

function applyCapabilityGuards(root: HTMLElement, api: DashboardApi, locale: Locale): void {
  const reason = tr(
    locale,
    "The connected Core does not provide this capability.",
    "已连接的 Core 不提供此能力。",
  );
  for (const [capability, selector] of CAPABILITY_CONTROLS) {
    if (api[capability]) continue;
    root.querySelectorAll<HTMLButtonElement>(selector).forEach((control) => {
      control.disabled = true;
      control.setAttribute("aria-disabled", "true");
      control.dataset.unavailableCapability = String(capability);
      if (!control.title) control.title = reason;
    });
  }
}

/**
 * Re-render exactly one paginated panel. Returns false when the panel is not
 * mounted so the caller can fall back to a full render.
 */
function renderListPanel(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  kind: DashboardListKind,
): boolean {
  // `listPanelMarkup` returns null for anything outside the known panel set, so
  // reaching the selector means `kind` is one of five literals and needs no
  // escaping. `CSS.escape` is deliberately avoided: it is absent under jsdom.
  const markup = listPanelMarkup(snapshot, kind, localeOf(root));
  if (markup === null) return false;
  const panel = root.querySelector<HTMLElement>(`[data-view-panel="${kind}"]`);
  if (!panel) return false;
  panel.innerHTML = markup;
  bindListInteractions(root, api, snapshot, panel);
  if (kind === "radar") bindRadarConfig(root, api, snapshot, dailyEffects(root, api, snapshot));
  return true;
}

function listPanelMarkup(
  snapshot: DashboardSnapshot,
  kind: DashboardListKind,
  locale: Locale,
): string | null {
  if (kind === "runs") return runsView(snapshot, locale);
  if (kind === "approvals") {
    return approvalsView(snapshot, locale);
  }
  if (kind === "tasks") return tasksView(snapshot, locale);
  if (kind === "radar") return radarView(snapshot, locale);
  if (kind === "memory") return memoryView(snapshot, locale);
  return null;
}

/**
 * Interactions owned by the paginated list views. Scoped to `host` so a single
 * panel can be re-rendered and re-bound without tearing down the workspace.
 */
function bindListInteractions(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  host: HTMLElement,
): void {
  host.querySelectorAll<HTMLButtonElement>("[data-approval-id]").forEach((button) => {
    button.addEventListener("click", () => void decide(root, api, button));
  });
  host.querySelectorAll<HTMLButtonElement>("[data-task-apply]").forEach((button) => {
    button.addEventListener("click", () => void applyApprovedTask(root, api, button));
  });
  host.querySelectorAll<HTMLInputElement>("input[data-task-id]:not([data-local-todo-toggle])").forEach((input) => {
    input.addEventListener("change", () => void previewTask(root, api, input));
  });
  host.querySelector<HTMLFormElement>("#quick-task-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void captureTask(root, api, event.currentTarget as HTMLFormElement);
  });
  host.querySelector<HTMLFormElement>("#local-todo-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void createLocalTodo(root, api, event.currentTarget as HTMLFormElement);
  });
  host.querySelector<HTMLButtonElement>("[data-todo-suggest]")?.addEventListener("click", () => {
    openTodoSuggestionConversation(root, snapshot);
  });
  host.querySelectorAll<HTMLInputElement>("[data-local-todo-toggle]").forEach((input) => {
    input.addEventListener("change", () => {
      const task = snapshot.taskBoard.tasks.find((item) => item.task_id === input.dataset.taskId);
      if (!task) return;
      input.disabled = true;
      void updateLocalTodo(root, api, task, { completed: input.checked }).catch((error) => {
        input.checked = !input.checked;
        input.disabled = false;
        announceError(root, errorText(error, localeOf(root)));
      });
    });
  });
  host.querySelectorAll<HTMLFormElement>("[data-local-todo-edit]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const task = snapshot.taskBoard.tasks.find((item) => item.task_id === form.dataset.taskId);
      if (!task) return;
      void updateLocalTodo(root, api, task, { form }).catch((error) => {
        announceError(root, errorText(error, localeOf(root)));
      });
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-local-todo-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      button.disabled = true;
      void deleteLocalTodo(
        root,
        api,
        button.dataset.taskId ?? "",
        button.dataset.taskUpdated ?? "",
      ).catch((error) => {
        button.disabled = false;
        announceError(root, errorText(error, localeOf(root)));
      });
    });
  });
  host.querySelectorAll<HTMLButtonElement>("[data-local-todo-restore]").forEach((button) => {
    button.addEventListener("click", () => {
      button.disabled = true;
      void restoreLocalTodo(
        root,
        api,
        button.dataset.taskId ?? "",
        button.dataset.taskUpdated ?? "",
      ).catch((error) => {
        button.disabled = false;
        announceError(root, errorText(error, localeOf(root)));
      });
    });
  });
  host.querySelector<HTMLButtonElement>("[data-deleted-todo-page]")?.addEventListener("click", (event) => {
    void loadMoreDeletedTodos(root, api, snapshot, event.currentTarget as HTMLButtonElement);
  });
  host.querySelectorAll<HTMLButtonElement>("[data-radar-id]").forEach((button) => {
    button.addEventListener("click", () => void actOnRadar(root, api, button));
  });
  host.querySelectorAll<HTMLButtonElement>("[data-run-id]").forEach((button) => {
    button.addEventListener("click", () => void showRun(root, api, snapshot, button));
  });
  host.querySelectorAll<HTMLButtonElement>("[data-page-kind]").forEach((button) => {
    if (button.dataset.pageKind === "events") return;
    button.addEventListener("click", () => void loadMore(root, api, snapshot, button));
  });
}

async function loadMoreDeletedTodos(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  button: HTMLButtonElement,
): Promise<void> {
  const cursor = button.dataset.deletedTodoPage ?? "";
  if (!api.loadDeletedTodos || !cursor) return;
  button.disabled = true;
  try {
    const page = await api.loadDeletedTodos(cursor);
    snapshot.taskBoard.deleted_tasks = appendUnique(
      snapshot.taskBoard.deleted_tasks ?? [],
      page.tasks,
      (item) => item.task_id,
    );
    snapshot.taskBoard.deleted_page = page.page;
    if (!renderListPanel(root, api, snapshot, "tasks")) {
      renderWorkspace(root, api, snapshot);
      selectView(root, "tasks");
    }
  } catch (error) {
    button.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function loadMore(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  button: HTMLButtonElement,
): Promise<void> {
  const kind = button.dataset.pageKind as DashboardListKind;
  const cursor = button.dataset.pageCursor ?? "";
  if (!api.loadPage || !cursor) return;
  button.disabled = true;
  try {
    const page = await api.loadPage(kind, cursor);
    if (page.kind === "runs") snapshot.runs = appendUnique(snapshot.runs, page.items, (item) => item.summary.run_id);
    if (page.kind === "approvals") snapshot.approvals = appendUnique(snapshot.approvals, page.items, (item) => item.approval_id);
    if (page.kind === "tasks") snapshot.taskBoard.tasks = appendUnique(snapshot.taskBoard.tasks, page.items, (item) => item.task_id);
    if (page.kind === "radar") snapshot.radar.items = appendUnique(snapshot.radar.items, page.items, (item) => item.item_id);
    if (page.kind === "memory" && snapshot.memory) {
      snapshot.memory.records = appendUnique(snapshot.memory.records, page.items, (item) => item.memory_id);
      snapshot.memory.counts = page.counts;
      snapshot.memory.architecture = page.architecture;
    }
    snapshot.pagination ??= {};
    snapshot.pagination[kind] = page.page;
    // Pagination appends to one list. Rebuilding the workspace here discarded
    // scroll position, drafts, open disclosures, and the run detail pane.
    if (!renderListPanel(root, api, snapshot, kind)) {
      renderWorkspace(root, api, snapshot);
      selectView(root, kind);
    }
  } catch (error) {
    button.disabled = false;
    announceError(root, errorText(error, localeOf(root)));
  }
}

function appendUnique<T>(current: T[], incoming: T[], identity: (item: T) => string): T[] {
  const known = new Set(current.map(identity));
  return [...current, ...incoming.filter((item) => !known.has(identity(item)))];
}

function startEventStream(
  root: HTMLElement,
  api: DashboardApi,
  runId: string,
  after: number,
  onEvent: (event: RunEvent) => void,
  subscriber = "default",
): AbortController {
  const current = eventStreams.get(root);
  if (current && current.runId === runId && !current.controller.signal.aborted) {
    current.listeners.set(subscriber, onEvent);
    return current.controller;
  }
  stopEventStream(root);
  const controller = new AbortController();
  const listeners = new Map([[subscriber, onEvent]]);
  eventStreams.set(root, { runId, controller, listeners });
  if (typeof api.streamEvents !== "function") return controller;
  void api.streamEvents(runId, after, (event) => {
    for (const listener of listeners.values()) listener(event);
  }, controller.signal).catch((error: unknown) => {
    if (!controller.signal.aborted) announceError(root, errorText(error, localeOf(root)));
  });
  return controller;
}

function stopEventStream(root: HTMLElement): void {
  eventStreams.get(root)?.controller.abort();
  eventStreams.delete(root);
}

function waitStageForEvent(current: AgentWaitStage, event: RunEvent): AgentWaitStage {
  if (["run.failed", "run.cancelled", "research.failed", "study.failed", "work.failed", "model.failed"].includes(event.type)) return "error";
  if (event.type === "run.completed") return "complete";
  if (event.type === "retry.scheduled") return "retry";
  if (event.type === "model.started") return "model";
  if (["model.completed", "research.evidence_built", "artifact.created"].includes(event.type)) return "verify";
  if (["research.source_started", "research.source_completed", "tool.requested", "tool.started", "tool.completed"].includes(event.type)) return "sources";
  const state = typeof event.data.state === "string" ? event.data.state : "";
  if (state === "verifying") return "verify";
  if (state === "completed") return "complete";
  return current;
}

async function refresh(root: HTMLElement, api: DashboardApi, view = "start"): Promise<void> {
  try {
    renderWorkspace(root, api, await api.loadDashboard());
    selectView(root, view);
  } catch (error) {
    announceError(root, errorText(error, localeOf(root)));
  }
}

// A message the user cannot see is not a message. Both live regions stay in the
// DOM so assistive technology keeps its subscription; only visibility changes.
function paintGlobalNotice(root: HTMLElement, message: string, severity: "status" | "error"): void {
  const region = root.querySelector<HTMLElement>("#global-status-region");
  const status = root.querySelector<HTMLElement>("#global-status");
  const alert = root.querySelector<HTMLElement>("#global-alert");
  const dismiss = root.querySelector<HTMLButtonElement>("#global-status-dismiss");
  if (!region || !status || !alert) return;

  const active = severity === "error" ? alert : status;
  const idle = severity === "error" ? status : alert;
  idle.textContent = "";
  idle.hidden = true;
  active.textContent = message;
  active.hidden = message === "";
  region.dataset.visible = message === "" ? "false" : "true";
  if (dismiss) dismiss.hidden = message === "";
}

export function announceStatus(root: HTMLElement, message: string): void {
  paintGlobalNotice(root, message, "status");
}

export function announceError(root: HTMLElement, message: string): void {
  paintGlobalNotice(root, message, "error");
}

export function clearAnnouncement(root: HTMLElement): void {
  paintGlobalNotice(root, "", "status");
}


function configureMusic(root: HTMLElement, api: DashboardApi): void {
  bindSettingsDialog(root, "#music-settings-dialog", "[data-music-open]");
  const form = root.querySelector<HTMLFormElement>("#music-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void syncMusicSource(root, api, form);
  });
  form?.querySelector<HTMLSelectElement>("#music-source")?.addEventListener(
    "change",
    () => updateMusicSourceHelp(root, form),
  );
  if (form) updateMusicSourceHelp(root, form);
  form?.querySelector<HTMLButtonElement>("[data-music-file]")?.addEventListener(
    "click",
    () => void saveMusicFile(root, api, form),
  );
  form?.querySelector<HTMLButtonElement>("[data-music-refresh]")?.addEventListener(
    "click",
    () => void refreshMusic(root, api, form),
  );
  form?.querySelector<HTMLButtonElement>("[data-music-disable]")?.addEventListener(
    "click",
    () => void disableMusic(root, api, form),
  );
  root.querySelector<HTMLButtonElement>("[data-music-research]")?.addEventListener(
    "click",
    (event) => void researchMusic(
      root,
      api,
      event.currentTarget as HTMLButtonElement,
    ),
  );
  const button = root.querySelector<HTMLButtonElement>("[data-music-toggle]");
  const disc = root.querySelector<HTMLElement>("[data-music-disc]");
  if (!button || !disc) return;
  button.addEventListener("click", () => {
    const playing = disc.classList.toggle("is-playing");
    button.setAttribute("aria-pressed", String(playing));
    button.textContent = playing
      ? tr(localeOf(root), "PAUSE CD", "暂停唱片")
      : tr(localeOf(root), "ROTATE CD", "转动唱片");
  });
}

function updateMusicSourceHelp(root: HTMLElement, form: HTMLFormElement): void {
  const select = form.querySelector<HTMLSelectElement>("#music-source");
  const target = form.querySelector<HTMLElement>("[data-music-source-help]");
  const option = select?.selectedOptions[0];
  if (!select || !target || !option) return;
  const source = select.value;
  target.textContent = source === "apple-music"
    ? option.dataset.status === "ready"
      ? tr(localeOf(root), "Official Apple Music API credential is ready.", "Apple Music 官方 API 凭据已就绪。")
      : tr(
        localeOf(root),
        `Native setup required: ${option.dataset.setup || "restorkd music apple configure"}`,
        `需要先配置系统凭据：${option.dataset.setup || "restorkd music apple configure"}`,
      )
    : tr(localeOf(root), "Experimental, credential-free and read-only; only public playlist metadata is read.", "实验性、无需凭据且只读；仅获取公开歌单元数据。");
}

async function syncMusicSource(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  if (!api.configureMusic) return;
  const data = new FormData(form);
  const shareUrl = String(data.get("share_url") ?? "").trim();
  const source = String(data.get("source") ?? "qqmusic");
  try {
    if (!(["qqmusic", "netease", "apple-music"] as string[]).includes(source)) {
      throw new Error(tr(localeOf(root), "Choose a supported music source.", "请选择受支持的音乐来源。"));
    }
    const selected = form.querySelector<HTMLSelectElement>("#music-source")?.selectedOptions[0];
    if (source === "apple-music" && selected?.dataset.status !== "ready") {
      const command = selected?.dataset.setup || "restorkd music apple configure";
      throw new Error(tr(
        localeOf(root),
        `Configure the Apple Music developer token in native credential storage first: ${command}`,
        `请先把 Apple Music developer token 配置到系统凭据库：${command}`,
      ));
    }
    const parsed = new URL(shareUrl);
    const hosts: Record<string, string[]> = {
      qqmusic: ["i2.y.qq.com", "y.qq.com", "www.y.qq.com"],
      netease: ["music.163.com", "www.music.163.com", "y.music.163.com"],
      "apple-music": ["music.apple.com"],
    };
    if (parsed.protocol !== "https:" || !hosts[source].includes(parsed.hostname)) {
      throw new Error(tr(
        localeOf(root),
        "Paste an HTTPS playlist link from the selected source.",
        "请粘贴来自所选来源的 HTTPS 歌单链接。",
      ));
    }
    setMusicBusy(form, true, tr(
      localeOf(root),
      source === "qqmusic"
        ? "Syncing the private snapshot and checking current Cantonese chart candidates…"
        : "Syncing and validating a private local playlist snapshot…",
      source === "qqmusic"
        ? "正在同步私有快照，并检查当前粤语榜单候选……"
        : "正在同步并校验本地私有歌单快照……",
    ));
    await api.configureMusic({
      enabled: true,
      source: source as "qqmusic" | "netease" | "apple-music",
      share_url: shareUrl,
      local_date: localDate(),
    });
    form.reset();
    await refresh(root, api);
    announceStatus(root, tr(
      localeOf(root),
      source === "qqmusic"
        ? "QQ Music connected. Daily analysis and current chart discoveries are ready."
        : "Music source connected. The private daily snapshot is ready.",
      source === "qqmusic"
        ? "QQ 音乐已连接，今日分析和当前榜单发现已经就绪。"
        : "音乐来源已连接，私有每日快照已经就绪。",
    ));
  } catch (error) {
    setMusicBusy(form, false, errorText(error, localeOf(root)));
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function saveMusicFile(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const file = form.querySelector<HTMLInputElement>('input[type="file"]')?.files?.[0];
  if (!file || !api.configureMusic) return;
  try {
    if (!/\.(json|csv)$/i.test(file.name) || file.size > 2_000_000) {
      throw new Error(tr(
        localeOf(root),
        "Select a JSON or CSV playlist no larger than 2 MB.",
        "请选择不超过 2 MB 的 JSON 或 CSV 歌单。",
      ));
    }
    setMusicBusy(form, true, tr(
      localeOf(root),
      "Importing the local private snapshot…",
      "正在导入本地私有快照……",
    ));
    await api.configureMusic({
      enabled: true,
      source: "file",
      filename: file.name,
      content: await file.text(),
      local_date: localDate(),
    });
    form.reset();
    await refresh(root, api);
    announceStatus(root, tr(
      localeOf(root),
      "Private playlist imported. Today's track is ready.",
      "私有歌单已导入，今日推荐已就绪。",
    ));
  } catch (error) {
    setMusicBusy(form, false, errorText(error, localeOf(root)));
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function refreshMusic(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  if (!api.refreshMusic) return;
  try {
    setMusicBusy(form, true, tr(
      localeOf(root),
      "Refreshing the playlist, song details, and Cantonese chart evidence…",
      "正在刷新歌单、歌曲资料和粤语榜单信息……",
    ));
    await api.refreshMusic(localDate());
    await refresh(root, api);
    announceStatus(root, tr(
      localeOf(root),
      "Music snapshot refreshed. Your previous snapshot would have been kept on failure.",
      "音乐快照已刷新；如果刷新失败，旧快照会继续保留。",
    ));
  } catch (error) {
    setMusicBusy(form, false, errorText(error, localeOf(root)));
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function disableMusic(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  if (!api.configureMusic) return;
  try {
    setMusicBusy(form, true, tr(
      localeOf(root),
      "Disconnecting and deleting only Restork's managed copy…",
      "正在断开连接，并仅删除 Restork 管理的副本……",
    ));
    await api.configureMusic({ enabled: false, local_date: localDate() });
    form.reset();
    await refresh(root, api);
    announceStatus(root, tr(
      localeOf(root),
      "Daily track disabled and the imported playlist deleted.",
      "每日一曲已停用，导入的歌单也已删除。",
    ));
  } catch (error) {
    setMusicBusy(form, false, errorText(error, localeOf(root)));
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function researchMusic(
  root: HTMLElement,
  api: DashboardApi,
  button: HTMLButtonElement,
): Promise<void> {
  if (!api.researchMusic) return;
  const original = button.textContent ?? "";
  const status = root.querySelector<HTMLElement>("#music-research-consent");
  button.disabled = true;
  button.classList.add("is-busy");
  button.setAttribute("aria-busy", "true");
  button.textContent = tr(localeOf(root), "SEARCHING SOURCES…", "正在检索来源……");
  if (status) {
    status.classList.add("is-busy");
    status.textContent = tr(
      localeOf(root),
      "V4 Flash is searching, cross-checking and preparing bilingual notes…",
      "V4 Flash 正在检索、交叉核验并生成双语解读……",
    );
  }
  try {
    await api.researchMusic(localDate());
    await refresh(root, api);
    announceStatus(root, tr(
      localeOf(root),
      "Online song research completed and its sources were cached locally.",
      "歌曲联网分析已完成，来源与结果已缓存在本地。",
    ));
  } catch (error) {
    const message = musicResearchErrorText(error, localeOf(root));
    if (root.contains(button)) {
      button.disabled = false;
      button.classList.remove("is-busy");
      button.removeAttribute("aria-busy");
      button.textContent = original;
    }
    if (status && root.contains(status)) {
      status.classList.remove("is-busy");
      status.textContent = message;
    }
    announceError(root, message);
  }
}

function musicResearchErrorText(error: unknown, locale: Locale): string {
  const detail = error instanceof Error ? error.message : errorText(error, locale);
  const match = /song web research failed:\s*([a-z_]+)/i.exec(detail);
  if (!match) return detail;
  const messages: Record<string, [string, string]> = {
    timeout: [
      "Online analysis exceeded the 180-second limit. The previous result is still shown; retry when ready.",
      "联网分析超过 180 秒；仍显示上次结果，你可以稍后手动重试。",
    ],
    invalid_response: [
      "The model returned an unreadable result. The previous result is still shown; retry when ready.",
      "模型返回的结果无法读取；仍显示上次结果，你可以稍后手动重试。",
    ],
    provider_unavailable: [
      "The model service is temporarily unavailable. The previous result is still shown.",
      "模型服务暂时不可用；仍显示上次结果。",
    ],
    sources_missing: [
      "The search finished without public sources that could be verified. The previous result is still shown.",
      "联网检索没有找到能够核对的公开来源；仍显示上次结果。",
    ],
    structured_output_invalid: [
      "The researched result was incomplete. The previous result is still shown.",
      "联网分析结果不完整；仍显示上次结果。",
    ],
  };
  const copy = messages[match[1].toLowerCase()];
  return copy ? tr(locale, copy[0], copy[1]) : tr(
    locale,
    "Online analysis failed. The previous result is still shown; retry when ready.",
    "联网分析未完成；仍显示上次结果，你可以稍后手动重试。",
  );
}

function setMusicBusy(form: HTMLFormElement, busy: boolean, message: string): void {
  form.setAttribute("aria-busy", String(busy));
  form.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = busy;
  });
  const status = form.querySelector<HTMLElement>("[data-music-sync-status]");
  if (status) {
    status.textContent = message;
    status.classList.toggle("is-busy", busy);
  }
}

function localDate(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function loadMusicCover(root: HTMLElement, api: DashboardApi): Promise<void> {
  try {
    const blob = await api.musicCover();
    const image = root.querySelector<HTMLImageElement>("#music-cover");
    if (!blob || !image || typeof URL.createObjectURL !== "function") return;
    releaseCover(root);
    const url = URL.createObjectURL(blob);
    coverUrls.set(root, url);
    image.addEventListener("error", () => {
      image.hidden = true;
      releaseCover(root);
    }, { once: true });
    image.src = url;
    image.hidden = false;
  } catch (error) {
    announceError(root, errorText(error, localeOf(root)));
  }
}

function releaseCover(root: HTMLElement): void {
  const previous = coverUrls.get(root);
  if (previous) URL.revokeObjectURL(previous);
  coverUrls.delete(root);
}

function applyLocale(root: HTMLElement, locale: Locale): void {
  root.dataset.locale = locale;
  document.documentElement.lang = locale;
  document.title = tr(
    locale,
    "Restork · Local Agent Workspace",
    "Restork · 本地智能工作台",
  );
}

function bindLocaleSwitch(root: HTMLElement, rerender: () => void): void {
  root.querySelector<HTMLButtonElement>("[data-locale-switch]")?.addEventListener("click", () => {
    const locale = alternateLocale(localeOf(root));
    persistLocale(locale);
    applyLocale(root, locale);
    rerender();
  });
}

function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function clearWorkFields(form: HTMLFormElement): void {
  for (const name of [
    "workspace_root",
    "workspace_grant_id",
    "target_files",
    "context_files",
    "constraints",
    "non_goals",
    "verification_commands",
  ]) {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      field.value = "";
    }
  }
  const workspaceLabel = form.querySelector<HTMLElement>("[data-start-workspace-label]");
  if (workspaceLabel) {
    workspaceLabel.textContent = workspaceLabel.dataset.emptyLabel ?? "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const app = document.querySelector<HTMLElement>("#app");
if (app && document.body.dataset.restorkDemo !== "true") void mountDetectedDashboard(app);

async function mountDetectedDashboard(root: HTMLElement): Promise<void> {
  const bridge = detectDesktopBridge();
  if (!bridge) {
    await mountBrowserDashboard(root);
    return;
  }
  const api = new LocalApiClient({ onSession: (session) => bridge.store(session) });
  await mountDesktopDashboard(root, api, bridge);
}

async function mountDesktopDashboard(
  root: HTMLElement,
  api: LocalApiClient,
  bridge: DesktopBridge,
): Promise<void> {
  applyLocale(root, detectLocale());
  root.innerHTML = `
    <main class="desktop-bootstrap" aria-labelledby="desktop-bootstrap-title">
      <p class="kicker">RESTORK DESKTOP · PRIVATE LOOPBACK</p>
      <h1 id="desktop-bootstrap-title">${tr(localeOf(root), "Pairing with the local Core", "正在连接本地 Core")}</h1>
      <p data-desktop-status role="status">${tr(localeOf(root), "Restoring the in-memory local session…", "正在恢复内存中的本地会话…")}</p>
      <span class="agent-wait-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    </main>`;
  const status = root.querySelector<HTMLElement>("[data-desktop-status]");
  try {
    const session = await bridge.session();
    if (session.kind === "pairing") {
      await api.pair(session.pairing_code);
    } else {
      const recovered = await api.resumeSession({
        accessToken: session.access_token,
        expiresAt: session.expires_at,
      });
      if (!recovered) throw new Error("desktop_session_recovery_failed");
    }
    renderWorkspace(root, api, await api.loadDashboard());
  } catch {
    if (status) {
      status.textContent = `${desktopSessionError(localeOf(root))} ${tr(
        localeOf(root),
        "Reopen Restork only if the session has been offline for more than seven days.",
        "仅当 Restork 已离线超过七天时，才需要重新打开应用。",
      )}`;
    }
  }
}

function desktopSessionError(locale: Locale): string {
  return tr(
    locale,
    "The desktop shell could not establish its private local session.",
    "桌面端未能建立私有本地会话。",
  );
}
