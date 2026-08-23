import "./styles.css";

import { LocalApiClient, systemTimeZone } from "./api/client";
import { bindDesktopExternalLinks, detectDesktopBridge } from "./desktop";
import { isRunActive } from "./runState";
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
  waitNextForError,
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
import {
  agentWaitMarkup,
  runtimeActivityForEvent,
} from "./ui/runtimeScene";
import type { AgentWaitStage, RuntimeActivity } from "./ui/runtimeScene";
import { startClock } from "./ui/clock";
import { startSky } from "./ui/sky";
import {
  activeView,
  bindEnterToSubmit,
  bindRovingFocus,
  bindSettingsDialog,
  escapeMarkup,
  fillModeWorkspace,
  paintNavBadge,
} from "./ui/dom";
import { configureAutomation } from "./features/automation";
import { announceError, announceStatus, clearAnnouncement } from "./ui/notices";
export { announceError, announceStatus, clearAnnouncement };
import { bindRunDetailScrollbar, bindRunDetailTabs, loadRunDetailFirstPage, prepareRunDetail, syncRunDetailScrollbar, type RunDetailTab } from "./features/runDetail";
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
import { configureStartWorkspace, jumpToStartMode, modeWorkspaceNote } from "./features/start";
import { paintStartRunEvent, prepareStartRunFeedback, setStartRunBusy } from "./features/startRunPaint";
import { configureToolPicker, pickedAllowedTools } from "./features/startToolPicker";
import { selectedReasoningEffort } from "./features/startReasoning";
import { configureCommandPalette } from "./features/commandPalette";
import { configurePreviewDialog } from "./features/previewDialog";
import { configureRuntimeScene } from "./features/runtimeScene";
import { configureCyberpunkTheme } from "./features/cyberpunkTheme";
import { configureMusic, loadMusicCover, releaseCover } from "./features/music";
import { configureSkillFolderImport, createExtensionInstallPreviewCard } from "./features/skillImport";
import {
  configureSkillTriggers,
  enabledSkills,
  paintConversationSuggestion,
  pinSkillOnStart,
  selectedSkillIds,
} from "./features/skillSuggest";
import { applyView, bindNavigation, currentPanel } from "./features/navigation";
import { captureWorkspaceChrome, restoreWorkspaceChrome } from "./features/workspaceChrome";
import { bindProviderProfileId } from "./features/settings";
import { configureUpdates } from "./features/updates";
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
const commandPaletteCleanups = new WeakMap<HTMLElement, () => void>();
const updateCleanups = new WeakMap<HTMLElement, () => void>();
const cyberpunkCleanups = new WeakMap<HTMLElement, () => void>();

/**
 * Escape closes the topmost dismissible surface regardless of where focus sits.
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

    const region = root.querySelector<HTMLElement>("#global-status-region");
    if (region?.dataset.visible === "true") {
      event.preventDefault();
      clearAnnouncement(root);
    }
  };

  document.addEventListener("keydown", handler);
  dismissHandlers.set(root, handler);
}

const THEMES = new Set(["system", "light", "dark", "cyberpunk"]);

/**
 * Apply the stored theme to the document root. `styles.css` resolves its colour
 * tokens from `[data-theme]`, with `system` deferring to `prefers-color-scheme`.
 * Without this the Theme control round-trips to Core and changes nothing.
 */
export function applyTheme(theme: string | undefined): void {
  const selected = theme && THEMES.has(theme) ? theme : "system";
  document.documentElement.dataset.theme = selected;
  paintBrowserChrome(selected);
}

// The desktop shell and mobile browsers paint their own chrome from this meta
// tag. Left at the light value it frames a dark workspace in cream.
const THEME_CHROME: Record<string, string> = {
  light: "#fbf8f1",
  dark: "#1a1713",
  cyberpunk: "#070b17",
};

function paintBrowserChrome(selected: string): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const resolved = selected === "system" ? (prefersDark ? "dark" : "light") : selected;
  meta.content = THEME_CHROME[resolved] ?? THEME_CHROME.light;
}

function applyWorkspaceTheme(root: HTMLElement, theme: string | undefined): void {
  applyTheme(theme);
  cyberpunkCleanups.get(root)?.();
  cyberpunkCleanups.delete(root);
  cyberpunkCleanups.set(root, configureCyberpunkTheme(root, document.documentElement.dataset.theme));
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
  const chrome = captureWorkspaceChrome(root);
  const locale = localeOf(root);
  stopEventStream(root);
  stopMailStream(root);
  stopVaultStream(root);
  releaseCover(root);
  cyberpunkCleanups.get(root)?.();
  cyberpunkCleanups.delete(root);
  root.innerHTML = workspaceMarkup(snapshot, locale);
  applyWorkspaceTheme(root, snapshot.workspaceV2?.personal?.settings.theme);
  startClock(root);
  startSky(root, snapshot.daily?.weather);
  bindProviderDiagnosticDismiss(root);
  root.querySelector<HTMLButtonElement>("#global-status-dismiss")?.addEventListener("click", () => {
    clearAnnouncement(root);
  });
  bindDismissStack(root);
  commandPaletteCleanups.get(root)?.();
  commandPaletteCleanups.set(root, configureCommandPalette(root, {
    selectView: (view) => revealView(root, api, snapshot, view),
    selectMode: (mode) => {
      root.querySelector<HTMLButtonElement>(`[data-start-mode="${mode}"]`)?.click();
    },
    pinSkill: (skillId) => {
      const skill = enabledSkills(snapshot).find((item) => item.id === skillId);
      if (skill) {
        pinSkillOnStart(root, skill, {
          selectView: (view) => revealView(root, api, snapshot, view),
          selectMode: (mode) => {
            root.querySelector<HTMLButtonElement>(`[data-start-mode="${mode}"]`)?.click();
          },
        });
      }
    },
  }));
  configurePreviewDialog(root);
  configureSkillTriggers(root, snapshot);
  configureToolPicker(root, api, snapshot);
  updateCleanups.get(root)?.();
  updateCleanups.set(root, configureUpdates(root, detectDesktopBridge(), {
    openSettings: () => selectView(root, "settings"),
  }));
  bindLocaleSwitch(root, () => {
    const view = currentPanel(root);
    renderWorkspace(root, api, snapshot);
    revealView(root, api, snapshot, view);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      revealView(root, api, snapshot, button.dataset.view ?? "overview");
    });
  });
  const nav = root.querySelector<HTMLElement>(".sidebar nav");
  if (nav) bindRovingFocus(nav, "[data-view]");
  root.querySelectorAll<HTMLElement>("[data-roving-group]").forEach((group) => {
    bindRovingFocus(group, "button");
  });
  bindNavigation(root, {
    selectView: (view) => revealView(root, api, snapshot, view),
  });
  root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      if (mode === "research" || mode === "study" || mode === "work") {
        jumpToStartMode(root, mode, (view) => revealView(root, api, snapshot, view));
      }
    });
  });
  const desktopBridge = detectDesktopBridge();
  bindDesktopExternalLinks(root, desktopBridge, (error) => {
    announceError(root, errorText(error, localeOf(root)));
  });
  configureStartWorkspace(root, snapshot, {
    submit: (form) => { void createRun(root, api, form, snapshot); },
    selectView: (view) => revealView(root, api, snapshot, view),
    resume: (runId, state, createdAt) => resumeStartRun(root, api, runId, state, createdAt),
    cancel: (runId) => { void cancelStartRun(root, api, runId); },
    loadRunSummary: api.loadRunSummary?.bind(api),
    acceptRunSummary: api.acceptRunSummary
      ? async (runId) => { await api.acceptRunSummary?.(runId); }
      : undefined,
    dismissRunSummary: api.dismissRunSummary
      ? async (runId) => { await api.dismissRunSummary?.(runId); }
      : undefined,
    ...(desktopBridge ? { chooseWorkspace: async () => {
      const selection = await desktopBridge.chooseWorkspace();
      if (!selection || selection.status === "cancelled") return null;
      return { grantId: selection.grantId, label: selection.label };
    } } : {}),
  });
  configureRuntimeScene(root);
  root.querySelector<HTMLButtonElement>("#refresh")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (button.getAttribute("aria-busy") === "true") return;
    const view = currentPanel(root);
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
  configureMusic(root, api, (target, client) => refresh(target, client));
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
  if (chrome) {
    restoreWorkspaceChrome(root, chrome, (view) => revealView(root, api, snapshot, view));
  }
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
    () => {
      root.dataset.settingsTab = "models";
      selectView(root, "settings");
    },
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
  if (messageText && messageForm) bindEnterToSubmit(messageText, () => messageForm.requestSubmit());
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

  const personalSettingsForm = root.querySelector<HTMLFormElement>("#personal-settings-form");
  personalSettingsForm?.querySelector<HTMLSelectElement>('select[name="theme"]')?.addEventListener(
    "change",
    (event) => {
      applyWorkspaceTheme(root, (event.currentTarget as HTMLSelectElement).value);
    },
  );
  personalSettingsForm?.addEventListener(
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
        startup_page: String(data.get("startup_page") ?? "start") as "start" | "dashboard",
      };
      if (status) status.textContent = tr(localeOf(root), "Saving locally…", "正在保存到本地…");
      // Apply before the round trip so the control is not a placebo if the save
      // is slow; the reconciliation below corrects it if Core stored something else.
      applyWorkspaceTheme(root, settings.theme);
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
        applyWorkspaceTheme(root, snapshot.workspaceV2?.personal?.settings.theme);
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
  if (providerForm) bindProviderProfileId(providerForm);
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
  configureSkillFolderImport(root, api);
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
            execute.textContent = tr(localeOf(root), "Approve & run", "批准并运行");
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
        jumpToStartMode(root, mode, (view) => revealView(root, api, snapshot, view));
      }
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-core-skill-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const view = button.dataset.coreSkillView;
      if (view) {
        revealView(root, api, snapshot, view);
        const heading = root.querySelector<HTMLElement>(`[data-view-panel="${view}"] h2`);
        if (heading) {
          heading.tabIndex = -1;
          heading.focus();
        }
      }
    });
  });
  let extensionKind = "all";
  const extensionQuery = root.querySelector<HTMLInputElement>("[data-extension-search]");
  const extensionCount = root.querySelector<HTMLElement>("[data-extension-result-count]");
  const extensionEmpty = root.querySelector<HTMLElement>("[data-extension-filter-empty]");
  const applyExtensionFilters = (): void => {
    const query = extensionQuery?.value.trim().toLocaleLowerCase() ?? "";
    let visible = 0;
    root.querySelectorAll<HTMLElement>("[data-extension-card-kind]").forEach((card) => {
      const match = (extensionKind === "all" || card.dataset.extensionCardKind === extensionKind)
        && (!query || (card.dataset.extensionSearchText ?? "").includes(query));
      card.hidden = !match;
      if (match) visible += 1;
    });
    if (extensionCount) extensionCount.textContent = tr(localeOf(root), `${visible} shown`, `显示 ${visible} 项`);
    if (extensionEmpty) extensionEmpty.hidden = visible > 0;
  };
  root.querySelectorAll<HTMLButtonElement>("[data-extension-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      extensionKind = button.dataset.extensionFilter ?? "all";
      root.querySelectorAll<HTMLButtonElement>("[data-extension-filter]")
        .forEach((item) => {
          const selected = item === button;
          item.classList.toggle("is-active", selected);
          item.setAttribute("aria-pressed", String(selected));
          item.tabIndex = selected ? 0 : -1;
        });
      applyExtensionFilters();
    });
  });
  extensionQuery?.addEventListener("input", applyExtensionFilters);
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
      const card = createExtensionInstallPreviewCard(root, preview, async (approve) => {
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
              "Install reviewed version",
              "安装已核验版本",
            );
            announceError(root, errorText(error, localeOf(root)));
          });
      });
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
            rollback.textContent = tr(localeOf(root), "View rollback", "查看回滚内容");
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
    ? tr(locale, "Manage models", "管理模型")
    : tr(locale, "Configure provider", "配置供应商");
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
      root.dataset.settingsTab = "models";
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

function revealView(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  view: string,
): void {
  selectView(root, view);
  if (view === "vault") void openVaultWorkspace(root, api);
  if (view === "radar") {
    void refreshRadarPanel(root, api, snapshot, dailyEffects(root, api, snapshot));
  }
  if (view === "start") resumeStartRunFromSnapshot(root, api, snapshot);
}

function selectView(root: HTMLElement, view: string): void {
  const previousView = currentPanel(root);
  const resolved = applyView(root, view);
  if (resolved.panel !== "runs" && resolved.panel !== "start") stopEventStream(root);
  if (resolved.panel !== "vault") stopVaultStream(root);
  if (previousView && previousView !== resolved.panel) {
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
    const unseen = Math.max(raw - (seen.get(view) ?? 0), 0);
    paintNavBadge(badge, unseen, tr(localeOf(root), `${unseen} new`, `${unseen} 项新增`));
  });
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
    const skillIds = form.id === "start-run-form" ? selectedSkillIds(form) : [];
    const allowedTools = form.id === "start-run-form" ? pickedAllowedTools(form) : [];
    const reasoningEffort = form.id === "start-run-form" ? selectedReasoningEffort(form) : undefined;
    const run = reasoningEffort === undefined
      ? await api.createRun(mode, goal, dataClass, providerProfileId, skillIds, allowedTools)
      : await api.createRun(mode, goal, dataClass, providerProfileId, skillIds, allowedTools, reasoningEffort);
    createdRun = run;
    if (waitHost) {
      const createdAt = Date.parse(run.created_at);
      waitHost.dataset.runtimeStartedAt = String(Number.isNaN(createdAt) ? Date.now() : createdAt);
    }
    if (form.id === "start-run-form") prepareStartRunFeedback(surface, run.run_id);
    if (waitHost?.isConnected && form.id === "start-run-form") {
      waitHost.innerHTML = agentWaitMarkup("prepare", localeOf(root), { cancellable: true });
    }
    let waitStage: AgentWaitStage = "prepare";
    let runtimeActivity: RuntimeActivity = {};
    stream = startEventStream(root, api, run.run_id, 0, (event) => {
      waitStage = waitStageForEvent(waitStage, event);
      runtimeActivity = runtimeActivityForEvent(runtimeActivity, event);
      if (waitHost?.isConnected) {
        waitHost.innerHTML = agentWaitMarkup(waitStage, localeOf(root), {
          activity: runtimeActivity,
          cancellable: form.id === "start-run-form",
        });
      }
      if (form.id === "start-run-form") paintStartRunEvent(surface, event, localeOf(root), api, run.run_id, mode);
    }, form.id === "start-run-form" ? "start" : "launcher");
    if (status) {
      status.textContent = tr(
        localeOf(root),
        `Created ${run.run_id}`,
        `已创建 ${run.run_id}`,
      );
    }
    if (mode === "study" || mode === "work") {
      if (waitHost) {
        waitHost.innerHTML = agentWaitMarkup("sources", localeOf(root), {
          activity: runtimeActivity,
          cancellable: form.id === "start-run-form",
        });
      }
    }
    if (mode === "study") {
      const diagnostic = await api.prepareStudy(run.run_id, goal, targetNote);
      const host = surface.querySelector<HTMLElement>("[data-study-workspace]");
      if (host) {
        fillModeWorkspace(host, studyDiagnosticMarkup(diagnostic, localeOf(root)), modeWorkspaceNote("study-diagnostic", localeOf(root)));
        bindStudyDiagnostic(root, api, host);
      }
    } else if (mode === "work") {
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
          "产出你能够查看并核对的结果",
        )],
        verification_commands: lines(data.get("verification_commands")),
        context_data_class: dataClass,
      });
      const host = surface.querySelector<HTMLElement>("[data-work-workspace]");
      if (host) {
        fillModeWorkspace(host, workPlanMarkup(plan, localeOf(root)), modeWorkspaceNote("work-plan", localeOf(root)));
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
    const locale = localeOf(root);
    const reason = errorText(error, locale);
    if (waitHost?.isConnected) {
      waitHost.innerHTML = agentWaitMarkup(
        neverStarted ? "blocked" : "error",
        locale,
        { reason, next: waitNextForError(error, locale) },
      );
    }
    if (status) status.textContent = reason;
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
    (entry) => isRunActive(entry.summary.state),
  );
  if (active) {
    resumeStartRun(
      root,
      api,
      active.summary.run_id,
      active.summary.state,
      active.summary.created_at,
      active.summary.mode,
    );
  }
}

function resumeStartRun(
  root: HTMLElement,
  api: DashboardApi,
  runId: string,
  state: string,
  createdAt?: string,
  mode?: string,
): void {
  const surface = root.querySelector<HTMLElement>(".start-workspace");
  const panel = surface?.closest<HTMLElement>("[data-view-panel]");
  if (!surface || panel?.hidden) return;
  prepareStartRunFeedback(surface, runId);
  setStartRunBusy(surface, true);
  const status = surface.querySelector<HTMLElement>("[data-run-status]");
  const waitHost = surface.querySelector<HTMLElement>("[data-run-wait]");
  if (waitHost) {
    const startedAt = createdAt ? Date.parse(createdAt) : Number.NaN;
    waitHost.dataset.runtimeStartedAt = String(Number.isNaN(startedAt) ? Date.now() : startedAt);
  }
  if (status) status.textContent = tr(
    localeOf(root),
    `Continuing ${runId} · ${state}`,
    `继续显示任务 · ${runId}`,
  );
  let waitStage: AgentWaitStage = state === "running" ? "model" : "prepare";
  let runtimeActivity: RuntimeActivity = {};
  if (waitHost) {
    waitHost.innerHTML = agentWaitMarkup(waitStage, localeOf(root), { cancellable: true });
  }
  startEventStream(root, api, runId, 0, (event) => {
    waitStage = waitStageForEvent(waitStage, event);
    runtimeActivity = runtimeActivityForEvent(runtimeActivity, event);
    if (waitHost?.isConnected) {
      waitHost.innerHTML = agentWaitMarkup(waitStage, localeOf(root), {
        activity: runtimeActivity,
        cancellable: true,
      });
    }
    paintStartRunEvent(surface, event, localeOf(root), api, runId, mode);
  }, "start");
}

async function cancelStartRun(root: HTMLElement, api: DashboardApi, runId: string): Promise<void> {
  const surface = root.querySelector<HTMLElement>("#start-run-form");
  const cancel = surface?.querySelector<HTMLButtonElement>("[data-start-cancel]");
  const status = surface?.querySelector<HTMLElement>("[data-run-status]");
  const waitHost = surface?.querySelector<HTMLElement>("[data-run-wait]");
  if (cancel) cancel.disabled = true;
  try {
    await api.cancelRun(runId);
    if (status) status.textContent = tr(localeOf(root), "Stopping task…", "正在停止任务…");
    if (waitHost) waitHost.innerHTML = agentWaitMarkup("cancelling", localeOf(root));
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
      fillModeWorkspace(host, studyArtifactMarkup(artifact, localeOf(root)), modeWorkspaceNote("study-path", localeOf(root)));
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
      fillModeWorkspace(host, workHandoffMarkup(preview, localeOf(root)), modeWorkspaceNote("work-handoff", localeOf(root)));
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
      fillModeWorkspace(host, workExportMarkup(result, preview.plan, localeOf(root)), modeWorkspaceNote("work-export", localeOf(root)));
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
    if (host) fillModeWorkspace(host, "", modeWorkspaceNote("work-rejected", localeOf(root)));
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
    if (host) fillModeWorkspace(host, workVerificationMarkup(report, localeOf(root)), modeWorkspaceNote("work-verified", localeOf(root)));
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
    if (target) {
      target.innerHTML = agentWaitMarkup("error", localeOf(root), {
        reason: errorText(error, localeOf(root)),
        next: waitNextForError(error, localeOf(root)),
      });
    }
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
  bindRunDetailScrollbar(detail);
  prepareRunDetail(root, detail, button, localeOf(root));
  try {
    const [{ firstPage, firstConversation }, loadedResearchArtifact] = await Promise.all([
      loadRunDetailFirstPage(api, run.summary.run_id),
      run.summary.mode === "research" && api.researchArtifact
        ? api.researchArtifact(run.summary.run_id).catch(() => null)
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
    let researchArtifact = loadedResearchArtifact;
    let activeTab: RunDetailTab = researchArtifact ? "result" : "process";
    let firstRender = true;
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
        activeTab,
        researchArtifact,
      });
      if (firstRender) {
        detail.scrollTop = 0;
        firstRender = false;
      }
      syncRunDetailScrollbar(detail);
      bindRunDetailTabs(detail, (tab) => {
        activeTab = tab;
      });
      bindNoteSave(root, api, detail);
      detail.querySelector<HTMLButtonElement>("[data-run-retry]")?.addEventListener("click", (event) => {
        void retryRun(
          root,
          api,
          run.summary.run_id,
          received.at(-1)?.id ?? 0,
          event.currentTarget as HTMLButtonElement,
        );
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
                paintConversationSuggestion(root, snapshot);
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
      paintConversationSuggestion(root, snapshot);
    };
    render(true);
    const after = received.at(-1)?.id ?? 0;
    if (isRunActive(run.summary.state)) {
      startEventStream(root, api, run.summary.run_id, after, (event) => {
        received.push(event);
        if (isRunTerminalEvent(event)) {
          const eventState = typeof event.data.state === "string" ? event.data.state : "";
          run.summary.state = eventState || terminalStateForEvent(event.type);
          run.summary.stop_reason = typeof event.data.stop_reason === "string"
            ? event.data.stop_reason
            : run.summary.stop_reason;
          render();
          if (run.summary.mode === "research" && api.researchArtifact) {
            void api.researchArtifact(run.summary.run_id).then((artifact) => {
              researchArtifact = artifact;
              activeTab = "result";
              render();
            }).catch(() => undefined);
          }
          return;
        }
        // Append one row. Re-rendering the whole run per event made live
        // streaming quadratic and destroyed focus, selection, and scroll.
        if (!appendRunEvent(detail, event, localeOf(root))) render();
      }, "run-detail");
    }
  } catch (error) {
    detail.textContent = errorText(error, localeOf(root));
  }
}

async function retryRun(
  root: HTMLElement,
  api: DashboardApi,
  runId: string,
  after: number,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    if (!api.retryRun) throw new Error(tr(
      localeOf(root),
      "The connected Core does not support retrying this task.",
      "当前连接的 Core 不支持重试这项任务。",
    ));
    await api.retryRun(runId);
    announceStatus(root, tr(localeOf(root), "Task restarted.", "任务已重新开始。"));
    await refresh(root, api, "runs");
    // The advance response only confirms scheduling. Keep following the same
    // durable run so a fast provider failure cannot leave the refreshed UI on
    // the transient `running` snapshot.
    startEventStream(root, api, runId, after, (event) => {
      if (!isRunTerminalEvent(event)) return;
      void refresh(root, api, currentPanel(root) || "runs");
    }, "retry-status");
  } catch (error) {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    announceError(root, errorText(error, localeOf(root)));
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
    if (button.hasAttribute("data-start-cancel")) return;
    button.addEventListener("click", () => void showRun(root, api, snapshot, button));
  });
  host.querySelectorAll<HTMLButtonElement>("[data-run-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.dataset.runFilter ?? "all";
      if (filter === "attn") {
        selectView(root, "approvals");
        return;
      }
      host.querySelectorAll<HTMLButtonElement>("[data-run-filter]").forEach((peer) => {
        peer.setAttribute("aria-pressed", String(peer === button));
      });
      host.querySelectorAll<HTMLElement>("[data-run-list] [data-run-state]").forEach((item) => {
        const live = isRunActive(item.dataset.runState ?? "");
        item.hidden = filter === "live" ? !live : false;
      });
    });
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
  if (event.type === "run.cancelled") return "cancelled";
  if (event.type === "run.stopped") return "error";
  if (["run.failed", "research.failed", "study.failed", "work.failed", "model.failed"].includes(event.type)) return "error";
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

function isRunTerminalEvent(event: RunEvent): boolean {
  return ["run.completed", "run.failed", "run.cancelled", "run.stopped"].includes(event.type);
}

function terminalStateForEvent(type: string): string {
  if (type === "run.completed") return "completed";
  if (type === "run.cancelled") return "cancelled";
  return "failed";
}

async function refresh(root: HTMLElement, api: DashboardApi, view = "start"): Promise<void> {
  try {
    renderWorkspace(root, api, await api.loadDashboard());
    selectView(root, view);
  } catch (error) {
    announceError(root, errorText(error, localeOf(root)));
  }
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
