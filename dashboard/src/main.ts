import "./styles.css";

import { LocalApiClient, systemTimeZone } from "./api/client";
import { detectDesktopBridge } from "./desktop";
import type { DesktopBridge } from "./desktop";
import type {
  ConversationTurn,
  DashboardApi,
  DashboardListKind,
  DashboardSnapshot,
  Mode,
  RadarAction,
  ReasoningEffortV2,
  ProviderKindV2,
  RunEvent,
  WorkDataClass,
  WorkHandoffPreview,
  WorkResultManifest,
} from "./api/types";
import {
  agentWaitMarkup,
  conversationOperationWaitMarkup,
  errorText,
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
import {
  alternateLocale,
  detectLocale,
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
const eventStreams = new WeakMap<HTMLElement, AbortController>();
const conversationStreams = new WeakMap<HTMLElement, {
  controller: AbortController;
  operationId: string;
}>();

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

export function mountDashboard(root: HTMLElement, options: MountOptions = {}): void {
  const api = options.api ?? new LocalApiClient();
  applyLocale(root, options.locale ?? detectLocale());
  if (options.snapshot) {
    renderWorkspace(root, api, options.snapshot);
    return;
  }
  renderPairing(root, api);
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
  releaseCover(root);
  root.innerHTML = workspaceMarkup(snapshot, locale);
  startClock(root);
  bindLocaleSwitch(root, () => {
    const view = root.querySelector<HTMLElement>("[data-view].is-active")?.dataset.view ?? "overview";
    renderWorkspace(root, api, snapshot);
    selectView(root, view);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.addEventListener("click", () => selectView(root, button.dataset.view ?? "overview"));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => openRunForm(root, button.dataset.mode as Mode));
  });
  root.querySelector<HTMLFormElement>("#run-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void createRun(root, api, event.currentTarget as HTMLFormElement);
  });
  root.querySelector<HTMLButtonElement>("#refresh")?.addEventListener("click", () => {
    void refresh(root, api);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-approval-id]").forEach((button) => {
    button.addEventListener("click", () => void decide(root, api, button));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-task-apply]").forEach((button) => {
    button.addEventListener("click", () => void applyApprovedTask(root, api, button));
  });
  root.querySelectorAll<HTMLInputElement>("[data-task-id]").forEach((input) => {
    input.addEventListener("change", () => void previewTask(root, api, input));
  });
  root.querySelector<HTMLFormElement>("#quick-task-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void captureTask(root, api, event.currentTarget as HTMLFormElement);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-radar-id]").forEach((button) => {
    button.addEventListener("click", () => void actOnRadar(root, api, button));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-run-id]").forEach((button) => {
    button.addEventListener("click", () => void showRun(root, api, snapshot, button));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-page-kind]").forEach((button) => {
    if (button.dataset.pageKind === "events") return;
    button.addEventListener("click", () => void loadMore(root, api, snapshot, button));
  });
  configureMusic(root, api);
  configureWeather(root, api);
  configureCalendar(root, api);
  configureProvider(root, api, snapshot);
  configureRustWorkspace(root, api, snapshot);
  if (snapshot.daily?.music.recommendation?.cover_available) {
    void loadMusicCover(root, api);
  }
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
      host.innerHTML = `<p class="fine">${tr(localeOf(root), "Searching local FTS index…", "正在搜索本地 FTS 索引…")}</p>`;
      void api.searchSessions(query).then((hits) => {
        host.innerHTML = hits.map((hit) => `<button type="button" data-session-hit="${escapeStatus(hit.session_id)}"><span>${escapeStatus(hit.excerpt)}</span><small>#${hit.sequence}</small></button>`).join("") || `<p class="fine">${tr(localeOf(root), "No match.", "没有匹配项。")}</p>`;
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
      announce(root, tr(localeOf(root), "Conversation export downloaded locally.", "对话导出已下载到本地。"));
    }).catch((error) => announce(root, errorText(error, localeOf(root))));
  });

  root.querySelector<HTMLButtonElement>("[data-session-archive]")?.addEventListener("click", () => {
    const pane = root.querySelector<HTMLElement>(".conversation-pane");
    const sessionId = pane?.dataset.activeSession ?? "";
    const version = Number(pane?.dataset.activeVersion ?? "0");
    if (!sessionId || !version || !api.archiveSession) return;
    void api.archiveSession(sessionId, version)
      .then(() => reloadWorkspaceView(root, api, "conversation"))
      .catch((error) => announce(root, errorText(error, localeOf(root))));
  });

  root.querySelector<HTMLButtonElement>("[data-session-delete]")?.addEventListener("click", () => {
    const pane = root.querySelector<HTMLElement>(".conversation-pane");
    const sessionId = pane?.dataset.activeSession ?? "";
    const version = Number(pane?.dataset.activeVersion ?? "0");
    if (!sessionId || !version || !api.deleteSession) return;
    if (!window.confirm(tr(localeOf(root), "Delete this local conversation permanently?", "永久删除这个本地对话？"))) return;
    void api.deleteSession(sessionId, version)
      .then(() => reloadWorkspaceView(root, api, "conversation"))
      .catch((error) => announce(root, errorText(error, localeOf(root))));
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
      }).catch((error) => announce(root, errorText(error, localeOf(root))));
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
          "Checking data boundaries and creating a conversation branch…",
          "正在检查数据边界并创建对话分支…",
        );
      }
      void api.forkSession(sessionId, title, profileId, expectedUpdatedAt, 24).then((fork) => {
        snapshot.workspaceV2?.sessions.unshift(fork.session);
        renderWorkspace(root, api, snapshot);
        selectView(root, "conversation");
        return selectSession(fork.session.session_id, fork.session.title, fork.session.profile_id)
          .then(() => announce(root, tr(
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
      announce(root, tr(
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
              announce(root, errorText(error, localeOf(root)));
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
        announce(root, errorText(error, localeOf(root)));
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
      announce(root, errorText(error, localeOf(root)));
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
    preview.innerHTML = `<div class="conversation-wait"><i></i><span>${tr(localeOf(root), "Building a local, tool-free proposal…", "正在本地生成无工具提案…")}</span></div>`;
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
    host.innerHTML = `<div class="conversation-wait"><i></i><span>${tr(localeOf(root), "Searching the frozen catalog…", "正在搜索冻结目录…")}</span></div>`;
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
      void api.savePersonalSettings(version || null, settings).then((record) => {
        if (snapshot.workspaceV2) snapshot.workspaceV2.personal = record;
        form.dataset.version = String(record.version);
        if (status) status.textContent = tr(localeOf(root), "Saved on this device.", "已保存在本设备。");
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
        host.innerHTML = artifacts.map((artifact) => `<article><strong>Restork ${escapeStatus(artifact.version)}</strong><span>${escapeStatus(artifact.target)}</span><small>SHA-256 ${escapeStatus(artifact.sha256.slice(0, 16))}…</small><code>${escapeStatus(artifact.filename)}</code></article>`).join("")
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
      const model = form?.elements.namedItem("model") as HTMLInputElement | null;
      const secretRef = form?.elements.namedItem("secret_ref") as HTMLInputElement | null;
      const authKind = selected?.dataset.authKind ?? (kind === "ollama" ? "none" : "bearer");
      const registryBaseUrl = selected?.dataset.baseUrl;
      if (baseUrl && registryBaseUrl) baseUrl.value = registryBaseUrl;
      if (authKind === "none") {
        if (model) model.value = "";
        if (secretRef) {
          secretRef.value = "";
          secretRef.disabled = true;
        }
      } else {
        if (secretRef) secretRef.disabled = false;
        if (kind === "deepseek") {
          if (model) model.value = "deepseek-v4-pro";
        } else if (model) {
          model.value = "";
        }
      }
      if (form) syncReasoningControls(form);
    });
  providerForm?.querySelector<HTMLSelectElement>('[name="reasoning_effort"]')
    ?.addEventListener("change", () => syncReasoningControls(providerForm));
  if (providerForm) syncReasoningControls(providerForm);

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
        announce(root, tr(localeOf(root), "Provider record could not be opened.", "无法打开此供应商记录。"));
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
          announce(root, errorText(error, localeOf(root)));
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
      if (status) status.textContent = tr(localeOf(root), "Freezing profile boundaries…", "正在冻结 Profile 边界…");
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

  configureExtensionCenter(root, api);
  configureDeliverables(root, api);
  configureAutomation(root, api);

  const first = snapshot.workspaceV2.sessions.find((session) => session.status === "active");
  if (first) void selectSession(first.session_id, first.title, first.profile_id);
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
        execute?.addEventListener("click", () => {
          if (!api.executeSessionToolCall) return;
          if (!window.confirm(tr(
            localeOf(root),
            `Run ${preview.resolved_call.real_tool_id} with the exact reviewed input?`,
            `使用刚才审查的精确输入运行 ${preview.resolved_call.real_tool_id}？`,
          ))) return;
          execute.disabled = true;
          execute.textContent = tr(localeOf(root), "RUNNING IN SANDBOX…", "正在沙箱中运行…");
          void api.executeSessionToolCall(sessionId, preview).then((execution) => {
            host.innerHTML = `<article class="proposal-card"><header><strong>${tr(localeOf(root), "MCP execution", "MCP 执行")}</strong><span>${escapeMarkup(execution.state)}</span></header><p>${tr(localeOf(root), "Tool output is untrusted data and grants no new authority.", "工具输出是不受信任的数据，不会获得任何新权限。")}</p><pre>${escapeMarkup(JSON.stringify(execution, null, 2))}</pre></article>`;
          }).catch((error) => {
            execute.disabled = false;
            execute.textContent = tr(localeOf(root), "APPROVE & RUN", "批准并运行");
            announce(root, errorText(error, localeOf(root)));
          });
        });
      }).catch((error) => {
        button.disabled = false;
        announce(root, errorText(error, localeOf(root)));
      });
    });
  });
}

function escapeMarkup(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function configureExtensionCenter(root: HTMLElement, api: DashboardApi): void {
  root.querySelectorAll<HTMLButtonElement>("[data-extension-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.extensionFilter ?? "all";
      root.querySelectorAll<HTMLButtonElement>("[data-extension-filter]")
        .forEach((item) => item.classList.toggle("is-active", item === button));
      root.querySelectorAll<HTMLElement>("[data-extension-card-kind]").forEach((card) => {
        card.hidden = kind !== "all" && card.dataset.extensionCardKind !== kind;
      });
    });
  });
  root.querySelector<HTMLFormElement>("#extension-install-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const status = form.querySelector<HTMLElement>("#extension-install-status");
    if (!api.installExtension) return;
    let manifest: Record<string, unknown>;
    try {
      const parsed = JSON.parse(String(data.get("manifest") ?? "")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      manifest = parsed as Record<string, unknown>;
    } catch {
      if (status) status.textContent = tr(localeOf(root), "Manifest must be one JSON object.", "清单必须是一个 JSON 对象。");
      return;
    }
    if (status) status.textContent = tr(localeOf(root), "Validating and quarantining…", "正在验证并隔离…");
    void api.installExtension(
      String(data.get("package_kind") ?? "skill") as "skill" | "mcp" | "plugin",
      manifest,
    ).then(() => reloadWorkspaceView(root, api, "extensions"))
      .catch((error) => { if (status) status.textContent = errorText(error, localeOf(root)); });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-extension-state]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.extensionState as "enable" | "disable";
      const packageId = button.dataset.extensionId ?? "";
      const hash = button.dataset.extensionHash ?? "";
      if (!packageId || !hash || !api.setExtensionState) return;
      if (action === "enable" && !window.confirm(tr(localeOf(root), `Enable ${packageId} at this exact reviewed hash?`, `按当前已审查哈希启用 ${packageId}？`))) return;
      button.disabled = true;
      void api.setExtensionState(packageId, action, hash)
        .then(() => reloadWorkspaceView(root, api, "extensions"))
        .catch((error) => { button.disabled = false; announce(root, errorText(error, localeOf(root))); });
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
            rollback.textContent = tr(localeOf(root), "REVIEW ROLLBACK", "审查回滚");
            rollback.addEventListener("click", () => {
              if (!window.confirm(tr(localeOf(root), `Create a reviewed rollback to ${record.manifest_hash?.slice(0, 16)}…? It will not execute a tool.`, `创建回滚到 ${record.manifest_hash?.slice(0, 16)}… 的审查记录？它不会执行工具。`))) return;
              rollback.disabled = true;
              void api.rollbackExtension?.(packageId, currentHash, record.manifest_hash ?? "")
                .then(() => reloadWorkspaceView(root, api, "extensions"))
                .catch((error) => {
                  rollback.disabled = false;
                  announce(root, errorText(error, localeOf(root)));
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
    host.innerHTML = `<p class="fine">${tr(localeOf(root), "Searching frozen catalog…", "正在搜索冻结目录…")}</p>`;
    void api.searchSessionTools(sessionId, query).then((result) => {
      host.innerHTML = toolSearchMarkup(result, localeOf(root));
      bindToolPreview(root, api, host, sessionId);
    }).catch((error) => { host.textContent = errorText(error, localeOf(root)); });
  });
}

function configureDeliverables(root: HTMLElement, api: DashboardApi): void {
  root.querySelectorAll<HTMLButtonElement>("[data-render-format]").forEach((button) => {
    button.addEventListener("click", () => {
      const deliverableId = button.dataset.renderId ?? "";
      const revision = Number(button.dataset.renderRevision ?? "0");
      const format = button.dataset.renderFormat as "pptx" | "pdf";
      if (!deliverableId || revision < 1 || !api.previewDeliverableRender || !api.exportDeliverableRender) return;
      button.disabled = true;
      button.textContent = tr(localeOf(root), "RENDERING PREVIEW…", "正在渲染预览…");
      void api.previewDeliverableRender(deliverableId, revision, format).then(async (preview) => {
        const approved = window.confirm(tr(
          localeOf(root),
          `Download deterministic ${format.toUpperCase()} (${preview.manifest.byte_count} bytes)?\nSHA-256: ${preview.manifest.artifact_hash}`,
          `下载可复现的 ${format.toUpperCase()}（${preview.manifest.byte_count} 字节）？\nSHA-256：${preview.manifest.artifact_hash}`,
        ));
        if (!approved) return;
        const download = await api.exportDeliverableRender?.(preview);
        if (!download) return;
        const url = URL.createObjectURL(download.blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = download.filename;
        anchor.click();
        URL.revokeObjectURL(url);
        announce(root, tr(
          localeOf(root),
          `${download.filename} is ready. SHA-256 ${download.artifactHash}`,
          `${download.filename} 已生成。SHA-256 ${download.artifactHash}`,
        ));
      }).catch((error) => announce(root, errorText(error, localeOf(root))))
        .finally(() => {
          button.disabled = false;
          button.textContent = format === "pptx"
            ? tr(localeOf(root), "REVIEW PPTX", "审查 PPTX")
            : tr(localeOf(root), "REVIEW PDF", "审查 PDF");
        });
    });
  });
  root.querySelector<HTMLFormElement>("#manual-report-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const status = form.querySelector<HTMLElement>("#manual-report-status");
    const entries = lines(data.get("entries"));
    if (!entries.length || !api.composeManualReport) return;
    if (status) status.textContent = tr(localeOf(root), "Building evidence-labelled Markdown…", "正在生成带证据标签的 Markdown…");
    const section = String(data.get("section") ?? "completed") as
      "summary" | "completed" | "progress" | "decisions" | "blockers" | "next" | "notes";
    void api.composeManualReport({
      report_id: String(data.get("report_id") ?? "").trim(),
      revision: 1,
      kind: String(data.get("kind") ?? "daily") as "daily" | "weekly",
      title: String(data.get("title") ?? "").trim(),
      language: localeOf(root) === "zh-CN" ? "zh-CN" : "en-US",
      timezone: systemTimeZone(),
      entries: entries.map((text) => ({ section, text })),
    }).then(() => reloadWorkspaceView(root, api, "deliverables"))
      .catch((error) => { if (status) status.textContent = errorText(error, localeOf(root)); });
  });
  root.querySelector<HTMLFormElement>("#deck-from-report-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const select = form.elements.namedItem("report") as HTMLSelectElement | null;
    const option = select?.selectedOptions[0];
    const status = form.querySelector<HTMLElement>("#deck-from-report-status");
    if (!option || !api.composeDeckFromReport) return;
    if (status) status.textContent = tr(localeOf(root), "Freezing claims, citations, and slide roles…", "正在冻结主张、引用与页面角色…");
    void api.composeDeckFromReport({
      deck_id: String(data.get("deck_id") ?? "").trim(),
      revision: 1,
      report_id: option.value,
      report_revision: Number(option.dataset.revision ?? "1"),
      language: localeOf(root) === "zh-CN" ? "zh-CN" : "en-US",
      audience: {
        audience_id: String(data.get("audience") ?? "team").trim(),
        purpose: String(data.get("purpose") ?? "").trim(),
        expertise: String(data.get("expertise") ?? "").trim(),
      },
    }).then(() => reloadWorkspaceView(root, api, "deliverables"))
      .catch((error) => { if (status) status.textContent = errorText(error, localeOf(root)); });
  });
}

function configureAutomation(root: HTMLElement, api: DashboardApi): void {
  root.querySelector<HTMLFormElement>("#schedule-create-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const [hour, minute] = String(data.get("time") ?? "09:00").split(":").map(Number);
    const recurrence = String(data.get("recurrence") ?? "daily");
    const jobValue = String(data.get("job") ?? "health.check");
    const status = form.querySelector<HTMLElement>("#schedule-create-status");
    if (!api.createSchedule) return;
    const job = jobValue.startsWith("model:")
      ? { kind: "model_draft" as const, profile_id: jobValue.slice(6), requested_effect: null }
      : { kind: "deterministic" as const, job: jobValue as "health.check" | "daily.refresh" };
    const scheduleRecurrence = recurrence === "weekly"
      ? { kind: "weekly" as const, weekday_monday_zero: Number(data.get("weekday") ?? "0"), hour, minute }
      : { kind: "daily" as const, hour, minute };
    if (status) status.textContent = tr(localeOf(root), "Saving a bounded schedule…", "正在保存有界调度…");
    void api.createSchedule({
      schedule_id: String(data.get("schedule_id") ?? "").trim(),
      timezone: systemTimeZone(),
      recurrence: scheduleRecurrence,
      missed_run_policy: "create_draft",
      job,
    }).then(() => reloadWorkspaceView(root, api, "automation"))
      .catch((error) => { if (status) status.textContent = errorText(error, localeOf(root)); });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-schedule-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.scheduleAction ?? "";
      const scheduleId = button.dataset.scheduleId ?? "";
      const revision = Number(button.dataset.scheduleRevision ?? "0");
      if (!scheduleId || !revision) return;
      if (action === "delete" && !window.confirm(tr(
        localeOf(root),
        "Remove this schedule and its local run history?",
        "移除此调度及其本地运行历史？",
      ))) return;
      button.disabled = true;
      const operation = action === "run" && api.runScheduleNow
        ? api.runScheduleNow(scheduleId).then(() => undefined)
        : action === "delete" && api.deleteSchedule
          ? api.deleteSchedule(scheduleId, revision)
          : (action === "pause" || action === "resume") && api.changeScheduleState
            ? api.changeScheduleState(scheduleId, action, revision).then(() => undefined)
            : Promise.resolve();
      void operation.then(() => reloadWorkspaceView(root, api, "automation"))
        .catch((error) => { button.disabled = false; announce(root, errorText(error, localeOf(root))); });
    });
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
    configured: option.dataset.providerConfigured === "true",
  };
}

function overviewProviderCommand(kind: ProviderKindV2): string {
  return kind === "ollama"
    ? "ollama serve"
    : `restorkd provider configure ${kind}`;
}

function setOverviewProviderActionAvailability(root: HTMLElement): void {
  const selected = overviewProviderSelection(root);
  root.querySelectorAll<HTMLButtonElement>("[data-provider-diagnostic]").forEach((button) => {
    const webSearch = button.dataset.providerDiagnostic === "web_search";
    button.hidden = webSearch && selected?.kind !== "deepseek";
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
  const summary = root.querySelector<HTMLElement>("[data-provider-summary]");
  const result = root.querySelector<HTMLElement>("#provider-diagnostic-result");
  const manage = root.querySelector<HTMLButtonElement>("[data-open-provider-settings]");
  if (title) title.textContent = selected.configured
    ? selected.displayName
    : tr(locale, `Configure ${selected.displayName}`, `配置 ${selected.displayName}`);
  if (model) model.textContent = selected.configured
    ? `${selected.kind} / ${selected.model}`
    : tr(locale, "No model profile saved", "尚未保存模型 Profile");
  if (command) command.textContent = overviewProviderCommand(selected.kind);
  if (help) help.textContent = selected.kind === "ollama"
    ? tr(
      locale,
      "No API key is needed. Start Ollama locally, then save its exact loopback model profile.",
      "无需 API Key。请先在本机启动 Ollama，再保存精确的 loopback 模型 Profile。",
    )
    : tr(
      locale,
      "Run this in Terminal. The key stays in native credentials and never enters the browser.",
      "请在终端运行这条命令。Key 只保存在系统凭据库中，不会进入浏览器。",
    );
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
        ? tr(locale, "Run Test model to verify this exact saved model.", "请点击“测试模型”验证这个已保存的精确模型。")
        : tr(locale, "Open Settings to enter the model ID and save this provider.", "请打开设置，填写模型 ID 并保存这个供应商。"))}</p>`;
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
        action === "web_search" ? "web_search" : "primary",
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
  const target = trigger.dataset.providerWebSearch === "true" ? "web_search" : "primary";
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
      "The local Core was still unreachable after one bounded retry.",
      "经过一次有界重试后，仍无法连接本地 Core。",
    );
  }
  return tr(
    activeLocale,
    "Core rejected the request before a safe provider report was available.",
    "Core 在生成安全的模型检查报告前拒绝了请求。",
  );
}

function configureWeather(root: HTMLElement, api: DashboardApi): void {
  bindSettingsDialog(root, "#weather-settings-dialog", "[data-weather-open]");
  const form = root.querySelector<HTMLFormElement>("#weather-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveWeather(root, api, form);
  });
  form?.querySelector<HTMLButtonElement>("[data-weather-disable]")?.addEventListener(
    "click",
    () => void disableWeather(root, api, form),
  );
  form?.querySelector<HTMLButtonElement>("[data-weather-locate]")?.addEventListener(
    "click",
    () => void locateWeather(root, api, form),
  );
}

async function saveWeather(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const data = new FormData(form);
  const query = String(data.get("query") ?? "").trim();
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api.configureWeather({
      enabled: true,
      mode: "query",
      query,
      language: localeOf(root) === "zh-CN" ? "zh" : "en",
    });
    form.reset();
    await refresh(root, api);
    announce(root, tr(
      localeOf(root),
      `Weather enabled for ${result.location_label}.`,
      `已为 ${result.location_label} 启用天气。`,
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announce(root, errorText(error, localeOf(root)));
  }
}

async function locateWeather(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  announce(root, tr(
    localeOf(root),
    "Waiting for browser location permission…",
    "正在等待浏览器定位授权…",
  ));
  try {
    const position = await currentPosition();
    await api.configureWeather({
      enabled: true,
      mode: "coordinates",
      label: tr(localeOf(root), "Current location", "当前位置"),
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    });
    form.reset();
    await refresh(root, api);
    announce(root, tr(
      localeOf(root),
      "Weather enabled from the location you approved.",
      "已使用你授权的位置启用天气。",
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announce(root, geolocationError(error, localeOf(root)));
  }
}

async function disableWeather(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
): Promise<void> {
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await api.configureWeather({ enabled: false });
    form.reset();
    await refresh(root, api);
    announce(root, tr(
      localeOf(root),
      "Weather disabled and its saved location cleared.",
      "天气已停用，保存的位置也已清除。",
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announce(root, errorText(error, localeOf(root)));
  }
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
    announce(root, calendar.configured
      ? tr(
          localeOf(root),
          "System Calendar connected in read-only mode.",
          "系统日历已以只读方式连接。",
        )
      : calendar.message);
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announce(root, errorText(error, localeOf(root)));
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
    announce(root, tr(
      localeOf(root),
      "Calendar imported in read-only mode using system time.",
      "日历已按系统时间以只读方式导入。",
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announce(root, errorText(error, localeOf(root)));
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
    announce(root, tr(
      localeOf(root),
      "Calendar disabled and its private import removed.",
      "日历已停用，私有导入副本已移除。",
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    announce(root, errorText(error, localeOf(root)));
  }
}

function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Browser location is unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      maximumAge: 10 * 60 * 1000,
      timeout: 15_000,
    });
  });
}

function geolocationError(error: unknown, locale: Locale): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? Number((error as { code: unknown }).code)
    : 0;
  if (code === 1) {
    return tr(
      locale,
      "Location permission was not granted. You can still enter a city.",
      "未授予定位权限，你仍可直接输入城市。",
    );
  }
  return tr(
    locale,
    "Current location is unavailable. You can still enter a city.",
    "无法获取当前位置，你仍可直接输入城市。",
  );
}

function selectView(root: HTMLElement, view: string): void {
  if (view !== "runs") stopEventStream(root);
  root.querySelectorAll<HTMLElement>("[data-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== view;
    panel.classList.toggle("is-visible", !panel.hidden);
  });
  root.querySelectorAll<HTMLElement>("[data-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
}

function openRunForm(root: HTMLElement, mode: Mode): void {
  const panel = root.querySelector<HTMLElement>("#action-panel");
  const field = root.querySelector<HTMLInputElement>("#run-mode");
  if (panel) panel.hidden = false;
  if (field) field.value = mode;
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
  if (mode !== "study") {
    const studyHost = root.querySelector<HTMLElement>("#study-workspace");
    if (studyHost) studyHost.replaceChildren();
  }
  if (mode !== "work") {
    const workHost = root.querySelector<HTMLElement>("#work-workspace");
    if (workHost) workHost.replaceChildren();
  }
  root.querySelector<HTMLInputElement>("#run-goal")?.focus();
}

async function createRun(root: HTMLElement, api: DashboardApi, form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const mode = String(data.get("mode")) as Mode;
  const goal = String(data.get("goal") ?? "").trim();
  const targetNote = String(data.get("target_note") ?? "").trim() || null;
  const dataClass = String(data.get("context_data_class") ?? "public") as WorkDataClass;
  const workspaceRoot = String(data.get("workspace_root") ?? "").trim();
  const targetFiles = lines(data.get("target_files"));
  const status = root.querySelector<HTMLElement>("#action-status");
  const waitHost = root.querySelector<HTMLElement>("#agent-wait-host");
  if (!goal) return;
  if (mode === "work" && (!workspaceRoot || !targetFiles.length)) {
    if (status) {
      status.textContent = tr(
        localeOf(root),
        "Work requires a workspace root and at least one target file.",
        "Work 需要工作区根路径和至少一个目标文件。",
      );
    }
    return;
  }
  if (status) status.textContent = tr(localeOf(root), "Creating a local run…", "正在创建本地运行…");
  if (waitHost) waitHost.innerHTML = agentWaitMarkup("prepare", localeOf(root));
  let stream: AbortController | null = null;
  try {
    const run = await api.createRun(mode, goal, dataClass);
    let waitStage: AgentWaitStage = "prepare";
    stream = startEventStream(root, api, run.run_id, 0, (event) => {
      waitStage = waitStageForEvent(waitStage, event);
      if (waitHost?.isConnected) waitHost.innerHTML = agentWaitMarkup(waitStage, localeOf(root));
    });
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
      const host = root.querySelector<HTMLElement>("#study-workspace");
      if (host) {
        host.innerHTML = studyDiagnosticMarkup(diagnostic, localeOf(root));
        bindStudyDiagnostic(root, api);
      }
    } else if (mode === "work") {
      if (waitHost) waitHost.innerHTML = agentWaitMarkup("sources", localeOf(root));
      const plan = await api.planWork(run.run_id, {
        goal,
        workspace_root: workspaceRoot,
        target_files: targetFiles,
        context_files: lines(data.get("context_files")),
        constraints: lines(data.get("constraints")),
        non_goals: lines(data.get("non_goals")),
        completion_criteria: [tr(
          localeOf(root),
          "produce a reviewable verified artifact",
          "产出可审阅、可验证的结果",
        )],
        verification_commands: lines(data.get("verification_commands")),
        context_data_class: dataClass,
      });
      const host = root.querySelector<HTMLElement>("#work-workspace");
      if (host) {
        host.innerHTML = workPlanMarkup(plan, localeOf(root));
        bindWorkPlan(root, api);
      }
      clearWorkFields(form);
    } else {
      if (waitHost) waitHost.innerHTML = agentWaitMarkup("complete", localeOf(root));
      await refresh(root, api, "runs");
    }
    if (mode !== "research" && waitHost?.isConnected) {
      waitHost.innerHTML = agentWaitMarkup("complete", localeOf(root));
    }
  } catch (error) {
    if (waitHost?.isConnected) waitHost.innerHTML = agentWaitMarkup("error", localeOf(root));
    if (status) status.textContent = errorText(error, localeOf(root));
  } finally {
    if (stream && eventStreams.get(root) === stream) stopEventStream(root);
  }
}

function bindWorkPlan(root: HTMLElement, api: DashboardApi): void {
  const button = root.querySelector<HTMLButtonElement>("[data-work-preview]");
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
    const host = root.querySelector<HTMLElement>("#work-workspace");
    if (host) {
      host.innerHTML = workHandoffMarkup(preview, localeOf(root));
      bindWorkHandoff(root, api, preview);
    }
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

function bindWorkHandoff(
  root: HTMLElement,
  api: DashboardApi,
  preview: WorkHandoffPreview,
): void {
  const exportButton = root.querySelector<HTMLButtonElement>("[data-work-export]");
  exportButton?.addEventListener("click", () => {
    void approveAndExportWork(root, api, preview, exportButton);
  });
  const rejectButton = root.querySelector<HTMLButtonElement>("[data-work-reject]");
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
    const host = root.querySelector<HTMLElement>("#work-workspace");
    if (host) {
      host.innerHTML = workExportMarkup(result, preview.plan, localeOf(root));
      bindWorkVerification(root, api);
    }
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
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
    const host = root.querySelector<HTMLElement>("#work-workspace");
    if (host) host.replaceChildren();
    announce(root, tr(
      localeOf(root),
      "Work handoff rejected. No package was exported.",
      "Work 交接已拒绝。没有导出任何交接包。",
    ));
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

function bindWorkVerification(root: HTMLElement, api: DashboardApi): void {
  const form = root.querySelector<HTMLFormElement>("[data-work-verify]");
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
    const host = root.querySelector<HTMLElement>("#work-workspace");
    if (host) host.innerHTML = workVerificationMarkup(report, localeOf(root));
  } catch (error) {
    if (submit) submit.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

function bindStudyDiagnostic(root: HTMLElement, api: DashboardApi): void {
  const form = root.querySelector<HTMLFormElement>("[data-study-diagnostic]");
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
  try {
    const artifact = await api.submitStudyDiagnostic(form.dataset.runId ?? "", answers);
    const host = root.querySelector<HTMLElement>("#study-workspace");
    if (host) {
      host.innerHTML = studyArtifactMarkup(artifact, localeOf(root));
      bindStudyPractice(root, api);
    }
  } catch (error) {
    if (submit) submit.disabled = false;
    announce(root, errorText(error, localeOf(root)));
  }
}

function bindStudyPractice(root: HTMLElement, api: DashboardApi): void {
  root.querySelectorAll<HTMLFormElement>("[data-study-practice]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitStudyPractice(root, api, form);
    });
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
  if (submit) submit.disabled = true;
  try {
    const result = await api.submitStudyPractice(
      form.dataset.runId ?? "",
      form.dataset.exerciseId ?? "",
      answer,
      confidence,
    );
    form.reset();
    const feedback = form.querySelector<HTMLElement>(".study-attempt");
    if (feedback) feedback.innerHTML = studyAttemptMarkup(result, localeOf(root));
  } catch (error) {
    announce(root, errorText(error, localeOf(root)));
  } finally {
    if (submit) submit.disabled = false;
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
    if (decision === "approve" && approval.action_kind === "task_write") {
      await api.applyTask(approval.approval_id);
      await refresh(root, api, "tasks");
    } else if (decision === "approve" && approval.action_kind === "handoff_export") {
      await api.exportWorkHandoff(approval.run_id, approval.approval_id);
      await refresh(root, api, "runs");
    } else {
      await refresh(root, api, "approvals");
    }
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
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
      }
    }
  } catch (error) {
    if (target) target.innerHTML = agentWaitMarkup("error", localeOf(root));
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
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
    announce(root, tr(
      localeOf(root),
      "Markdown diff ready for approval.",
      "已生成 Markdown diff，等待审批。",
    ));
    await refresh(root, api, "approvals");
  } catch (error) {
    input.checked = !input.checked;
    input.disabled = false;
    announce(root, errorText(error, localeOf(root)));
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
    announce(root, errorText(error, localeOf(root)));
  }
}

async function applyApprovedTask(
  root: HTMLElement,
  api: DashboardApi,
  button: HTMLButtonElement,
): Promise<void> {
  button.disabled = true;
  try {
    await api.applyTask(button.dataset.taskApply ?? "");
    await refresh(root, api, "tasks");
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
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
        render();
      });
    }
  } catch (error) {
    detail.textContent = errorText(error, localeOf(root));
  }
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
    renderWorkspace(root, api, snapshot);
    selectView(root, kind);
  } catch (error) {
    button.disabled = false;
    announce(root, errorText(error, localeOf(root)));
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
): AbortController {
  stopEventStream(root);
  const controller = new AbortController();
  eventStreams.set(root, controller);
  void api.streamEvents(runId, after, onEvent, controller.signal).catch((error: unknown) => {
    if (!controller.signal.aborted) announce(root, errorText(error, localeOf(root)));
  });
  return controller;
}

function stopEventStream(root: HTMLElement): void {
  eventStreams.get(root)?.abort();
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

async function refresh(root: HTMLElement, api: DashboardApi, view = "overview"): Promise<void> {
  try {
    renderWorkspace(root, api, await api.loadDashboard());
    selectView(root, view);
  } catch (error) {
    announce(root, errorText(error, localeOf(root)));
  }
}

function announce(root: HTMLElement, message: string): void {
  const target = root.querySelector<HTMLElement>("#global-status")
    ?? root.querySelector<HTMLElement>("#action-status");
  if (target) target.textContent = message;
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
      : tr(localeOf(root), `Native setup required: ${option.dataset.setup || "restorkd music apple configure"}`, `需要先配置系统凭据：${option.dataset.setup || "restorkd music apple configure"}`)
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
    announce(root, tr(
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
    announce(root, errorText(error, localeOf(root)));
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
    announce(root, tr(
      localeOf(root),
      "Private playlist imported. Today's track is ready.",
      "私有歌单已导入，今日推荐已就绪。",
    ));
  } catch (error) {
    setMusicBusy(form, false, errorText(error, localeOf(root)));
    announce(root, errorText(error, localeOf(root)));
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
      "正在刷新歌单、歌曲资料和粤语榜单证据……",
    ));
    await api.refreshMusic(localDate());
    await refresh(root, api);
    announce(root, tr(
      localeOf(root),
      "Music snapshot refreshed. Your previous snapshot would have been kept on failure.",
      "音乐快照已刷新；如果刷新失败，旧快照会继续保留。",
    ));
  } catch (error) {
    setMusicBusy(form, false, errorText(error, localeOf(root)));
    announce(root, errorText(error, localeOf(root)));
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
    announce(root, tr(
      localeOf(root),
      "Daily track disabled and the imported playlist deleted.",
      "每日一曲已停用，导入的歌单也已删除。",
    ));
  } catch (error) {
    setMusicBusy(form, false, errorText(error, localeOf(root)));
    announce(root, errorText(error, localeOf(root)));
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
    announce(root, tr(
      localeOf(root),
      "Online song research completed and its sources were cached locally.",
      "歌曲联网分析已完成，来源与结果已缓存在本地。",
    ));
  } catch (error) {
    if (root.contains(button)) {
      button.disabled = false;
      button.classList.remove("is-busy");
      button.removeAttribute("aria-busy");
      button.textContent = original;
    }
    if (status && root.contains(status)) {
      status.classList.remove("is-busy");
      status.textContent = errorText(error, localeOf(root));
    }
    announce(root, errorText(error, localeOf(root)));
  }
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
    announce(root, errorText(error, localeOf(root)));
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const app = document.querySelector<HTMLElement>("#app");
if (app) void mountDetectedDashboard(app);

async function mountDetectedDashboard(root: HTMLElement): Promise<void> {
  const bridge = detectDesktopBridge();
  if (!bridge) {
    mountDashboard(root);
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
      api.restoreSession({
        accessToken: session.access_token,
        expiresAt: session.expires_at,
      });
    }
    renderWorkspace(root, api, await api.loadDashboard());
  } catch {
    if (status) {
      status.textContent = `${desktopSessionError(localeOf(root))} ${tr(
        localeOf(root),
        "Restart Restork to create a fresh local session.",
        "请重启 Restork 以创建新的本地会话。",
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
