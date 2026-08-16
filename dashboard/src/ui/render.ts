import type {
  CalendarEvent,
  CatalogRecordV2,
  ConversationTurn,
  DashboardSnapshot,
  DomainKey,
  DomainState,
  MemoryRecord,
  MailSnapshot,
  MarkdownTask,
  MusicDiscovery,
  MusicResearchSummary,
  MusicSourceDefinition,
  PageInfo,
  ProviderDefinitionV2,
  ProviderKindV2,
  RadarItem,
  ResearchArtifact,
  RunEvent,
  RunListEntry,
  StudyArtifact,
  StudyDiagnostic,
  PracticeAttemptResult,
  WorkExportResult,
  WorkHandoffPreview,
  WorkPlanArtifact,
  WorkVerificationReport,
  RunProposalV2,
  ReasoningEffortV2,
  ScheduleJobV2,
  ScheduleRecordV2,
  ScheduleRunV2,
  SessionMessageV2,
  ToolCallPreviewV2,
  ToolSearchResultV2,
  VaultNoteMetadataV2,
  VaultNotePreviewV2,
  VaultSearchHitV2,
} from "../api/types";
import type { Locale } from "../i18n";
import { alternateLocale, plural, tr } from "../i18n";
import { providerDiagnosticMarkup } from "./provider";
import {
  knowledgeSubviewSwitch,
  primaryNav,
  runSubviewSwitch,
  settingsTabSwitch,
} from "./navigation";
import { startWorkspaceMarkup } from "./start";
import { commandPaletteMarkup } from "./commandPalette";
import { deliverablesWorkspace } from "./presentations";
export { presentationTemplateCardsMarkup, presentationTemplateTrashMarkup } from "./presentations";
export { providerDiagnosticMarkup, providerErrorMarkup, providerWaitMarkup } from "./provider";
import { buildRunTrace, traceMarkup } from "./trace";
import { navSpriteMarkup } from "./icons";
import { runBudgetUsedCopy, DEFAULT_MODEL_TURNS } from "./budget";
import { scheduleIntervalField } from "./schedules";
import { timeZoneOptions } from "./timezone";
import { previewDialogMarkup } from "./previewDialog";
import { safeMarkdownPreview } from "./markdown";
import {
  MAX_SCHEDULE_INTERVAL_DAYS,
  MIN_SCHEDULE_INTERVAL_DAYS,
} from "../limits";
import type { AgentWaitNextStep } from "./runtimeScene";
import { approvalCardMarkup } from "./approvals";
export { agentWaitMarkup } from "./runtimeScene";
export type { AgentWaitStage } from "./runtimeScene";

export function pairingMarkup(locale: Locale = "en"): string {
  return `
    <section class="pairing" aria-labelledby="pairing-title">
      ${localeSwitch(locale)}
      <p class="eyebrow">${tr(locale, "Restork · local-first agent · loopback only", "Restork · 本地优先 · 仅本机回环")}</p>
      <h1 id="pairing-title">RES<span>TORK</span></h1>
      <p class="pairing-copy">${tr(locale, "One Core for <b>Research</b>, <b>Study</b>, and <b>Work</b>.", "一个 Core，串起<b>研究</b>、<b>学习</b>与<b>工作</b>。")}</p>
      <form id="pair-form" class="pair-form">
        <label for="pair-code">${tr(locale, "Enter the one-time Web pairing code shown in the terminal", "输入终端显示的一次性 Web 配对码")}</label>
        <div><input id="pair-code" name="code" required autocomplete="off" spellcheck="false"><button type="submit">PAIR</button></div>
      </form>
      <p id="pair-status" class="status" role="status">${tr(locale, "The access token stays in memory. A protected, JavaScript-inaccessible local session keeps this browser paired for up to seven days.", "访问 Token 只留在内存中；浏览器无法读取的本地恢复会话可让配对保持最多七天。")}</p>
    </section>`;
}

export function workspaceMarkup(snapshot: DashboardSnapshot, locale: Locale = "en"): string {
  const active = snapshot.runs.filter((entry) => !isTerminal(entry.summary.state));
  const pending = snapshot.approvals.filter((approval) => approval.decision === "pending");
  const incomplete = snapshot.taskBoard.tasks.filter((task) => !task.completed);
  const memories = snapshot.memory?.records.filter((record) => record.summary) ?? [];
  const v2 = snapshot.workspaceV2;
  const startupPage = snapshot.workspaceV2?.personal?.settings.startup_page === "dashboard"
    ? "overview"
    : "start";
  return `
    ${navSpriteMarkup()}
    <a class="skip-link" href="#workspace-main">${tr(locale, "Skip to main content", "跳到主要内容")}</a>
    <section class="dashboard" aria-label="${tr(locale, "Restork local workspace", "Restork 本地工作台")}">
      <aside class="sidebar">
        <div class="brand"><h1>Restork</h1></div>
        <nav aria-label="${tr(locale, "Main navigation", "主导航")}">
          ${primaryNav(snapshot, locale)}
        </nav>
        ${sidebarIdentity(snapshot, locale)}
      </aside>
      <main class="workspace" id="workspace-main" tabindex="-1">
        <header class="topline">
          <div class="topline-actions">
            <button class="quiet-button command-palette-trigger" type="button" data-command-palette-open aria-keyshortcuts="Meta+K Control+K" aria-haspopup="dialog" aria-controls="command-palette-dialog">⌘K</button>
            ${mailIndicator(snapshot, locale)}
            ${localeSwitch(locale)}
            <button class="quiet-button" id="refresh" type="button">${tr(locale, "REFRESH", "刷新")}</button>
          </div>
        </header>
        <div id="global-status-region" class="status-region">
          <p id="global-status" class="status-note" role="status" hidden></p>
          <p id="global-alert" class="status-note status-note-error" role="alert" hidden></p>
          <button
            id="global-status-dismiss"
            class="status-note-dismiss"
            type="button"
            hidden
            aria-label="${tr(locale, "Dismiss message", "关闭提示")}"
          >×</button>
        </div>
        <aside class="update-notice" data-update-notice hidden aria-live="polite">
          <span data-update-notice-copy></span>
          <div>
            <button type="button" data-update-notice-open>${tr(locale, "VIEW UPDATE", "查看更新")}</button>
            <button type="button" class="quiet-button" data-update-notice-dismiss>${tr(locale, "DISMISS THIS VERSION", "本版本不再提醒")}</button>
          </div>
        </aside>
        ${mailSettings(snapshot, locale)}
        ${commandPaletteMarkup(snapshot, locale)}
        ${previewDialogMarkup(locale)}
        <section class="view ${startupPage === "start" ? "is-visible" : ""}" data-view-panel="start" ${startupPage === "start" ? "" : "hidden"}>${startWorkspaceMarkup(snapshot, locale)}</section>
        <section class="view ${startupPage === "overview" ? "is-visible" : ""}" data-view-panel="overview" ${startupPage === "overview" ? "" : "hidden"}>
          <section class="metrics" aria-label="${tr(locale, "Run overview", "运行概览")}">
            ${metric("research", tr(locale, "Active runs", "进行中运行"), String(active.length), modeCounts(active, locale))}
            ${metric("approval", tr(locale, "Pending approvals", "待审批"), String(pending.length), tr(locale, "Single-use · expires", "单次能力 · 到期失效"))}
            ${metric(
              "work",
              tr(locale, "Tasks", "任务"),
              String(incomplete.length),
              snapshot.taskBoard.vault_configured
                ? tr(locale, "Local Todo + optional Vault sync", "本地 Todo + 可选知识库同步")
                : tr(locale, "Local Todo is ready", "本地 Todo 可直接使用"),
            )}
            ${metric("study", tr(locale, "Saved memories", "已保存内容"), String(memories.length), tr(locale, "Stored on this device", "保存在这台设备上"))}
          </section>
          ${providerSetup(snapshot, locale)}
          ${dailyContext(snapshot, locale)}
          ${overview(snapshot, locale)}
        </section>
        <section class="view" data-view-panel="runs" hidden>${runsView(snapshot, locale)}</section>
        <section class="view" data-view-panel="approvals" hidden>${approvalsView(snapshot, locale)}</section>
        <section class="view" data-view-panel="tasks" hidden>${tasksView(snapshot, locale)}</section>
        <section class="view" data-view-panel="vault" hidden>${vaultWorkspace(snapshot, locale)}</section>
        <section class="view" data-view-panel="radar" hidden>${radarView(snapshot, locale)}</section>
        <section class="view" data-view-panel="memory" hidden>${memoryView(snapshot, locale)}</section>
        ${v2 ? `<section class="view" data-view-panel="conversation" hidden>${conversationWorkspace(snapshot, locale)}</section>` : ""}
        ${v2 ? `<section class="view" data-view-panel="deliverables" hidden>${deliverablesWorkspace(snapshot, locale)}</section>` : ""}
        ${v2 ? `<section class="view" data-view-panel="extensions" hidden>${settingsTabSwitch(locale, "extensions")}${extensionsWorkspace(snapshot, locale)}</section>` : ""}
        ${v2 ? `<section class="view" data-view-panel="automation" hidden>${automationWorkspace(snapshot, locale)}</section>` : ""}
        ${v2 ? `<section class="view" data-view-panel="settings" hidden>${settingsTabSwitch(locale)}${personalSettingsWorkspace(snapshot, locale)}</section>` : ""}
      </main>
    </section>`;
}

function vaultWorkspace(snapshot: DashboardSnapshot, locale: Locale): string {
  const configured = snapshot.taskBoard.configured;
  return `${knowledgeSubviewSwitch(locale, "vault")}<article class="paper-card full-card vault-workspace">
    <header class="vault-heading">
      <div><p class="eyebrow">${tr(locale, "Obsidian vault · local read-only browser", "Obsidian 知识库 · 本地只读浏览")}</p><h2>${tr(locale, "Knowledge library", "知识库")}</h2></div>
      <span id="vault-live-badge" class="ribbon ${configured ? "study" : "work"}">${configured ? tr(locale, "CONNECTING", "连接中") : tr(locale, "NOT CONFIGURED", "未配置")}</span>
    </header>
    <p class="vault-boundary">${tr(
      locale,
      "Search and preview only the Markdown files inside the Vault you explicitly granted. Hidden Obsidian settings, symlinks, absolute paths and oversized notes stay outside this view.",
      "仅搜索和预览你明确授权的 Vault 内 Markdown 文件；Obsidian 隐藏设置、符号链接、绝对路径和超大笔记不会进入此视图。",
    )}</p>
    <form id="vault-search-form" class="vault-search">
      <label for="vault-search">${tr(locale, "Search note names and contents", "搜索笔记名称与正文")}</label>
      <div><input id="vault-search" name="query" maxlength="512" autocomplete="off" placeholder="${tr(locale, "e.g. durable agent loop", "例如：持久化 Agent 循环")}" ${configured ? "" : "disabled"}><button type="submit" ${configured ? "" : "disabled"}>${tr(locale, "SEARCH", "搜索")}</button><button type="button" class="quiet-button" data-vault-clear ${configured ? "" : "disabled"}>${tr(locale, "ALL FILES", "全部文件")}</button></div>
    </form>
    <div class="vault-live-line"><i aria-hidden="true"></i><span id="vault-live-status" role="status" aria-live="polite">${configured ? tr(locale, "Opening the local Vault…", "正在打开本地 Vault……") : tr(locale, "Choose a Vault in Settings and restart Restork.", "请在设置中选择 Vault 后重启 Restork。")}</span></div>
    <div class="vault-browser" aria-busy="${configured ? "true" : "false"}">
      <aside class="vault-files" aria-label="${tr(locale, "Vault files", "Vault 文件")}">
        <div class="vault-files-heading"><strong>${tr(locale, "NOTES", "笔记")}</strong><span id="vault-file-count">—</span></div>
        <div id="vault-file-list" class="vault-file-list" data-roving-group tabindex="0">${configured ? `<p class="empty">${tr(locale, "Reading the safe file index…", "正在读取安全文件索引……")}</p>` : `<p class="empty">${tr(locale, "No Vault is connected.", "尚未连接 Vault。")}</p>`}</div>
      </aside>
      <section id="vault-preview" class="vault-preview" tabindex="0" aria-label="${tr(locale, "Selected note preview", "所选笔记预览")}">
        <div class="vault-preview-empty"><span aria-hidden="true">K</span><h3>${tr(locale, "Select a Markdown note", "选择一篇 Markdown 笔记")}</h3><p>${tr(locale, "The preview is read-only and never executes embedded HTML or scripts.", "预览为只读，不会执行笔记内嵌的 HTML 或脚本。")}</p></div>
      </section>
    </div>
  </article>`;
}

export function vaultFileListMarkup(
  items: Array<VaultNoteMetadataV2 | VaultSearchHitV2>,
  total: number,
  hasMore: boolean,
  locale: Locale,
  query = "",
): string {
  const label = query
    ? tr(locale, `${items.length} matches for “${query}”`, `“${query}” 的 ${items.length} 条结果`)
    : tr(locale, `${total} Markdown notes`, `${total} 篇 Markdown 笔记`);
  const rows = items.map((item) => {
    const path = item.relative_path;
    const segments = path.split("/");
    const name = segments.pop() ?? path;
    const folder = segments.join("/") || tr(locale, "Vault root", "Vault 根目录");
    const detail = "excerpt" in item
      ? item.excerpt
      : `${formatBytes(item.byte_count)} · ${formatTimestamp(item.modified_unix_ms, locale)}`;
    return `<button type="button" class="vault-file" data-vault-path="${escapeHtml(path)}" title="${escapeHtml(path)}"><span aria-hidden="true">¶</span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(folder)}</small><em>${escapeHtml(detail)}</em></button>`;
  }).join("");
  return `<div class="vault-result-label">${escapeHtml(label)}</div>${rows || `<p class="empty">${tr(locale, "No matching Markdown notes. Try another word, or browse the library.", "没有匹配的笔记。换个词再搜，或打开知识库浏览。")}</p>`}${hasMore && !query ? `<button type="button" class="quiet-button vault-load-more" data-vault-load-more>${tr(locale, "LOAD MORE", "加载更多")}</button>` : ""}`;
}

export function vaultNotePreviewMarkup(note: VaultNotePreviewV2, locale: Locale): string {
  const shortHash = note.sha256.slice(0, 12);
  return `<article class="vault-note" data-vault-preview-path="${escapeHtml(note.relative_path)}">
    <header><div><p class="eyebrow">${tr(locale, "READ-ONLY PREVIEW", "只读预览")}</p><h3>${escapeHtml(note.relative_path.split("/").pop() ?? note.relative_path)}</h3><small>${escapeHtml(note.relative_path)}</small></div><span>${formatBytes(note.byte_count)} · SHA-256 ${escapeHtml(shortHash)}…</span></header>
    <div class="vault-untrusted"><b>${tr(locale, "UNTRUSTED NOTE CONTENT", "不受信任的笔记内容")}</b><span>${tr(locale, "Rendered as inert text; embedded HTML and scripts are never executed.", "仅以惰性文本渲染；内嵌 HTML 与脚本永不执行。")}</span></div>
    <section class="vault-reading-view" aria-label="${tr(locale, "Rendered Markdown preview", "Markdown 阅读预览")}">${safeMarkdownPreview(note.content)}</section>
    <button type="button" class="quiet-button" data-preview-open data-preview-kind="markdown"
      data-preview-title="${escapeHtml(note.relative_path)}">${tr(locale, "VIEW MARKDOWN SOURCE", "查看 Markdown 源文件")}</button>
    <div class="preview-source" data-preview-source hidden><pre>${escapeHtml(note.content)}</pre></div>
  </article>`;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(value < 10_240 ? 1 : 0)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function formatTimestamp(value: number, locale: Locale): string {
  if (!Number.isFinite(value) || value <= 0) return tr(locale, "unknown time", "未知时间");
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function mailIndicator(snapshot: DashboardSnapshot, locale: Locale): string {
  const mail = snapshot.daily?.mail;
  if (!mail) return "";
  const label = mail.configured && mail.unread_count !== null
    ? tr(locale, `${mail.unread_count} unread`, `${mail.unread_count} 封未读`)
    : mail.configured
      ? tr(locale, "Mail paused", "邮件暂停")
      : tr(locale, "Mail off", "邮件未启用");
  return `<button class="mail-indicator status-${escapeHtml(mail.status)}" type="button" data-mail-open aria-label="${escapeHtml(tr(locale, `Mail: ${label}`, `邮件：${label}`))}"><span aria-hidden="true">✉</span><strong data-mail-count aria-live="polite">${escapeHtml(label)}</strong><i aria-hidden="true"></i></button>`;
}

function mailSettings(snapshot: DashboardSnapshot, locale: Locale): string {
  const mail = snapshot.daily?.mail;
  const capability = snapshot.daily?.native_mail;
  if (!mail || !capability) return "";
  const canConnect = capability.available && !mail.configured;
  return `<dialog id="mail-settings-dialog" class="settings-dialog mail-settings" aria-labelledby="mail-settings-title">
    <section>
      <header><strong id="mail-settings-title">${tr(locale, "PRIVATE MAIL AWARENESS", "私有邮件提醒")}</strong><button type="button" class="dialog-close" data-settings-close aria-label="${tr(locale, "Close mail settings", "关闭邮件设置")}">×</button></header>
      <p>${tr(locale, "Restork reads the aggregate unread count and up to 20 unread headers (subject, sender, received date) from the already-running macOS Mail app. Message bodies, attachments, and account passwords are never requested.", "Restork 从已运行的 macOS 邮件读取未读总数和最多 20 条未读消息头（主题、发件人、收到时间）。它不会请求正文、附件或账户密码。")}</p>
      <dl class="mail-privacy"><div><dt>${tr(locale, "ACCESS", "访问范围")}</dt><dd>${tr(locale, "Unread count + headers", "未读数量与消息头")}</dd></div><div><dt>${tr(locale, "UPDATE", "更新方式")}</dt><dd>${tr(locale, "Private SSE · 15-second local sample", "私有 SSE · 本地每 15 秒采样")}</dd></div><div><dt>${tr(locale, "STATUS", "状态")}</dt><dd data-mail-dialog-status aria-live="polite">${escapeHtml(mailStatusText(mail, locale))}</dd></div></dl>
      <ul class="mail-headers" data-mail-list>${mailHeadersMarkup(mail, locale)}</ul>
      <p class="fine">${escapeHtml(mailCapabilityText(capability.available, capability.platform, locale))}</p>
      <div class="mail-actions">
        ${mail.configured ? `<button type="button" data-native-mail-disconnect>${tr(locale, "DISCONNECT MAIL", "断开邮件")}</button>` : `<button type="button" data-native-mail-connect ${canConnect ? "" : "disabled"}>${tr(locale, "CONNECT MAIL", "连接邮件")}</button>`}
      </div>
    </section>
  </dialog>`;
}

export function mailHeadersMarkup(mail: MailSnapshot, locale: Locale): string {
  if (!mail.configured || !mail.messages?.length) {
    return `<li class="empty">${tr(locale, "No unread messages to show.", "暂无未读消息。")}</li>`;
  }
  return mail.messages.map((header) => `<li><strong>${escapeHtml(header.subject)}</strong><small>${escapeHtml(header.sender)} · ${escapeHtml(header.date_received)}</small></li>`).join("");
}

function mailStatusText(mail: MailSnapshot, locale: Locale): string {  if (!mail.configured) return tr(locale, "Off — no access requested", "未启用 · 尚未请求权限");
  if (mail.status === "fresh" && mail.unread_count !== null) {
    return tr(locale, `${mail.unread_count} unread · live`, `${mail.unread_count} 封未读 · 实时`);
  }
  if (mail.status === "stale") return tr(locale, "Waiting for macOS Mail", "正在等待 macOS 邮件");
  if (mail.status === "denied") return tr(locale, "Permission denied in System Settings", "系统设置中的权限已被拒绝");
  if (mail.status === "unsupported") return tr(locale, "Unavailable on this platform", "当前平台不可用");
  return tr(locale, "Temporarily unavailable", "暂时不可用");
}

function mailCapabilityText(available: boolean, platform: string, locale: Locale): string {
  if (available && platform === "macos") {
    return tr(locale, "Open Mail first, then Connect. macOS will ask once; Restork never launches Mail silently.", "请先打开系统邮件，再点连接。macOS 会询问一次；Restork 不会静默启动邮件。");
  }
  return tr(locale, "This build has no native mail adapter. Nothing will be requested.", "当前构建没有原生邮件适配器，不会请求任何账户数据。");
}

function sidebarIdentity(snapshot: DashboardSnapshot, locale: Locale): string {
  const name = snapshot.workspaceV2?.personal?.settings.display_name?.trim();
  const label = name || tr(locale, "Set a name", "设置称呼");
  const hint = name
    ? tr(locale, "This device", "本机工作台")
    : tr(locale, "Optional · stays on this device", "可选，只留在这台设备");
  const initial = (name?.charAt(0) || "R").toUpperCase();
  return `<button class="sidebar-identity" type="button" data-view="settings" aria-label="${escapeHtml(tr(locale, "Name and appearance", "称呼与外观"))}">`
    + `<span class="identity-avatar" aria-hidden="true">${escapeHtml(initial)}</span>`
    + `<span class="identity-who"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(hint)}</small></span>`
    + `<svg class="identity-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 14 5-5 5 5"/></svg>`
    + `</button>`;
}

function dataClassLabel(value: string, locale: Locale): string {
  return {
    public: tr(locale, "Public content", "公开内容"),
    personal: tr(locale, "Personal content", "个人内容"),
    confidential: tr(locale, "Confidential content", "机密内容"),
  }[value] ?? value;
}

function dataClassOptions(locale: Locale, selected = "public"): string {
  return ["public", "personal", "confidential"]
    .map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${dataClassLabel(value, locale)}</option>`)
    .join("");
}

function conversationWorkspace(snapshot: DashboardSnapshot, locale: Locale): string {
  const sessions = snapshot.workspaceV2?.sessions ?? [];
  const profiles = snapshot.workspaceV2?.profiles ?? [];
  const providers = new Map(
    (snapshot.workspaceV2?.providers ?? []).map((record) => [
      record.provider.profile_id,
      record.provider,
    ]),
  );
  const active = sessions.find((session) => session.status === "active");
  const customProfiles = profiles.filter(({ profile }) =>
    profile.profile_id !== "safe-mode"
      && profile.profile_id !== "deepseek"
      && profile.profile_id !== "deepseek-flash"
      && providers.has(profile.provider_profile_id)
  );
  const profileLabel = (profile: (typeof profiles)[number]["profile"]): string => {
    const provider = providers.get(profile.provider_profile_id);
    const model = provider
      ? `${provider.display_name} / ${provider.model}`
      : profile.provider_profile_id;
    return `${profile.name} / ${model} / ${dataClassLabel(profile.maximum_data_class, locale)}`;
  };
  const builtInDeepSeek = providers.get("deepseek");
  const builtInDeepSeekLabel = builtInDeepSeek
    ? `${builtInDeepSeek.display_name} / ${builtInDeepSeek.model}`
    : "DeepSeek V4 Pro";
  const builtInFlash = providers.get("deepseek-flash");
  const builtInFlashLabel = builtInFlash
    ? `${builtInFlash.display_name} / ${builtInFlash.model}`
    : "DeepSeek V4 Flash";
  const availableProfiles = [
    {
      profileId: "safe-mode",
      label: tr(locale, "Safe Mode / local only / confidential content", "安全模式 / 仅本地 / 机密内容"),
    },
    {
      profileId: "deepseek",
      label: `${builtInDeepSeekLabel} / ${tr(locale, "cloud / public only", "云端 / 仅 public")}`,
    },
    {
      profileId: "deepseek-flash",
      label: `${builtInFlashLabel} / ${tr(locale, "low latency / public only", "低延迟 / 仅 public")}`,
    },
    ...customProfiles.map(({ profile }) => ({
      profileId: profile.profile_id,
      label: profileLabel(profile),
    })),
  ];
  const activeProfileLabel = availableProfiles.find(
    ({ profileId }) => profileId === active?.profile_id,
  )?.label ?? active?.profile_id ?? tr(locale, "No model selected", "尚未选择模型");
  const firstAlternative = availableProfiles.find(
    ({ profileId }) => profileId !== active?.profile_id,
  )?.profileId;
  const forkProfileOptions = availableProfiles.map(({ profileId, label }) => {
    const current = profileId === active?.profile_id;
    const selected = profileId === firstAlternative;
    return `<option value="${escapeHtml(profileId)}" ${current ? "disabled" : ""} ${selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  const alternativeCount = availableProfiles.filter(
    ({ profileId }) => profileId !== active?.profile_id,
  ).length;
  return `<article class="paper-card full-card conversation-workspace">
    <header><div><p class="eyebrow">${tr(locale, "Conversation", "对话")}</p><h2>${tr(locale, "Conversation", "对话工作区")}</h2></div><span class="ribbon study">${tr(locale, "LOCAL", "本地")}</span></header>
    <div class="conversation-layout">
      <aside class="session-rail">
        <form id="session-create-form"><label for="session-title">${tr(locale, "New conversation", "新建对话")}</label><div><input id="session-title" name="title" maxlength="240" required placeholder="${tr(locale, "What are we working on?", "这次想做什么？")}"><button type="submit" aria-label="${tr(locale, "Create conversation", "创建对话")}">+</button></div><label for="session-profile" class="sr-only">${tr(locale, "Conversation setup", "对话配置")}</label><select id="session-profile" name="profile_id" aria-describedby="session-profile-help"><option value="safe-mode">${tr(locale, "Safe Mode / local only", "安全模式 / 仅本地")}</option><option value="deepseek-flash">${escapeHtml(builtInFlashLabel)} / ${tr(locale, "low latency / public only", "低延迟 / 仅公开内容")}</option><option value="deepseek">${escapeHtml(builtInDeepSeekLabel)} / ${tr(locale, "deeper reasoning / public only", "深度推理 / 仅公开内容")}</option>${customProfiles.map(({ profile }) => `<option value="${escapeHtml(profile.profile_id)}">${escapeHtml(profileLabel(profile))}</option>`).join("")}</select><small id="session-profile-help">${tr(locale, "This conversation keeps the provider and model selected here. Restork will not switch it to a cloud model in the background.", "本次对话会一直使用这里选择的供应商和模型；Restork 不会在后台换成其他云端模型。")}</small></form>
        <form id="session-search-form" class="compact-search"><label class="sr-only" for="session-search">${tr(locale, "Search local knowledge", "搜索本地知识")}</label><input id="session-search" name="query" maxlength="256" placeholder="${tr(locale, "Search conversations, Vault, tasks and Radar", "搜索对话、Vault、任务和 Radar")}"><button type="submit" aria-label="${tr(locale, "Search conversations and local knowledge", "搜索对话与本地知识")}">⌕</button></form><div id="session-search-results" aria-live="polite"></div>
        <div class="session-list" data-roving-group>${sessions.map((session) => `<button type="button" data-session-select="${escapeHtml(session.session_id)}" data-session-title="${escapeHtml(session.title)}" data-session-profile="${escapeHtml(session.profile_id)}" data-session-version="${session.version}" data-session-updated-at="${escapeHtml(session.updated_at)}" class="session-item ${session.session_id === active?.session_id ? "is-active" : ""}"><strong>${escapeHtml(session.title)}</strong><small>${escapeHtml(session.profile_id)} · ${formatDate(session.updated_at, locale)}</small></button>`).join("") || `<p class="empty">${tr(locale, "Create a conversation to begin locally.", "新建一个对话，从本地开始。")}</p>`}</div>
      </aside>
      <section class="conversation-pane" data-active-session="${escapeHtml(active?.session_id ?? "")}" data-active-profile="${escapeHtml(active?.profile_id ?? "safe-mode")}" data-active-updated-at="${escapeHtml(active?.updated_at ?? "")}">
        <header><div><small>${tr(locale, "Selected conversation", "当前对话")}</small><strong id="conversation-title">${escapeHtml(active?.title ?? tr(locale, "No conversation selected", "尚未选择对话"))}</strong></div><div class="session-actions"><span>${tr(locale, "No tools before proposal review", "提案确认前不调用工具")}</span><button type="button" data-session-export ${active ? "" : "disabled"}>${tr(locale, "EXPORT", "导出")}</button><button type="button" data-session-archive ${active ? "" : "disabled"}>${tr(locale, "ARCHIVE", "归档")}</button><button type="button" class="danger-text" data-session-delete ${active ? "" : "disabled"}>${tr(locale, "DELETE", "删除")}</button></div></header>
        <section class="conversation-model-bar" aria-label="${tr(locale, "Conversation model", "对话模型")}">
          <div class="model-profile-current">
            <small>${tr(locale, "MODEL FOR THIS CONVERSATION", "本次对话使用的模型")}</small>
            <strong id="conversation-profile-label">${escapeHtml(activeProfileLabel)}</strong>
            <span>${tr(locale, "The original conversation keeps this provider and model.", "原对话会继续使用这个供应商和模型。")}</span>
          </div>
          <details ${active ? "" : "hidden"}>
            <summary>${tr(locale, "Use another model", "换一个模型继续")}</summary>
            <form id="session-fork-form" data-source-updated-at="${escapeHtml(active?.updated_at ?? "")}">
              <label>${tr(locale, "Saved model setup", "已保存的模型配置")}<select name="profile_id" ${alternativeCount ? "" : "disabled"}>${forkProfileOptions}</select></label>
              <p>${tr(
                locale,
                "Restork creates a separate branch and copies at most 24 recent messages / 120 KB after checking what the new model may receive. The original conversation stays unchanged.",
                "Restork 会新建独立分支，先检查新模型可以接收哪些内容，再复制最多 24 条近期消息 / 120 KB；原对话保持不变。",
              )}</p>
              <div><button type="submit" ${alternativeCount ? "" : "disabled"}>${tr(locale, "FORK WITH THIS MODEL", "用这个模型分叉")}</button><button type="button" class="quiet-button" data-open-provider-settings>${tr(locale, "MODEL SETTINGS", "模型设置")}</button></div>
              <p id="session-fork-status" role="status"></p>
            </form>
          </details>
        </section>
        <div id="conversation-messages" class="conversation-messages" tabindex="0" aria-live="polite"><p class="empty">${active ? tr(locale, "Loading local messages…", "正在加载本地消息…") : tr(locale, "Choose or create a conversation.", "请选择或新建对话。")}</p></div>
        <div id="conversation-wait" aria-live="polite"></div>
        <details class="context-preview" ${active && active.profile_id !== "safe-mode" ? "" : "hidden"}><summary>${tr(locale, "Preview local files before adding them", "添加前预览本地文件")}</summary><form id="context-preview-form"><label>${tr(locale, "Text files (explicit selection only)", "文本文件（仅明确选择）")}<input name="files" type="file" multiple accept=".md,.txt,.json,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.toml,.yaml,.yml"></label><label>${tr(locale, "Content type", "内容类型")}<select name="data_class">${dataClassOptions(locale)}</select></label><button type="submit">${tr(locale, "PREVIEW CONTEXT", "预览内容")}</button></form><div id="context-preview-result" role="status"><p class="fine">${tr(locale, "Restork reads only files you choose here. The preview expires in 15 minutes and can be used once.", "Restork 只读取你在这里选择的文件；预览 15 分钟后过期且只能使用一次。")}</p></div></details>
        <form id="session-message-form" class="conversation-composer" ${active ? "" : "hidden"}><label for="session-message" class="sr-only">${tr(locale, "Message", "消息")}</label><textarea id="session-message" name="content" rows="3" maxlength="1000000" required placeholder="${tr(locale, "Describe what you need. Enter sends; Shift+Enter adds a line.", "说说你需要什么。Enter 发送，Shift+Enter 换行。")}"></textarea><div><select name="data_class" aria-label="${tr(locale, "Content type", "内容类型")}">${dataClassOptions(locale)}</select><button type="submit">${tr(locale, "SEND", "发送")}</button></div></form>
        <form id="proposal-form" class="proposal-composer" ${active ? "" : "hidden"}><label>${tr(locale, "Turn this conversation into a run", "把这段对话变成一次运行")}</label><div><select name="mode"><option value="research">Research</option><option value="work">Work</option></select><input name="goal" maxlength="4000" required placeholder="${tr(locale, "Goal for this run", "这次要完成什么")}"><button type="submit">${tr(locale, "PREVIEW", "先看看")}</button></div></form>
        <div id="proposal-preview"></div>
        <details class="tool-discovery"><summary>${tr(locale, "Find tools enabled for this conversation", "查找本次对话已启用的工具")}</summary><form id="tool-search-form"><input name="query" maxlength="512" required placeholder="${tr(locale, "Search tools enabled for this conversation", "搜索本次对话已启用的工具")}"><button type="submit">${tr(locale, "SEARCH", "搜索")}</button></form><div id="tool-search-results"><p class="fine">${tr(locale, "Search only shows tools already enabled for this conversation.", "这里只会显示已经为本次对话启用的工具。")}</p></div></details>
      </section>
    </div>
  </article>`;
}

interface CoreSkillSummary {
  id: string;
  name: string;
  description: string;
  surface: string;
  mode?: "research" | "study" | "work";
  view?: "deliverables";
}

function coreSkills(locale: Locale): CoreSkillSummary[] {
  return [{
    id: "core.research",
    name: tr(locale, "Research and source review", "资料研究与核对"),
    description: tr(locale, "Researches selected sources and keeps the citations easy to review.", "查阅你选定的资料，并把引用整理清楚，方便复核。"),
    surface: tr(locale, "Research run", "Research 运行"),
    mode: "research",
  }, {
    id: "core.study",
    name: tr(locale, "Active study and review", "主动学习与复习"),
    description: tr(locale, "Creates a Vault-grounded learning path, practice and spaced review.", "基于知识库生成学习路径、练习与间隔复习。"),
    surface: tr(locale, "Study run", "Study 运行"),
    mode: "study",
  }, {
    id: "core.work",
    name: tr(locale, "Work planning and handoff", "工作计划与交接"),
    description: tr(locale, "Previews the plan, then builds an external handoff package tied to that version.", "先预览计划，再生成与这个版本对应的外部交接包。"),
    surface: tr(locale, "Work run", "Work 运行"),
    mode: "work",
  }, {
    id: "core.reports",
    name: tr(locale, "Daily and weekly reports", "日报与周报"),
    description: tr(locale, "Turns a chosen time period into editable daily or weekly report drafts.", "把选定时间内的工作整理成可编辑的日报或周报草稿。"),
    surface: tr(locale, "Deliverables", "交付物"),
    view: "deliverables",
  }, {
    id: "core.presentation",
    name: tr(locale, "Presentation builder", "演示文稿生成"),
    description: tr(locale, "Shows the deck first, then exports a repeatable PPTX or PDF.", "先预览演示稿，再按固定规则导出 PPTX 或 PDF。"),
    surface: tr(locale, "Deliverables", "交付物"),
    view: "deliverables",
  }];
}

function nativeCoreTools(snapshot: DashboardSnapshot, locale: Locale): ExtensionToolSummary[] {
  const vaultReady = snapshot.taskBoard.configured;
  const webReady = Boolean(snapshot.provider?.config_present && snapshot.provider.config_valid);
  return [{
    id: "vault_search",
    name: tr(locale, "Search the selected Vault", "搜索已选择的知识库"),
    description: tr(locale, "Finds matching Markdown notes only inside the Vault you selected.", "只在你选定的 Vault 里查找匹配的 Markdown 笔记。"),
    packageId: "restork.core",
    serverId: "native",
    profiles: [],
    permissions: ["filesystem:vault:read"],
    enabled: vaultReady,
    origin: "core",
  }, {
    id: "source_read",
    name: tr(locale, "Read one selected source", "读取一份已选来源"),
    description: tr(locale, "Reads the single local source you selected from the Vault search result.", "读取你从知识库搜索结果中选定的那一份本地资料。"),
    packageId: "restork.core",
    serverId: "native",
    profiles: [],
    permissions: ["filesystem:vault:read"],
    enabled: vaultReady,
    origin: "core",
  }, {
    id: "vault_write",
    name: tr(locale, "Write a confirmed Vault note", "写入已经确认的知识库笔记"),
    description: tr(locale, "Writes only the version you previewed and confirmed.", "只写入你预览并确认过的版本。"),
    packageId: "restork.core",
    serverId: "native",
    profiles: [],
    permissions: ["filesystem:vault:write", "approval:required"],
    enabled: vaultReady,
    origin: "core",
  }, {
    id: "web_search",
    name: tr(locale, "Provider web search", "模型联网搜索"),
    description: tr(locale, "Uses the selected model's web search when the provider supports it.", "模型供应商支持时，可使用所选模型联网查资料。"),
    packageId: "restork.core",
    serverId: "provider",
    profiles: [],
    permissions: ["network:provider-search"],
    enabled: webReady,
    origin: "core",
  }];
}

function extensionsWorkspace(snapshot: DashboardSnapshot, locale: Locale): string {
  const records = snapshot.workspaceV2?.extensions ?? [];
  const sessions = snapshot.workspaceV2?.sessions.filter((session) => session.status === "active") ?? [];
  const skills = coreSkills(locale);
  const tools = [...nativeCoreTools(snapshot, locale), ...records.flatMap(extensionTools)];
  return `<article class="paper-card full-card catalog-workspace"><header><div><p class="eyebrow">${tr(locale, "Extension center", "扩展中心")}</p><h2>${tr(locale, "Skills, MCP & plugins", "Skills、MCP 与插件")}</h2></div><span class="ribbon research">${tr(locale, "REVIEWED", "需确认")}</span></header>
    <div class="extension-overview" aria-label="${tr(locale, "Extension status", "扩展状态")}">
      <article><small>${tr(locale, "Installed", "已安装")}</small><strong>${records.length}</strong><span>${tr(locale, "pinned manifests", "份固定清单")}</span></article>
      <article><small>${tr(locale, "Core skills", "内置 Skills")}</small><strong>${skills.length}</strong><span>${tr(locale, "ready without installation", "无需安装即可使用")}</span></article>
      <article>
        <small>${tr(locale, "Ready tools", "就绪工具")}</small>
        <strong>${tools.filter((tool) => tool.enabled).length}</strong>
        <span>${tr(locale, "available only to the run setups you choose", "只供你选择的运行配置使用")}</span>
      </article>
    </div>
    <section class="core-library" aria-labelledby="core-library-title"><header><div><small>RESTORK CORE</small><h3 id="core-library-title">${tr(locale, "Built-in Skills", "Core 内置 Skills")}</h3></div><span>${skills.length}</span></header><p>${tr(locale, "These workflows ship with Restork rather than a third-party package. They keep the same local files, write confirmations, memory rules and run history.", "这些工作流随 Restork 一起提供，不是第三方扩展；它们共用本地文件、写入确认、记忆规则和运行记录。")}</p><div class="core-skill-grid">${skills.map((skill) => `<button type="button" class="core-skill-card" data-extension-card-kind="skill" data-extension-search-text="${escapeHtml([skill.name, skill.id, skill.description, skill.surface].join(" ").toLocaleLowerCase())}" ${skill.mode ? `data-core-skill-mode="${skill.mode}"` : `data-core-skill-view="${skill.view}"`} aria-label="${escapeHtml(tr(locale, `Open ${skill.name}`, `打开${skill.name}`))}"><span class="core-skill-card-title"><strong>${escapeHtml(skill.name)}</strong><em>CORE</em></span><code>${escapeHtml(skill.id)}</code><span class="core-skill-card-description">${escapeHtml(skill.description)}</span><small>${escapeHtml(skill.surface)} →</small></button>`).join("")}</div></section>
    <div class="catalog-toolbar" role="group" data-roving-group data-roving-orientation="horizontal" aria-label="${tr(locale, "Filter extensions", "筛选扩展")}"><button type="button" class="is-active" aria-pressed="true" data-extension-filter="all">${tr(locale, "All", "全部")}</button><button type="button" aria-pressed="false" tabindex="-1" data-extension-filter="skill">Skills</button><button type="button" aria-pressed="false" tabindex="-1" data-extension-filter="mcp">MCP</button><button type="button" aria-pressed="false" tabindex="-1" data-extension-filter="plugin">Plugins</button><label class="extension-search">${tr(locale, "Search", "搜索")}<input type="search" data-extension-search maxlength="160" placeholder="${tr(locale, "Name, tool or permission", "名称、工具或权限")}"></label><span role="status" aria-live="polite" data-extension-result-count>${tr(locale, `${skills.length + records.length} shown`, `显示 ${skills.length + records.length} 项`)}</span></div>
    <div class="catalog-grid extension-grid" role="list" data-extension-list>${records.map((record) => extensionCard(record, locale)).join("") || `<p class="empty">${tr(
      locale,
      "No third-party extensions are installed. Built-in Skills and tools above remain available. Restork will show an MCP server's source and permissions before you install or enable it.",
      "尚未安装第三方扩展；上方内置 Skills 与工具仍可使用。安装或启用 MCP Server 之前，Restork 会先显示它的来源和所需权限。",
    )}</p>`}</div><p class="empty" data-extension-filter-empty hidden>${tr(locale, "No extensions match this search.", "没有符合当前条件的扩展。")}</p>
    <section class="tool-inventory" aria-labelledby="tool-inventory-title">
      <header><div><small>CORE + MCP TOOL CATALOG</small><h3 id="tool-inventory-title">${tr(locale, "Tools Restork can run", "Restork 能运行的工具")}</h3></div><span>${tools.length}</span></header>
      <p>${tr(
        locale,
        "Built-in tools appear immediately. Third-party MCP tools appear after installation and run only when the extension is enabled, the conversation allows the tool, and you confirm that call.",
        "内置工具会直接显示；第三方 MCP 工具安装后才会出现，并且只有在扩展已启用、对话允许使用、你确认本次调用后才会运行。",
      )}</p>
      <div class="tool-inventory-grid">${tools.map((tool) => `<details class="tool-inventory-card"><summary><strong>${escapeHtml(tool.name)}</strong><span class="extension-state ${tool.enabled ? "is-enabled" : ""}">${tool.origin === "core" ? (tool.enabled ? tr(locale, "BUILT-IN · READY", "内置 · 就绪") : tr(locale, "NEEDS SETUP", "需要配置")) : (tool.enabled ? tr(locale, "ENABLED PACKAGE", "扩展已启用") : tr(locale, "NOT ENABLED", "尚未启用"))}</span></summary><code>${escapeHtml(tool.id)}</code><small>${escapeHtml(tool.packageId)} · ${escapeHtml(tool.serverId)}</small><p>${escapeHtml(tool.description || tr(locale, "No description in the manifest.", "清单未提供说明。"))}</p><div class="extension-chips">${tool.profiles.map((profile) => `<span>${tr(locale, "Run setup", "运行配置")} · ${escapeHtml(profile)}</span>`).join("") || `<span>${tool.origin === "core" ? tr(locale, "Enabled separately for each conversation", "每个对话单独启用") : tr(locale, "Not assigned to a run setup", "未分配给运行配置")}</span>`}${tool.permissions.map((permission) => `<span>${escapeHtml(permission)}</span>`).join("")}</div></details>`).join("")}</div>
    </section>
    <div class="catalog-compose-grid"><form id="extension-install-form"><h3>${tr(locale, "Add an extension", "添加扩展")}</h3><label>${tr(locale, "What are you adding?", "要添加什么？")}<select name="package_kind"><option value="skill">Skill</option><option value="mcp">MCP Server</option><option value="plugin">Plugin</option></select></label><label class="wide-label">${tr(locale, "Choose its signed manifest file", "选择扩展提供的签名清单文件")}<input name="manifest_file" type="file" accept=".json,application/json"></label><p class="wide-label">${tr(locale, "Or import a SKILL.md folder. Restork keeps the instructions and lists anything it cannot run.", "也可以导入 SKILL.md 文件夹。Restork 会留下方法论文本，并列出它无法运行的部分。")}</p><button type="button" class="quiet-button" data-skill-folder-import>${tr(locale, "IMPORT SKILL FOLDER", "从文件夹导入技能")}</button><input data-skill-folder-input type="file" multiple hidden><p class="fine wide-label">${tr(locale, "You do not need to edit JSON. Restork reads the selected file locally, then explains its source, permissions and tools before anything is installed.", "你不需要编辑 JSON。Restork 只在本地读取所选文件，并在安装前用可读方式说明来源、权限与工具。")}</p><button type="submit">${tr(locale, "CHECK BEFORE INSTALLING", "安装前检查")}</button><div id="extension-install-status" role="status" aria-live="polite"></div></form>
    <form id="extension-tool-search-form"><h3>${tr(locale, "Session tool search", "会话工具搜索")}</h3><label>${tr(locale, "Conversation", "对话")}<select name="session_id">${sessions.map((session) => `<option value="${escapeHtml(session.session_id)}">${escapeHtml(session.title)}</option>`).join("")}</select></label><label>${tr(locale, "Query", "查询")}<input name="query" maxlength="512" required></label><button type="submit" ${sessions.length ? "" : "disabled"}>${tr(locale, "SEARCH AVAILABLE TOOLS", "搜索可用工具")}</button><div id="extension-tool-results"></div></form></div>
    <p class="fine">${tr(
      locale,
      "New extensions stay off until you check their source, license, fingerprint, permissions, credential references, connection method, and tools. Restork blocks dynamic npx, shell interpolation, and inherited environment variables.",
      "新扩展默认关闭。启用前，你可以查看来源、许可证、内容指纹、权限、凭据引用、连接方式和工具。Restork 会阻止动态 npx、Shell 插值和环境变量继承。",
    )}</p></article>`;
}

interface ExtensionToolSummary {
  id: string;
  name: string;
  description: string;
  packageId: string;
  serverId: string;
  profiles: string[];
  permissions: string[];
  enabled: boolean;
  origin?: "core" | "mcp";
}

function extensionTools(record: CatalogRecordV2): ExtensionToolSummary[] {
  const manifest = record.manifest ?? {};
  const packageId = stringValue(manifest.id) || record.package_id || "extension";
  const profiles = stringArray(manifest.enabled_profiles);
  const permissions = stringArray(manifest.requested_permissions);
  const direct = objectArray(manifest.tools).map((tool) => extensionToolSummary(
    tool,
    packageId,
    packageId,
    profiles,
    permissions,
    record.state === "enabled",
  ));
  const nested = objectArray(manifest.mcp_servers).flatMap((server) => {
    const serverId = stringValue(server.id) || packageId;
    const serverPermissions = [...permissions, ...stringArray(server.requested_permissions)];
    return objectArray(server.tools).map((tool) => extensionToolSummary(
      tool,
      packageId,
      serverId,
      profiles,
      [...new Set(serverPermissions)],
      record.state === "enabled",
    ));
  });
  return [...direct, ...nested];
}

function extensionToolSummary(
  tool: Record<string, unknown>,
  packageId: string,
  serverId: string,
  profiles: string[],
  permissions: string[],
  enabled: boolean,
): ExtensionToolSummary {
  const id = stringValue(tool.id) || stringValue(tool.name) || "unnamed-tool";
  return {
    id,
    name: stringValue(tool.name) || id,
    description: stringValue(tool.description),
    packageId,
    serverId,
    profiles,
    permissions,
    enabled,
    origin: "mcp",
  };
}

function extensionCard(record: CatalogRecordV2, locale: Locale): string {
  const manifest = record.manifest ?? {};
  const kind = record.package_kind ?? "unknown";
  const tools = extensionTools(record);
  const profiles = stringArray(manifest.enabled_profiles);
  const permissions = stringArray(manifest.requested_permissions);
  const version = stringValue(manifest.version) || tr(locale, "unknown version", "未知版本");
  const procedure = stringValue(manifest.procedure);
  const transport = transportLabel(manifest.transport);
  const source = sourceLabel(manifest.provenance);
  const summary = kind === "skill"
    ? procedure || tr(locale, "Prompt procedure declared by this Skill.", "此 Skill 声明的 Prompt 流程。")
    : kind === "mcp"
      ? `${transport || tr(locale, "No transport", "未声明传输")} · ${tools.length} ${tr(locale, "tools", "个工具")}`
      : `${objectArray(manifest.skills).length} Skills · ${objectArray(manifest.mcp_servers).length} MCP`;
  const packageId = record.package_id ?? "extension";
  const searchText = [packageId, kind, version, summary, source, transport, ...profiles, ...permissions, ...tools.flatMap((tool) => [tool.id, tool.name, tool.description])]
    .join(" ")
    .toLocaleLowerCase();
  return `<details class="extension-card extension-row" role="listitem" data-extension-card-kind="${escapeHtml(kind)}" data-extension-search-text="${escapeHtml(searchText)}">
    <summary><span><small>${escapeHtml(kind.toUpperCase())} · ${escapeHtml(version)}</small><strong>${escapeHtml(packageId)}</strong><em>${escapeHtml(summary)}</em></span><span class="extension-state ${record.state === "enabled" ? "is-enabled" : ""}">${escapeHtml(extensionStateLabel(record.state, locale))}</span></summary>
    <div class="extension-card-details">
      <dl><div><dt>${tr(locale, "Source", "来源")}</dt><dd>${escapeHtml(source || tr(locale, "Not declared", "未声明"))}</dd></div><div><dt>${tr(locale, "Version", "版本")}</dt><dd>${escapeHtml(version)}</dd></div><div><dt>${tr(locale, "Connection", "连接方式")}</dt><dd>${escapeHtml(transport || tr(locale, "Not applicable", "不适用"))}</dd></div><div><dt>${tr(locale, "Run setups", "运行配置")}</dt><dd>${escapeHtml(profiles.join(", ") || tr(locale, "None", "无"))}</dd></div><div><dt>${tr(locale, "Permissions", "权限")}</dt><dd>${escapeHtml(permissions.join(", ") || tr(locale, "None requested", "未申请"))}</dd></div></dl>
      <section class="extension-tool-list" aria-label="${tr(locale, "Declared tools", "声明的工具")}"><strong>${tr(locale, "Tools", "工具")} · ${tools.length}</strong>${tools.length ? `<ul>${tools.map((tool) => `<li><b>${escapeHtml(tool.name)}</b><code>${escapeHtml(tool.id)}</code>${tool.description ? `<span>${escapeHtml(tool.description)}</span>` : ""}</li>`).join("")}</ul>` : `<p>${tr(locale, "This extension declares no tools.", "这个扩展没有声明工具。")}</p>`}</section>
      <details class="extension-technical-details"><summary>${tr(locale, "Technical details", "技术信息")}</summary><dl><div><dt>${tr(locale, "Fingerprint", "内容指纹")}</dt><dd><code>${escapeHtml(record.manifest_hash ?? tr(locale, "Not available", "暂无"))}</code></dd></div><div><dt>${tr(locale, "Updated", "更新时间")}</dt><dd>${formatDate(record.updated_at, locale)}</dd></div></dl></details>
      ${record.manifest_hash ? `<div class="record-actions"><button type="button" data-extension-state="${record.state === "enabled" ? "disable" : "enable"}" data-extension-id="${escapeHtml(packageId)}" data-extension-hash="${escapeHtml(record.manifest_hash)}">${record.state === "enabled" ? tr(locale, "DISABLE", "停用") : tr(locale, "CHECK & ENABLE", "查看并启用")}</button><button type="button" class="quiet-button" data-extension-history data-extension-id="${escapeHtml(packageId)}" data-extension-hash="${escapeHtml(record.manifest_hash)}">${tr(locale, "VERSIONS & ROLLBACK", "版本与回滚")}</button></div><div class="extension-history" data-extension-history-results role="status"></div>` : ""}
    </div>
  </details>`;
}

function extensionStateLabel(state: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    quarantined: ["Waiting for confirmation", "等待确认"],
    enabled: ["Enabled", "已启用"],
    disabled: ["Disabled", "已停用"],
    update_available: ["Update available", "有可用更新"],
  };
  const label = labels[state];
  return label ? tr(locale, label[0], label[1]) : tr(locale, "Unavailable", "不可用");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function transportLabel(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  const kind = stringValue(record.kind);
  const command = stringValue(record.command);
  const url = stringValue(record.url);
  return [kind, command || url].filter(Boolean).join(" · ");
}

function sourceLabel(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const provenance = value as Record<string, unknown>;
  const source = provenance.source;
  const license = stringValue(provenance.license);
  if (!source || typeof source !== "object" || Array.isArray(source)) return license;
  const sourceRecord = source as Record<string, unknown>;
  return [
    stringValue(sourceRecord.kind),
    stringValue(sourceRecord.catalog_id) || stringValue(sourceRecord.path) || stringValue(sourceRecord.url),
    license,
  ].filter(Boolean).join(" · ");
}


function automationWorkspace(snapshot: DashboardSnapshot, locale: Locale): string {
  const records = (snapshot.workspaceV2?.schedules ?? [])
    .map(scheduleRecordFromCatalog)
    .filter((record): record is ScheduleRecordV2 => record !== null);
  const providers = snapshot.workspaceV2?.providers ?? [];
  const providerOptions = scheduleProviderOptions(providers, locale);
  return `<article class="paper-card full-card catalog-workspace"><header><div><p class="eyebrow">${tr(locale, "Automation & recovery", "自动化与恢复")}</p><h2>${tr(locale, "Automations and recovery", "自动化与恢复")}</h2></div><span class="ribbon work">${tr(locale, "LOCAL AND REVERSIBLE", "本地可恢复")}</span></header>
    <section aria-labelledby="saved-schedules-title"><header class="schedule-list-header"><div class="schedule-list-title"><small>${tr(locale, "Local schedules", "本地日程")}</small><h3 id="saved-schedules-title">${tr(locale, "Saved automations", "已保存的自动化")}</h3></div>
        <div class="schedule-list-actions"><button type="button" data-schedule-active-load>${tr(locale, "REFRESH LIST", "刷新列表")}</button><button type="button" class="quiet-button" data-schedule-trash-load>${tr(locale, "OPEN TRASH", "打开回收站")}</button></div></header>
      <div class="catalog-grid automation-grid" data-schedule-active-list>${scheduleCardsMarkup(records, locale, false, providers)}</div><div data-schedule-active-page></div>
      <div class="catalog-grid automation-grid" data-schedule-trash-list></div><div data-schedule-trash-page></div></section>
    <div class="catalog-compose-grid catalog-compose-single"><form id="schedule-create-form">
      <h3>${tr(locale, "New automation", "新建自动化")}</h3>
      <label>${tr(locale, "Name", "名称")}<input name="name" required maxlength="120" value="${tr(locale, "Morning local check", "每日本地检查")}"></label>
      <label>${tr(locale, "Time", "时间")}<input name="time" type="time" required value="09:00"></label>
      <label>${tr(locale, "Recurrence", "重复")}<select name="recurrence" data-schedule-recurrence><option value="daily">${tr(locale, "Daily", "每天")}</option><option value="weekly">${tr(locale, "Weekly", "每周")}</option><option value="every_n_days">${tr(locale, "Every few days", "每几天")}</option></select></label>
      <label data-schedule-weekday-field hidden>${tr(locale, "Weekday", "星期")}<select name="weekday">${weekdayOptions(locale)}</select></label>
      ${scheduleIntervalField(locale, 3, true)}
      <label class="wide-label">${tr(locale, "Job", "任务")}<select name="job">${scheduleJobOptions(locale)}</select></label>
      <fieldset class="schedule-model-fields wide-label" data-schedule-model-fields hidden>
        <legend>${tr(locale, "Model for this draft", "起草所用模型")}</legend>
        <label>${tr(locale, "Model", "模型")}<select name="provider_profile_id">${providerOptions}</select></label>
        <label>${tr(locale, "What should the draft focus on?", "希望草稿重点整理什么？")}<textarea name="focus" rows="3" maxlength="2000" placeholder="${tr(locale, "For example: completed work, blockers, decisions and next steps", "例如：已完成事项、阻塞、决策和下一步")}"></textarea></label>
        <label class="consent-check"><input type="checkbox" name="network_access_confirmed" required>${tr(
          locale,
          "I understand that Restork will send public run titles, status and stop reasons to this model and that the provider may charge for each run.",
          "我知道 Restork 会把标记为 public 的运行标题、状态与停止原因发送给该模型，并且供应商可能按次计费。",
        )}</label>
      </fieldset>
      <button type="submit">${tr(locale, "CREATE SCHEDULE", "创建自动化")}</button>
      <p id="schedule-create-status" role="status"></p>
      <p class="fine">${tr(
        locale,
        "Model automations use public run facts to create a draft on this device. The draft is not written to the Vault or exported until you confirm it.",
        "模型自动化只使用公开的运行记录，并在这台设备上生成草稿。确认之前，草稿不会写入知识库或导出。",
      )}</p>
    </form></div></article>`;
}

function scheduleRecordFromCatalog(record: CatalogRecordV2): ScheduleRecordV2 | null {
  const schedule = record.schedule;
  const recurrence = schedule?.recurrence;
  const job = schedule?.job;
  if (
    typeof record.schedule_id !== "string"
    || !schedule
    || typeof schedule.timezone !== "string"
    || typeof recurrence !== "object"
    || recurrence === null
    || typeof job !== "object"
    || job === null
  ) return null;
  const jobKind = Reflect.get(job, "kind");
  const parsedRecurrence = parseScheduleRecurrence(recurrence as Record<string, unknown>);
  if (!parsedRecurrence) return null;
  let parsedJob: ScheduleJobV2;
  if (jobKind === "deterministic") {
    const jobName = Reflect.get(job, "job");
    if (!["health.check", "daily.refresh"].includes(String(jobName))) return null;
    parsedJob = {
      kind: "deterministic",
      job: jobName as "health.check" | "daily.refresh",
    };
  } else if (jobKind === "model_draft") {
    const providerProfileId = Reflect.get(job, "provider_profile_id");
    const reportKind = Reflect.get(job, "report_kind");
    const title = Reflect.get(job, "title");
    const language = Reflect.get(job, "language");
    const focus = Reflect.get(job, "focus");
    const networkAccessConfirmed = Reflect.get(job, "network_access_confirmed");
    if (
      typeof providerProfileId !== "string"
      || !["daily_report", "weekly_report"].includes(String(reportKind))
      || typeof title !== "string"
      || typeof language !== "string"
      || typeof focus !== "string"
      || typeof networkAccessConfirmed !== "boolean"
    ) return null;
    parsedJob = {
      kind: "model_draft",
      provider_profile_id: providerProfileId,
      report_kind: reportKind as "daily_report" | "weekly_report",
      title,
      language,
      focus,
      network_access_confirmed: networkAccessConfirmed,
    };
  } else {
    return null;
  }
  return {
    schedule_id: record.schedule_id,
    schedule: {
      schedule_id: record.schedule_id,
      name: typeof schedule.name === "string" ? schedule.name : undefined,
      timezone: schedule.timezone,
      recurrence: parsedRecurrence,
      missed_run_policy: schedule.missed_run_policy === "skip" ? "skip" : "create_draft",
      job: parsedJob,
    },
    revision: record.revision ?? 1,
    state: record.state === "paused" ? "paused" : "active",
    next_run_at: record.next_run_at ?? null,
    updated_at: record.updated_at,
    deleted_at: record.deleted_at ?? null,
  };
}

function parseScheduleRecurrence(
  recurrence: Record<string, unknown>,
): ScheduleRecordV2["schedule"]["recurrence"] | null {
  const kind = recurrence.kind;
  if (kind === "one_shot") {
    return typeof recurrence.at === "string" && !Number.isNaN(Date.parse(recurrence.at))
      ? { kind, at: recurrence.at }
      : null;
  }
  const hour = recurrence.hour;
  const minute = recurrence.minute;
  if (
    !Number.isInteger(hour)
    || !Number.isInteger(minute)
    || Number(hour) < 0
    || Number(hour) > 23
    || Number(minute) < 0
    || Number(minute) > 59
  ) return null;
  if (kind === "daily") return { kind, hour: Number(hour), minute: Number(minute) };
  if (kind === "weekly") {
    const weekday = recurrence.weekday_monday_zero;
    return Number.isInteger(weekday) && Number(weekday) >= 0 && Number(weekday) <= 6
      ? { kind, weekday_monday_zero: Number(weekday), hour: Number(hour), minute: Number(minute) }
      : null;
  }
  if (kind === "every_n_days") {
    const intervalDays = recurrence.interval_days;
    const anchor = recurrence.anchor;
    return Number.isInteger(intervalDays)
      && Number(intervalDays) >= MIN_SCHEDULE_INTERVAL_DAYS
      && Number(intervalDays) <= MAX_SCHEDULE_INTERVAL_DAYS
      && typeof anchor === "string"
      && /^\d{4}-\d{2}-\d{2}$/.test(anchor)
      ? { kind, interval_days: Number(intervalDays), anchor, hour: Number(hour), minute: Number(minute) }
      : null;
  }
  return null;
}

export function scheduleCardsMarkup(
  records: ScheduleRecordV2[],
  locale: Locale,
  deleted = false,
  providers: NonNullable<NonNullable<DashboardSnapshot["workspaceV2"]>["providers"]> = [],
): string {
  if (!records.length) {
    return `<p class="empty">${deleted
      ? tr(locale, "Trash is empty. Restored automations will appear in the active list.", "回收站是空的。恢复后会出现在当前列表里。")
      : tr(locale, "No saved automations yet. Name one below and save it.", "还没有自动化。在下面填名称和时间，点保存即可。")}</p>`;
  }
  return records.map((record) => scheduleCard(record, locale, deleted, providers)).join("");
}

function scheduleCard(
  record: ScheduleRecordV2,
  locale: Locale,
  deleted: boolean,
  providers: NonNullable<NonNullable<DashboardSnapshot["workspaceV2"]>["providers"]>,
): string {
  const schedule = record.schedule;
  const name = schedule.name?.trim() || scheduleJobLabel(schedule.job, locale);
  const id = escapeHtml(record.schedule_id);
  const revision = record.revision;
  const recurrence = schedule.recurrence;
  const time = recurrence.kind === "one_shot"
    ? new Date(recurrence.at).toTimeString().slice(0, 5)
    : `${String(recurrence.hour).padStart(2, "0")}:${String(recurrence.minute).padStart(2, "0")}`;
  const recurrenceKind = recurrence.kind;
  const weekday = recurrence.kind === "weekly" ? recurrence.weekday_monday_zero : 0;
  const intervalDays = recurrence.kind === "every_n_days" ? recurrence.interval_days : 3;
  const deletedCopy = record.deleted_at
    ? `${tr(locale, "Deleted", "删除于")} ${formatDate(record.deleted_at, locale)}`
    : tr(locale, "In trash", "位于回收站");
  const selectedJob = schedule.job.kind === "deterministic"
    ? schedule.job.job
    : `model.${schedule.job.report_kind}`;
  const selectedProvider = schedule.job.kind === "model_draft"
    ? schedule.job.provider_profile_id
    : "";
  const focus = schedule.job.kind === "model_draft" ? schedule.job.focus : "";
  const modelSummary = schedule.job.kind === "model_draft"
    ? `<small>${escapeHtml(schedule.job.provider_profile_id)}</small><p>${escapeHtml(schedule.job.focus)}</p>`
    : "";
  const action = (kind: string, label: string, className = ""): string => (
    `<button type="button" ${className} data-schedule-action="${kind}" `
      + `data-schedule-id="${id}" data-schedule-revision="${revision}">${label}</button>`
  );
  const actions = deleted
    ? action("restore", tr(locale, "RESTORE", "恢复"))
    : [
        action("run", tr(locale, "RUN NOW", "立即运行")),
        action(
          record.state === "active" ? "pause" : "resume",
          record.state === "active" ? tr(locale, "PAUSE", "暂停") : tr(locale, "RESUME", "继续"),
        ),
        action("edit", tr(locale, "EDIT", "修改")),
        `<button type="button" data-schedule-history data-schedule-id="${id}">${tr(locale, "HISTORY", "运行记录")}</button>`,
        action("delete", tr(locale, "MOVE TO TRASH", "移入回收站"), 'class="danger-text"'),
      ].join("");
  const nextRun = deleted
    ? deletedCopy
    : record.next_run_at
      ? `${tr(locale, "Next run", "下次运行")} ${formatDate(record.next_run_at, locale)}`
      : tr(locale, "Paused", "已暂停");
  const editForm = deleted ? "" : `<form data-schedule-edit-form data-schedule-id="${id}"
      data-schedule-revision="${revision}" data-schedule-timezone="${escapeHtml(schedule.timezone)}"
      ${recurrence.kind === "one_shot" ? `data-schedule-one-shot-at="${escapeHtml(recurrence.at)}"` : ""} hidden>
      <label>${tr(locale, "Name", "名称")}<input name="name" required maxlength="120" value="${escapeHtml(name)}"></label>
      <label>${tr(locale, "Time", "时间")}<input name="time" type="time" required value="${time}"></label>
      <label>${tr(locale, "Recurrence", "重复")}<select name="recurrence" data-schedule-recurrence>
        ${recurrence.kind === "one_shot" ? `<option value="one_shot" selected>${tr(locale, "Once · keep original time", "单次 · 保留原时间")}</option>` : ""}
        <option value="daily" ${recurrenceKind === "daily" ? "selected" : ""}>${tr(locale, "Daily", "每天")}</option>
        <option value="weekly" ${recurrenceKind === "weekly" ? "selected" : ""}>${tr(locale, "Weekly", "每周")}</option>
        <option value="every_n_days" ${recurrenceKind === "every_n_days" ? "selected" : ""}>${tr(locale, "Every few days", "每几天")}</option>
      </select></label>
      <label data-schedule-weekday-field ${recurrenceKind === "weekly" ? "" : "hidden"}>${tr(locale, "Weekday", "星期")}<select name="weekday">${weekdayOptions(locale, weekday)}</select></label>
      ${scheduleIntervalField(locale, intervalDays, recurrenceKind !== "every_n_days")}
      <label>${tr(locale, "Job", "任务")}<select name="job">${scheduleJobOptions(locale, selectedJob)}</select></label>
      <fieldset class="schedule-model-fields wide-label" data-schedule-model-fields ${schedule.job.kind === "model_draft" ? "" : "hidden"}>
        <legend>${tr(locale, "Model for this draft", "起草所用模型")}</legend>
        <label>${tr(locale, "Model", "模型")}<select name="provider_profile_id">${scheduleProviderOptions(providers, locale, selectedProvider)}</select></label>
        <label>${tr(locale, "Draft focus", "草稿重点")}<textarea name="focus" rows="3" maxlength="2000">${escapeHtml(focus)}</textarea></label>
        <label class="consent-check"><input type="checkbox" name="network_access_confirmed" required ${
          schedule.job.kind === "model_draft" && schedule.job.network_access_confirmed ? "checked" : ""
        }>${tr(
          locale,
          "Allow this schedule to send public run facts to the selected model; provider charges may apply.",
          "允许此自动化把 public 运行事实发送给所选模型；供应商可能产生费用。",
        )}</label>
      </fieldset>
      <button type="submit">${tr(locale, "SAVE CHANGES", "保存修改")}</button>
      <button type="button" data-schedule-edit-cancel>${tr(locale, "CANCEL", "取消")}</button>
    </form><div data-schedule-run-host="${id}"></div>`;
  return `<article data-schedule-card="${id}">
    <strong>${escapeHtml(name)}</strong>
    <span>${escapeHtml(humanScheduleRecurrence(schedule.recurrence, locale))}</span>
    <small>${escapeHtml(schedule.timezone)} · ${escapeHtml(scheduleJobLabel(schedule.job, locale))}</small>
    ${modelSummary}<small>${nextRun}</small><div class="record-actions">${actions}</div>${editForm}
  </article>`;
}

export function scheduleRunsMarkup(runs: ScheduleRunV2[], locale: Locale): string {
  if (!runs.length) return `<p class="empty">${tr(locale, "No runs recorded yet. Save the automation to see them here.", "还没有运行记录。保存自动化后会显示在这里。")}</p>`;
  return `<ol class="event-list">${runs.map((run) => {
    const manual = run.period_key.startsWith("manual:") || run.result.manual === true;
    const state = scheduleRunStateLabel(
      typeof run.result.state === "string" ? run.result.state : "recorded",
      locale,
    );
    const label = manual
      ? tr(locale, "Manual run", "手动运行")
      : tr(locale, "Scheduled run", "计划运行");
    const replayed = run.replayed ? ` · ${tr(locale, "replayed", "重放")}` : "";
    const deliverable = typeof run.result.deliverable_id === "string"
      ? `<small>${tr(locale, "Draft saved on this device", "草稿已保存在这台设备上")} · ${escapeHtml(run.result.deliverable_id)}</small>`
      : "";
    return `<li><strong>${label}</strong><span>${escapeHtml(String(state))}${replayed}</span>`
      + `${deliverable}<small>${formatDate(run.created_at, locale)}</small></li>`;
  }).join("")}</ol>`;
}

function scheduleRunStateLabel(state: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    running: ["Waiting for manual review", "等待人工确认"],
    completed: ["Completed", "已完成"],
    rejected: ["Rejected", "已拒绝"],
    draft_created: ["Draft created", "草稿已生成"],
    recorded: ["Recorded", "已记录"],
    failed: ["Failed", "失败"],
  };
  const label = labels[state];
  return label ? tr(locale, label[0], label[1]) : tr(locale, "Recorded", "已记录");
}

function humanScheduleRecurrence(recurrence: ScheduleRecordV2["schedule"]["recurrence"], locale: Locale): string {
  if (recurrence.kind === "one_shot") {
    return `${tr(locale, "Once", "单次")} · ${formatDate(recurrence.at, locale)}`;
  }
  const time = `${String(recurrence.hour).padStart(2, "0")}:${String(recurrence.minute).padStart(2, "0")}`;
  if (recurrence.kind === "daily") return tr(locale, `Every day at ${time}`, `每天 ${time}`);
  if (recurrence.kind === "every_n_days") {
    const days = recurrence.interval_days;
    return tr(locale, `Every ${days} days at ${time}`, `每 ${days} 天 ${time}`);
  }
  const weekday = weekdayNames(locale)[recurrence.weekday_monday_zero] ?? weekdayNames(locale)[0];
  return tr(locale, `Every ${weekday} at ${time}`, `每${weekday} ${time}`);
}

/**
 * Cadence is the user's intent, not a safety boundary, so it takes a free
 * number inside honest bounds instead of a short menu of blessed values.
 */
export {
  MAX_SCHEDULE_INTERVAL_DAYS,
  MIN_SCHEDULE_INTERVAL_DAYS,
};

function weekdayNames(locale: Locale): string[] {
  return locale === "zh-CN"
    ? ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    : ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
}

function weekdayOptions(locale: Locale, selected = 0): string {
  return weekdayNames(locale).map((label, index) => `<option value="${index}" ${selected === index ? "selected" : ""}>${label}</option>`).join("");
}

function scheduleJobLabel(job: ScheduleJobV2, locale: Locale): string {
  if (job.kind === "model_draft") {
    return job.report_kind === "weekly_report"
      ? tr(locale, "AI weekly report draft", "AI 周报草稿")
      : tr(locale, "AI daily report draft", "AI 日报草稿");
  }
  return job.job === "daily.refresh"
    ? tr(locale, "Refresh daily cache", "刷新每日缓存")
    : tr(locale, "Local health check", "本地健康检查");
}

function scheduleJobOptions(locale: Locale, selected = "health.check"): string {
  const options = [
    ["health.check", tr(locale, "Local health check · no model", "本地健康检查 · 无模型")],
    ["daily.refresh", tr(locale, "Refresh daily cache · no model", "刷新每日缓存 · 无模型")],
    ["model.daily_report", tr(locale, "AI daily report · saved as draft", "AI 日报 · 保存为草稿")],
    ["model.weekly_report", tr(locale, "AI weekly report · saved as draft", "AI 周报 · 保存为草稿")],
  ] as const;
  return options.map(([value, label]) => {
    const selectedAttribute = selected === value ? "selected" : "";
    return `<option value="${value}" ${selectedAttribute}>${label}</option>`;
  }).join("");
}

function scheduleProviderOptions(
  providers: NonNullable<NonNullable<DashboardSnapshot["workspaceV2"]>["providers"]>,
  locale: Locale,
  selected = "",
): string {
  if (!providers.length) {
    if (selected) return `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>`;
    return `<option value="">${tr(locale, "Configure a model in Settings first", "请先在设置中配置模型")}</option>`;
  }
  return providers.map((record) => {
    const profile = record.provider;
    const selectedAttribute = profile.profile_id === selected ? "selected" : "";
    return `<option value="${escapeHtml(profile.profile_id)}" ${selectedAttribute}>`
      + `${escapeHtml(profile.display_name)} · ${escapeHtml(profile.model)}</option>`;
  }).join("");
}

export function toolSearchMarkup(result: ToolSearchResultV2, locale: Locale): string {
  return `<div class="tool-results"><small>${tr(locale, "Tools available in this conversation", "本次对话可用工具")} · ${escapeHtml(result.catalog_fingerprint.slice(0, 16))}…</small>${result.items.map((item) => `<button type="button" data-tool-preview="${escapeHtml(item.tool_id)}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.tool_id)} · ${item.score}</span></button>`).join("") || `<p class="empty">${tr(locale, "No already-granted tool matched.", "没有已授权工具匹配。")}</p>`}</div>`;
}

export function toolCallPreviewMarkup(preview: ToolCallPreviewV2, locale: Locale): string {
  return `<article class="proposal-card">
    <header><strong>${tr(locale, "Review this tool call", "请先确认这次工具调用")}</strong>
    <span>${escapeHtml(preview.resolved_call.real_tool_id)}</span></header>
    <p>${tr(
      locale,
      "Nothing has run yet. Check the tool, input, permissions, connection method, and content fingerprint below.",
      "工具还没有运行。请检查下方的工具、输入内容、所需权限、连接方式和内容指纹。",
    )}</p>
    <pre>${prettyJson(preview.resolved_call)}</pre><small>SHA-256 · ${escapeHtml(preview.call_digest)}</small>
    <button type="button" data-tool-execute>${tr(locale, "APPROVE & RUN", "确认并运行")}</button>
  </article>`;
}

function prettyJson(value: unknown): string {
  return escapeHtml(JSON.stringify(value ?? {}, null, 2));
}

function providerRegistryOption(definition: ProviderDefinitionV2, locale: Locale): string {
  return `<option value="${escapeHtml(definition.id)}" data-base-url="${escapeHtml(definition.default_base_url)}" data-default-model="${escapeHtml(definition.default_model ?? "")}" data-recommended-models="${escapeHtml(JSON.stringify(definition.recommended_models ?? []))}" data-endpoint-policy="${escapeHtml(definition.endpoint_policy)}" data-auth-kind="${escapeHtml(definition.auth_kind)}" data-discovery="${escapeHtml(definition.model_discovery)}" data-setup-command="${escapeHtml(definition.setup_command)}" data-reasoning-efforts="${escapeHtml(definition.reasoning.supported_efforts.join(","))}" data-reasoning-can-disable="${definition.reasoning.can_disable}" data-reasoning-budget="${definition.reasoning.supports_token_budget}">${escapeHtml(definition.display_name)}${definition.kind === "ollama" ? ` (${tr(locale, "local", "本地")})` : ""}</option>`;
}

function reasoningEffortOptions(locale: Locale): string {
  const options: Array<[ReasoningEffortV2, string, string]> = [
    ["auto", "Auto · model default", "自动 · 模型默认"],
    ["none", "Off", "关闭"],
    ["minimal", "Minimal", "最少"],
    ["low", "Low", "低"],
    ["medium", "Medium", "中"],
    ["high", "High", "高"],
    ["xhigh", "Extra high", "超高"],
    ["max", "Maximum", "最大"],
  ];
  return options.map(([value, en, zh]) => `<option value="${value}" data-reasoning-effort="${value}">${tr(locale, en, zh)}</option>`).join("");
}

function personalSettingsWorkspace(snapshot: DashboardSnapshot, locale: Locale): string {
  const record = snapshot.workspaceV2?.personal;
  const settings = record?.settings ?? {};
  const providers = snapshot.workspaceV2?.providers ?? [];
  const profiles = snapshot.workspaceV2?.profiles ?? [];
  const prompts = snapshot.workspaceV2?.prompts ?? [];
  const providerRegistry = snapshot.workspaceV2?.providerRegistry?.items ?? [];
  const activePrompt = prompts.find((revision) => revision.active);
  const projectBaseUrl = "https://github.com/Totoro-qaq/restork";
  const projectBoundaryUrl = `${projectBaseUrl}/blob/main/DISCLAIMER${locale === "zh-CN" ? ".zh-CN" : ""}.md`;
  const externalLinkAttributes = 'target="_blank" rel="noopener noreferrer"';
  const projectBoundaryLink = safeLink(projectBoundaryUrl, tr(locale, "ABOUT & RESPONSIBILITY", "使用与责任"), externalLinkAttributes);
  const projectSecurityUrl = locale === "zh-CN" ? `${projectBaseUrl}/blob/main/SECURITY.zh-CN.md` : `${projectBaseUrl}/security/policy`;
  const projectSecurityLink = safeLink(projectSecurityUrl, tr(locale, "SECURITY", "安全政策"), externalLinkAttributes);
  const projectLicenseLink = safeLink(`${projectBaseUrl}/blob/main/LICENSE`, "MIT LICENSE", externalLinkAttributes);
  return `<article class="paper-card full-card settings-workspace"><header><div><p class="eyebrow">${tr(locale, "Settings", "设置")}</p><h2>${tr(locale, "Make Restork yours", "让 Restork 更像你的工作台")}</h2></div><span class="ribbon study">${tr(locale, "ON DEVICE", "保存在本机")}</span></header>
    <div class="settings-sections">
      <section class="settings-section" data-settings-panel="personal"><header><div><small>${tr(locale, "Personal", "个人")}</small><h3>${tr(locale, "Name & appearance", "称呼与外观")}</h3></div></header>
        <form id="personal-settings-form" data-version="${record?.version ?? 0}">
          <label>${tr(locale, "Display name (optional)", "称呼（可选）")}<input name="display_name" maxlength="80" value="${escapeHtml(settings.display_name ?? "")}" autocomplete="nickname"></label>
          <label>${tr(locale, "Language", "语言")}<select name="locale"><option value="en" ${settings.locale === "en" ? "selected" : ""}>English</option><option value="zh-CN" ${settings.locale === "zh-CN" ? "selected" : ""}>简体中文</option></select></label>
          <label>${tr(locale, "Time zone", "时区")}${timeZoneOptions(settings.timezone, locale)}</label>
          <label>${tr(locale, "Theme", "主题")}<select name="theme"><option value="system">${tr(locale, "System", "跟随系统")}</option><option value="light" ${settings.theme === "light" ? "selected" : ""}>${tr(locale, "Light", "浅色")}</option><option value="dark" ${settings.theme === "dark" ? "selected" : ""}>${tr(locale, "Dark", "深色")}</option></select></label>
          <label>${tr(locale, "Open on launch", "启动后打开")}<select name="startup_page"><option value="start" ${settings.startup_page !== "dashboard" ? "selected" : ""}>${tr(locale, "Start", "开始页")}</option><option value="dashboard" ${settings.startup_page === "dashboard" ? "selected" : ""}>${tr(locale, "Dashboard", "仪表盘")}</option></select></label>
          <button type="submit" class="btn-primary">${tr(locale, "SAVE LOCALLY", "保存到本地")}</button><p id="personal-settings-status" role="status"></p>
        </form>
        <p class="fine">${tr(locale, "Your display name is not sent to a model unless a run setup explicitly includes it.", "称呼默认不会发送给模型；只有你在运行配置中明确开启后才会包含它。")}</p>
        <div class="getting-started-return"><div><strong>${tr(locale, "Start page", "开始页")}</strong><small>${tr(locale, "Return to the focused task launcher at any time.", "随时回到一句话发起任务的开始页。")}</small></div><button type="button" class="quiet-button" data-start-page-return>${tr(locale, "OPEN START", "打开开始页")}</button></div>
      </section>
      <section class="settings-section" data-settings-panel="knowledge" hidden><header><div><small>${tr(locale, "Knowledge base", "知识库")}</small><h3>${tr(locale, "Vault directory", "知识库目录")}</h3></div></header>
        <form id="vault-dir-form">
          <div class="native-setup-summary"><span class="native-setup-icon" aria-hidden="true">K</span><div><strong data-vault-current>${tr(locale, "No knowledge library selected", "尚未选择知识库")}</strong><small>${tr(locale, "The absolute path stays inside the native desktop process.", "绝对路径只留在桌面原生进程中，不会交给网页界面。")}</small></div></div>
          <button type="button" class="btn-primary" data-vault-choose>${tr(locale, "CHOOSE VAULT FOLDER", "选择知识库文件夹")}</button>
          <section class="vault-candidate" data-vault-candidate hidden><div><strong data-vault-candidate-label></strong><small>${tr(locale, "Restork will reconnect the local Core and invalidate old one-time approvals.", "Restork 会重新连接本地 Core，并使旧的一次性审批失效。")}</small></div><button type="button" data-vault-apply>${tr(locale, "APPLY & RECONNECT", "应用并重新连接")}</button><button type="button" class="quiet-button" data-vault-cancel>${tr(locale, "CANCEL", "取消")}</button></section>
          <p id="vault-dir-status" role="status" aria-live="polite"></p>
        </form>
        <p class="fine">${tr(locale, "Choosing a folder is optional. The desktop app validates it, reconnects Core automatically, and rolls back if the new Vault cannot start.", "选择文件夹是可选项。桌面应用会先校验，再自动重连 Core；如果新知识库无法启动，会回到上一次可用配置。")}</p>
      </section>
      <section class="settings-section" data-settings-panel="models" hidden><header><div><small>${tr(locale, "Model center", "模型")}</small><h3>${tr(locale, "Providers", "模型供应商")}</h3></div><span>${providers.length}</span></header>
        <div class="settings-records">${providers.map((record) => `<article data-provider-profile-card="${escapeHtml(record.provider.profile_id)}"><strong>${escapeHtml(record.provider.display_name)}</strong><span>${escapeHtml(record.provider.kind)} · ${escapeHtml(record.provider.model)}</span><small>v${record.revision} · ${tr(locale, "reasoning", "思考强度")} ${escapeHtml(record.provider.reasoning?.effort ?? "auto")} · ${record.provider.secret_ref ? tr(locale, "API key saved in system credentials", "API Key 已存入系统凭据库") : tr(locale, "no API key needed", "无需 API Key")}</small><div class="provider-record-actions"><button type="button" data-provider-edit="${escapeHtml(record.provider.profile_id)}" data-provider-record="${escapeHtml(JSON.stringify(record))}">${tr(locale, "EDIT", "编辑")}</button><button type="button" data-provider-profile-test="${escapeHtml(record.provider.profile_id)}" data-provider-model="${escapeHtml(record.provider.model)}">${tr(locale, "TEST MODEL", "测试模型")}</button></div><div data-provider-profile-result role="status" aria-live="polite"></div></article>`).join("") || `<p class="empty">${tr(locale, "Choose a cloud provider, local Ollama, or a generic OpenAI-compatible endpoint.", "选择云端供应商、本地 Ollama 或通用 OpenAI 兼容端点。")}</p>`}</div>
        <form id="provider-profile-form" data-version="0">
          <label>${tr(locale, "Name", "名称")}<input name="display_name" required maxlength="120" placeholder="DeepSeek V4 Pro"></label>
          <details class="source-build-fallback"><summary>${tr(locale, "Advanced: profile ID", "高级：配置 ID")}</summary>
            <label>ID<input name="profile_id" required maxlength="80" pattern="[A-Za-z0-9._\\-]+" placeholder="deepseek-main" autocomplete="off"></label>
          </details>
          <label>${tr(locale, "Kind", "类型")}<select name="kind">${providerRegistry.length ? providerRegistry.map((definition) => providerRegistryOption(definition, locale)).join("") : `<option value="deepseek" data-base-url="https://api.deepseek.com" data-auth-kind="bearer" data-reasoning-efforts="high,max" data-reasoning-can-disable="true" data-reasoning-budget="false">DeepSeek</option><option value="glm" data-base-url="https://open.bigmodel.cn/api/paas/v4" data-auth-kind="bearer" data-reasoning-efforts="high,max" data-reasoning-can-disable="true" data-reasoning-budget="false">GLM</option><option value="kimi" data-base-url="https://api.moonshot.cn/v1" data-auth-kind="bearer" data-reasoning-efforts="" data-reasoning-can-disable="true" data-reasoning-budget="false">Kimi</option><option value="qwen" data-base-url="https://dashscope.aliyuncs.com/compatible-mode/v1" data-auth-kind="bearer" data-reasoning-efforts="minimal,low,medium,high,xhigh,max" data-reasoning-can-disable="true" data-reasoning-budget="true">Qwen</option><option value="ollama" data-base-url="http://127.0.0.1:11434" data-auth-kind="none" data-reasoning-efforts="low,medium,high" data-reasoning-can-disable="true" data-reasoning-budget="false">Ollama (${tr(locale, "local", "本地")})</option><option value="openrouter" data-base-url="https://openrouter.ai/api/v1" data-auth-kind="bearer" data-reasoning-efforts="minimal,low,medium,high,xhigh,max" data-reasoning-can-disable="true" data-reasoning-budget="true">OpenRouter</option><option value="open_ai_compatible" data-base-url="https://api.example.invalid/v1" data-auth-kind="bearer" data-reasoning-efforts="" data-reasoning-can-disable="false" data-reasoning-budget="false">OpenAI-compatible</option>`}</select></label>
          <label>${tr(locale, "Base URL", "服务地址")}<input name="base_url" required maxlength="2048" value="https://api.deepseek.com" readonly><small data-provider-endpoint-note>${tr(locale, "Official providers use a locked verified endpoint.", "官方供应商使用经过确认的固定地址。")}</small></label>
          <label data-provider-model-picker>${tr(locale, "Model", "模型")}<select data-provider-model-select required></select><small>${tr(locale, "Choose a recommended model; Restork saves it with this provider.", "从推荐模型中选择；Restork 会把它保存在这个供应商配置中。")}</small></label>
          <label data-provider-custom-model-field hidden>${tr(locale, "Custom model ID", "自定义模型 ID")}<input data-provider-custom-model maxlength="256" autocomplete="off" disabled><small>${tr(locale, "Only generic compatible endpoints need a manually supplied model ID.", "只有通用兼容端点需要手动填写模型 ID。")}</small></label>
          <input name="model" type="hidden" value="deepseek-v4-pro">
          <label>${tr(locale, "Reasoning intensity", "思考强度")}<select name="reasoning_effort">${reasoningEffortOptions(locale)}</select></label>
          <label data-reasoning-budget-field hidden>${tr(locale, "Reasoning token budget (optional)", "思考 Token 预算（可选）")}<input name="reasoning_max_tokens" type="number" min="256" max="128000" step="1" disabled></label>
          <input name="secret_ref" type="hidden">
          <div class="native-secret-setup"><div><strong>${tr(locale, "API key", "API Key")}</strong><small data-provider-secret-status>${tr(locale, "Not saved on this device", "尚未保存在这台设备上")}</small></div><button type="button" data-provider-secret-configure>${tr(locale, "SAVE API KEY SECURELY", "安全保存 API Key")}</button></div>
          <button type="submit" class="btn-primary">${tr(locale, "SAVE PROVIDER", "保存供应商")}</button><p id="provider-profile-status" role="status"></p>
        </form>
        <details class="source-build-fallback"><summary>${tr(locale, "Source-build fallback", "源码运行备用方式")}</summary><p>${tr(locale, "Source builds can still use the provider command printed by Core. Desktop builds do not need that terminal path.", "源码运行仍可使用 Core 提供的供应商配置命令；桌面版不需要走终端流程。")}</p></details>
        <p class="fine">${tr(locale, "The native prompt stores the key in this system's credential vault. Saving a key never tests it or starts a paid request; test the model separately from its card.", "原生弹窗只把 Key 存进系统凭据库。保存 Key 不会顺便测试，也不会发起计费请求；请在模型卡片中单独测试。")}</p>
      </section>
      <div data-settings-panel="advanced" hidden>
        <p class="settings-intro">${tr(
          locale,
          "Prompt revisions and run setups change how Restork follows instructions. Skip this unless you need that.",
          "指令修订和运行配置用来改 Restork 的遵循方式。不需要时可以先不管。",
        )}</p>
      <section class="settings-section"><header><div><small>${tr(locale, "Prompt studio", "指令工作室")}</small><h3>${tr(locale, "Versioned instructions", "版本化指令")}</h3></div><span>${prompts.length}</span></header>
        <div class="settings-records prompt-history">${prompts.map((record) => `<article><strong>${escapeHtml(record.prompt.prompt_id)} · v${record.prompt.revision}</strong><span>${escapeHtml(record.prompt.layer)} · ${escapeHtml(record.content_hash.slice(0, 12))}…</span><small>${record.active ? tr(locale, "ACTIVE", "当前启用") : formatDate(record.created_at, locale)}</small>${record.active ? "" : `<button type="button" data-prompt-activate="${record.prompt.revision}" data-prompt-id="${escapeHtml(record.prompt.prompt_id)}" data-active-revision="${activePrompt?.prompt.revision ?? 0}">${tr(locale, "ACTIVATE", "启用")}</button>`}</article>`).join("") || `<p class="empty">${tr(locale, "Create instructions for yourself or a Skill. Built-in permission rules cannot be changed here.", "可以为自己或 Skill 新建指令；应用内置的权限规则不能在这里修改。")}</p>`}</div>
        <form id="prompt-revision-form" data-version="${prompts[0]?.prompt.revision ?? 0}">
          <label>Prompt ID<input name="prompt_id" required maxlength="80" pattern="[A-Za-z0-9._\\-]+" value="personal"></label>
          <label>${tr(locale, "Layer", "层级")}<select name="layer"><option value="personal">personal</option><option value="skill">skill</option></select></label>
          <label class="wide-label">${tr(locale, "Instructions", "指令")}<textarea name="content" required maxlength="64000" rows="8" placeholder="${tr(locale, "Describe how you want Restork to respond. This does not change app permissions.", "写下你希望 Restork 如何回答；这里的内容不会改变应用权限。")}"></textarea></label>
          <button type="submit">${tr(locale, "SAVE NEW REVISION", "保存新修订")}</button><p id="prompt-revision-status" role="status"></p>
        </form>
      </section>
      <section class="settings-section"><header><div><small>${tr(locale, "Run setups", "运行配置")}</small><h3>${tr(locale, "Run setups", "运行配置")}</h3></div><span>${profiles.length}</span></header>
        <div class="settings-records">${profiles.map((record) => `<article><strong>${escapeHtml(record.profile.name)}</strong><span>${escapeHtml(record.profile.provider_profile_id)} · ${escapeHtml(dataClassLabel(record.profile.maximum_data_class, locale))}</span><small>v${record.revision}${record.builtin ? ` · ${tr(locale, "built-in", "内置")}` : ""}</small></article>`).join("") || `<p class="empty">${tr(locale, "A run setup keeps the model, instructions, tools, and allowed data together.", "运行配置会把模型、指令、工具和可用的数据范围放在一起。")}</p>`}</div>
        <form id="configuration-profile-form" data-version="0" data-prompt-hash="${escapeHtml(activePrompt?.content_hash ?? "")}">
          <label>ID<input name="profile_id" required maxlength="80" pattern="[A-Za-z0-9._\\-]+" placeholder="research-cloud"></label>
          <label>${tr(locale, "Name", "名称")}<input name="name" required maxlength="120" placeholder="Research Cloud"></label>
          <label>${tr(locale, "Provider", "供应商")}<select name="provider_profile_id" required>${providers.map((record) => `<option value="${escapeHtml(record.provider.profile_id)}">${escapeHtml(record.provider.display_name)}</option>`).join("")}</select></label>
          <label>${tr(locale, "Content this setup may use", "这个配置可使用的内容")}<select name="maximum_data_class">${dataClassOptions(locale)}</select></label>
          <label>${tr(locale, "Enabled Skills (comma separated)", "启用的 Skills（逗号分隔）")}<input name="enabled_skill_ids" maxlength="4000" list="skill-id-options" placeholder="core.research,core.study"></label>
          <label>${tr(locale, "Allowed tools (comma separated)", "允许的工具（逗号分隔）")}<input name="allowed_tools" maxlength="4000" list="tool-id-options" placeholder="vault_search,source_read"></label>
          <label class="check-label"><input type="checkbox" name="include_display_name_in_prompt">${tr(locale, "Include my display name in this run setup's instructions", "允许这份运行配置在指令中包含我的称呼")}</label>
          <button type="submit" ${providers.length && activePrompt ? "" : "disabled"}>${tr(locale, "SAVE RUN SETUP", "保存运行配置")}</button><p id="configuration-profile-status" role="status">${providers.length && activePrompt ? "" : tr(locale, "Add a provider and activate instructions first.", "请先添加供应商并启用一份指令。")}</p>
        </form>
        <datalist id="skill-id-options">
          <option value="core.research"></option><option value="core.study"></option>
          <option value="core.work"></option><option value="core.reports"></option>
          <option value="core.presentation"></option>
        </datalist>
        <datalist id="tool-id-options">
          <option value="vault_search"></option><option value="source_read"></option>
          <option value="vault_write"></option><option value="web_search"></option>
        </datalist>
      </section>
      </div>
      <div data-settings-panel="about" hidden>
      <section class="settings-section desktop-updates" data-desktop-updates><header><div><small>${tr(locale, "Desktop updates", "版本更新")}</small><h3>${tr(locale, "Updates", "版本更新")}</h3></div><span data-update-current>—</span></header>
        <p data-update-owner>${tr(locale, "Checking how this installation receives updates…", "正在确认当前安装方式……")}</p>
        <form class="update-preferences" data-update-preferences>
          <label>${tr(locale, "Channel", "更新通道")}<select name="update_channel"><option value="stable">${tr(locale, "Stable", "正式版")}</option><option value="beta">Beta</option></select></label>
          <label class="check-label"><input type="checkbox" name="automatic_checks" checked>${tr(locale, "Tell me when a new version is available", "发现新版本时提醒我")}</label>
        </form>
        <div class="update-actions">
          <button type="button" data-update-check>${tr(locale, "CHECK NOW", "立即检查")}</button>
          <button type="button" data-update-download hidden>${tr(locale, "DOWNLOAD & VERIFY", "下载并验证")}</button>
          <button type="button" class="quiet-button" data-update-cancel hidden>${tr(locale, "CANCEL DOWNLOAD", "取消下载")}</button>
        </div>
        <progress data-update-progress max="100" value="0" hidden></progress>
        <div class="update-actions" data-update-schedule-actions hidden>
          <button type="button" data-update-schedule="next_launch">${tr(locale, "INSTALL NEXT LAUNCH", "下次启动安装")}</button>
          <button type="button" class="quiet-button" data-update-schedule="when_idle">${tr(locale, "WHEN WORK FINISHES", "工作结束后安装")}</button>
        </div>
        <p data-update-message role="status" aria-live="polite">${tr(locale, "Loading update status…", "正在读取更新状态……")}</p>
        <details class="update-recovery"><summary>${tr(locale, "Recovery copies", "恢复副本")}</summary><p>${tr(locale, "Restork keeps at most two packages after their Tauri signature has been verified. It never installs a downgrade on its own.", "Restork 最多保留两个通过 Tauri 签名校验的更新包，也不会自行安装旧版本。")}</p>
        <button type="button" data-update-recovery>${tr(locale, "SHOW RECOVERY COPIES", "查看恢复副本")}</button>
        <div id="update-recovery-results" class="settings-records" role="status"><p class="empty">${tr(locale, "Available in the signed desktop app.", "仅在已签名桌面应用中可用。")}</p></div>
        </details>
      </section>
      <section class="settings-section" data-project-boundary><header><div><small>${tr(locale, "Open source", "开源")}</small><h3>${tr(locale, "About Restork & support", "关于 Restork 与支持")}</h3></div><span>MIT</span></header>
        <p>${tr(locale,
          "Restork is free and maintained in public to help researchers, developers, and knowledge workers. Important AI output can still be wrong: review it, keep backups, and keep provider keys under your control.",
          "Restork 免费、开源，希望帮助研究者、开发者与知识工作者。重要的 AI 结果仍可能出错：请复核内容、保留备份，并把模型 Key 掌握在自己手里。",
        )}</p>
        <div class="provider-record-actions">
          ${projectBoundaryLink}
          ${projectSecurityLink}
          ${projectLicenseLink}
        </div>
        <p class="fine">${tr(locale,
          "Community help uses GitHub Discussions; private vulnerability reports do not require publishing a personal maintainer email.",
          "社区使用问题走 GitHub Discussions；私密漏洞报告不需要公开维护者的个人邮箱。",
        )}</p>
      </section>
      </div>
    </div>
  </article>`;
}

export function sessionMessagesMarkup(
  messages: SessionMessageV2[],
  locale: Locale,
): string {
  return messages.map((message) => `<article class="chat-bubble ${message.role}"><small>${message.role === "user" ? tr(locale, "You", "你") : "Restork"} · ${formatDate(message.created_at, locale)}</small><p>${escapeHtml(message.content)}</p></article>`).join("") || `<p class="empty">${tr(locale, "This conversation is ready for its first message.", "这个对话正等着第一条消息。")}</p>`;
}

export function conversationOperationWaitMarkup(
  phase: string,
  locale: Locale,
  canCancel = true,
): string {
  const copy: Record<string, [string, string]> = {
    queued: ["Queued locally", "已在本地排队"],
    model: ["Thinking with the configured model", "正在使用已配置模型思考"],
    validating: ["Checking and saving the answer", "正在检查并保存回答"],
    cancelling: ["Stopping this response", "正在停止这次回答"],
    cancelled: ["Stopped; the partial answer was not saved", "已停止；未保存不完整回答"],
    failed: ["This response stopped before completion", "这次回答未能完成"],
  };
  const [en, zh] = copy[phase] ?? copy.queued;
  return `<div class="conversation-wait" data-operation-phase="${escapeHtml(phase)}"><i aria-hidden="true"></i>
    <span><strong>${tr(locale, en, zh)}</strong><small>${tr(
      locale,
      "No tools are used here · this response reconnects after a brief interruption",
      "这里不会调用工具 · 短暂断线后会接回这次回答",
    )}</small></span>
    ${canCancel ? `<button type="button" class="quiet-button" data-conversation-cancel>${tr(locale, "STOP", "停止")}</button>` : ""}
  </div>`;
}

export function runProposalMarkup(proposal: RunProposalV2, locale: Locale): string {
  return `<article class="proposal-card"><header><strong>${tr(locale, "Run preview", "运行预览")}</strong><span>${escapeHtml(proposal.mode)}</span></header><p>${escapeHtml(proposal.goal)}</p><dl><div><dt>${tr(locale, "Tools", "工具")}</dt><dd>${proposal.requested_tools.length}</dd></div><div><dt>${tr(locale, "Sources", "来源")}</dt><dd>${proposal.sources.length}</dd></div><div><dt>${tr(locale, "Created", "生成位置")}</dt><dd>${tr(locale, "On this device", "这台设备")}</dd></div></dl><small>${tr(locale, "Restork did not open files, connect to a model, or run tools while preparing this preview.", "准备这份预览时，Restork 没有打开文件、连接模型或运行工具。")}</small></article>`;
}

function runSkillsMarkup(run: RunListEntry, locale: Locale): string {
  const skills = run.task?.skills ?? [];
  if (!skills.length) return "";
  const items = skills
    .map((skill) => `${escapeHtml(skill.name)} · ${escapeHtml(skill.manifest_hash.slice(0, 12))}…`)
    .join(" · ");
  return `<div><dt>${tr(locale, "SKILLS", "使用的技能")}</dt><dd>${items}</dd></div>`;
}

export function runEventsMarkup(
  run: RunListEntry,
  events: RunEvent[],
  locale: Locale = "en",
  page?: PageInfo,
  conversation?: {
    turns: ConversationTurn[];
    page: PageInfo;
    enabled: boolean;
    busy?: boolean;
    draft?: string;
    error?: string;
  },
): string {
  const summary = run.summary;
  const turns = conversation?.turns ?? [];
  const prompt = [...turns].reverse().find((turn) => turn.prompt_version);
  const assistantOutput = events
    .filter((event) => event.type === "assistant.delta")
    .map((event) => typeof event.data.content === "string" ? event.data.content : "")
    .join("");
  const phaseEvents = events.filter((event) => event.type !== "assistant.delta");
  return `
    <article class="paper-card detail-card">
      <header><h2>${escapeHtml(run.task?.goal ?? summary.task_id)}</h2><span class="ribbon ${escapeHtml(summary.mode)}">${escapeHtml(summary.mode)}</span></header>
      <dl class="metadata">
        <div><dt>${tr(locale, "TYPE", "类型")}</dt><dd>${escapeHtml(modeLabel(summary.mode, locale))}</dd></div>
        <div><dt>${tr(locale, "STATUS", "状态")}</dt><dd>${escapeHtml(runStateLabel(summary.state, locale))}</dd></div>
        <div><dt>${tr(locale, "UPDATED", "更新时间")}</dt><dd>${formatDate(summary.updated_at, locale)}</dd></div>
        <div data-run-budget><dt>${tr(locale, "BUDGET", "预算")}</dt><dd>${escapeHtml(runBudgetUsedCopy(
          locale,
          run.task?.budgets?.max_steps ?? run.budget?.budget?.max_steps ?? DEFAULT_MODEL_TURNS,
          run.budget?.usage?.steps ?? 0,
          run.budget?.usage?.tokens ?? 0,
        ))}</dd></div>
        ${runSkillsMarkup(run, locale)}
      </dl>
      <details class="technical-details"><summary>${tr(locale, "Technical details", "技术详情")}</summary><code>${tr(locale, "Run reference", "运行标识")} · ${escapeHtml(summary.run_id)}</code></details>
      ${traceMarkup(buildRunTrace(events), locale)}
      ${paginationControl("events", page, locale, tr(locale, "LOAD EARLIER EVENTS", "加载更早事件"))}
      <section class="assistant-stream" ${assistantOutput ? "" : "hidden"} aria-live="polite"><small>ASSISTANT · STREAM</small>${assistantStreamMarkup(assistantOutput, locale)}</section>
      <ol class="event-list">${phaseEvents.length ? phaseEvents.map((event) => eventRow(event, locale)).join("") : `<li>${tr(locale, "No new events.", "暂无新事件。")}</li>`}</ol>
      <section class="conversation-panel" aria-labelledby="conversation-title">
        <header>
          <div><p class="eyebrow">${tr(locale, "This run · chat only", "本次运行 · 仅对话")}</p><h3 id="conversation-title">${tr(locale, "Conversation", "多轮对话")}</h3></div>
          <span>${prompt ? `PROMPT ${escapeHtml(prompt.prompt_version)}` : tr(locale, "RECENT MESSAGES", "最近消息")}</span>
        </header>
        <div class="conversation-history" data-conversation-scroll role="log" aria-live="polite" tabindex="0">
          ${paginationControl("conversation", conversation?.page, locale, tr(locale, "LOAD EARLIER MESSAGES", "加载更早消息"))}
          ${turns.length ? turns.map((turn) => conversationTurnMarkup(turn, locale)).join("") : `<p class="empty">${tr(locale, "Ask about this run. Conversation history stays local.", "围绕此运行提问；对话历史留在本地。")}</p>`}
          ${conversation?.busy ? `<div class="conversation-wait" role="status" aria-busy="true"><i></i><i></i><i></i><span>${tr(locale, "The selected model is preparing an answer…", "所选模型正在整理回答…")}</span></div>` : ""}
          <div class="skill-suggest-row" data-skill-conversation-suggest hidden></div>
        </div>
        ${conversation?.error ? `<p class="conversation-error" role="alert">${escapeHtml(conversation.error)}</p>` : ""}
        <form class="conversation-composer" data-conversation-form data-run-id="${escapeHtml(summary.run_id)}">
          <label for="conversation-input">${tr(locale, "Message for this run", "给当前运行发送消息")}</label>
          <textarea id="conversation-input" name="content" rows="3" maxlength="16000" required ${conversation?.enabled && !conversation.busy ? "" : "disabled"} placeholder="${tr(locale, "Ask, compare, explain, or refine…", "提问、比较、解释或继续细化…")}">${escapeHtml(conversation?.draft ?? "")}</textarea>
          <div><small>${tr(locale, "Uses recent messages only · tools are off · file and tool actions always ask first", "只参考最近消息 · 不会调用工具 · 写文件或调用工具前会再次询问")}</small><button type="submit" ${conversation?.enabled && !conversation.busy ? "" : "disabled"}>${tr(locale, "SEND", "发送")}</button></div>
        </form>
      </section>
    </article>`;
}

function conversationTurnMarkup(turn: ConversationTurn, locale: Locale): string {
  const assistant = turn.assistant
    ? `<article class="conversation-message assistant"><header><b>RESTORK</b><time>${formatDate(turn.assistant.created_at, locale)}</time></header><p>${escapeHtml(turn.assistant.content)}</p><small>${turn.total_tokens ?? 0} tokens · ${turn.dropped_messages} ${tr(locale, "dropped from context", "条消息未进入上下文")}</small></article>`
    : `<article class="conversation-message assistant pending"><p>${tr(locale, "No completed answer was recorded for this turn.", "此轮尚未记录完整回答。")}</p></article>`;
  return `<div class="conversation-turn" data-turn-sequence="${turn.sequence}"><article class="conversation-message user"><header><b>${tr(locale, "YOU", "你")}</b><time>${formatDate(turn.user.created_at, locale)}</time></header><p>${escapeHtml(turn.user.content)}</p></article>${assistant}</div>`;
}

export function researchPreviewMarkup(
  artifact: ResearchArtifact,
  locale: Locale = "en",
): string {
  const metrics = artifact.metrics;
  return `<article class="research-result" aria-labelledby="research-result-title">
    <header><div><p class="eyebrow">${tr(locale, "RESEARCH RESULT", "研究结果")}</p><h3 id="research-result-title">${escapeHtml(artifact.question)}</h3></div><span>${escapeHtml(artifact.note_preview.action.toUpperCase())}</span></header>
    <dl class="research-metrics">
      <div><dt>${tr(locale, "SUPPORTED", "有证据")}</dt><dd>${percent(metrics.supported_claim_rate)}</dd></div>
      <div><dt>${tr(locale, "PRIMARY", "一手来源")}</dt><dd>${measuredPercent(metrics.primary_source_ratio, locale)}</dd></div>
      <div><dt>${tr(locale, "CITATIONS", "引用")}</dt><dd>${measuredPercent(metrics.citation_correctness, locale)}</dd></div>
      <div><dt>${tr(locale, "RELATED", "相关笔记")}</dt><dd>${metrics.related_note_count}</dd></div>
    </dl>
    <section><h4>${tr(locale, "Findings", "结论")}</h4><ol>${artifact.claims.map((claim) => `<li><b>${escapeHtml(claim.kind)}</b>${escapeHtml(claim.statement)}<small>${claim.evidence_refs.map(escapeHtml).join(" · ") || escapeHtml(claim.inference_basis ?? tr(locale, "model inference", "模型推断"))}</small></li>`).join("")}</ol></section>
    ${artifact.conflicts.length ? `<section><h4>${tr(locale, "Conflicts", "冲突")}</h4><ul>${artifact.conflicts.map((conflict) => `<li>${escapeHtml(conflict.description)}</li>`).join("")}</ul></section>` : ""}
    <section><h4>${tr(locale, "Markdown preview", "Markdown 预览")} · ${escapeHtml(artifact.note_preview.relative_path)}</h4><pre>${escapeHtml(artifact.note_preview.markdown)}</pre></section>
    <button type="button" data-note-save="research" data-note-run-id="${escapeHtml(artifact.run_id)}">${tr(locale, "SAVE TO VAULT", "存入知识库")}</button>
    <p class="fine">${tr(locale, "Preview only · Core has not written this note.", "仅预览 · Core 尚未写入此笔记。")} ${tr(locale, "Artifact", "产物")} ${escapeHtml(artifact.artifact_id)}</p>
  </article>`;
}

export function workPlanMarkup(plan: WorkPlanArtifact, locale: Locale = "en"): string {
  return `<article class="work-result" aria-labelledby="work-plan-title">
    <header><div><p class="eyebrow">${tr(locale, "WORK PLAN · PREVIEW ONLY", "工作计划 · 仅预览")}</p><h3 id="work-plan-title">${escapeHtml(plan.goal)}</h3></div><span>${tr(locale, "DOES NOT RUN CODE", "不会运行代码")}</span></header>
    <dl class="work-metrics"><div><dt>${tr(locale, "WORKSPACE", "工作区")}</dt><dd>${escapeHtml(plan.workspace_id)}</dd></div><div><dt>${tr(locale, "FILES", "文件")}</dt><dd>${plan.context_manifest.length}</dd></div><div><dt>${tr(locale, "TARGETS", "目标")}</dt><dd>${plan.target_files.length}</dd></div><div><dt>${tr(locale, "CLASS", "分类")}</dt><dd>${escapeHtml(plan.sensitivity)}</dd></div></dl>
    <section><h4>${tr(locale, "Work plan", "执行计划")}</h4><ol class="work-plan">${plan.plan_steps.map((step) => `<li><b>${step.order}</b><span>${escapeHtml(step.title)}<small>${escapeHtml(step.intent)}</small></span></li>`).join("")}</ol></section>
    <section><h4>${tr(locale, "Reference files", "参考文件")}</h4><ul class="work-manifest">${plan.context_manifest.map((item) => `<li><code>${escapeHtml(item.relative_path)}</code><span>${escapeHtml(item.data_class)} · ${item.byte_count} bytes · ${item.included_in_handoff ? tr(locale, "selected", "已选择") : tr(locale, "reference only", "仅引用")}</span></li>`).join("")}</ul></section>
    ${plan.instruction_refs.length ? `<section><h4>${tr(locale, "Untrusted repository instructions", "不受信任的仓库指令")}</h4><p>${plan.instruction_refs.map(escapeHtml).join(" · ")}</p></section>` : ""}
    <ul class="work-warnings">${plan.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
    <button type="button" data-work-preview data-run-id="${escapeHtml(plan.run_id)}">${tr(locale, "PREVIEW HANDOFF PACKAGE", "预览交接包")}</button>
    <p class="fine">${tr(locale, "Plan only. No source file, shell, Git state, deployment, or message was changed.", "仅生成计划。源文件、Shell、Git 状态、部署和消息均未改变。")}</p>
  </article>`;
}

export function studyDiagnosticMarkup(
  diagnostic: StudyDiagnostic,
  locale: Locale = "en",
): string {
  return `<article class="study-result" aria-labelledby="study-diagnostic-title">
    <header><div><p class="eyebrow">${tr(locale, "DIAGNOSTIC FIRST · ANSWERS ARE NOT STORED", "先诊断 · 不保存原始回答")}</p><h3 id="study-diagnostic-title">${escapeHtml(diagnostic.objective)}</h3></div><span>${tr(locale, "READY", "可作答")}</span></header>
    <form data-study-diagnostic data-run-id="${escapeHtml(diagnostic.run_id)}">
      ${diagnostic.questions.map((question, index) => `<label>${index + 1}. ${escapeHtml(question.prompt)}${question.response_kind === "rating" ? `<input data-diagnostic-question name="${escapeHtml(question.question_id)}" type="number" min="0" max="4" required inputmode="numeric">` : `<textarea data-diagnostic-question name="${escapeHtml(question.question_id)}" required maxlength="4000" rows="3" autocomplete="off"></textarea>`}</label>`).join("")}
      <button type="submit">${tr(locale, "BUILD LEARNING PATH", "生成学习路径")}</button>
    </form>
    <p class="fine">${tr(locale, "Your fields are cleared after submission. Core stores only a SHA-256 digest of the answer set.", "提交后输入框会被清空；Core 只保存整组回答的 SHA-256 摘要。")}</p>
  </article>`;
}

export function studyArtifactMarkup(
  artifact: StudyArtifact,
  locale: Locale = "en",
): string {
  return `<article class="study-result" aria-labelledby="study-artifact-title">
    <header><div><p class="eyebrow">${tr(locale, "BASED ON YOUR NOTES", "根据你的笔记评估")}</p><h3 id="study-artifact-title">${escapeHtml(artifact.objective.outcome)}</h3></div><span>${escapeHtml(artifact.readiness_signal.toUpperCase())}</span></header>
    <section><h4>${tr(locale, "Learning path", "学习路径")}</h4><ol class="study-path">${artifact.learning_path.map((step) => `<li><b>${step.order}</b><span>${escapeHtml(step.title)}<small>${escapeHtml(step.outcome)}</small></span></li>`).join("")}</ol></section>
    ${artifact.prerequisites.length ? `<section><h4>${tr(locale, "What to know first", "需要先掌握")}</h4><ul>${artifact.prerequisites.map((item) => `<li>${escapeHtml(item.title)}<small>${escapeHtml(item.relative_path)}</small></li>`).join("")}</ul></section>` : ""}
    <section><h4>${tr(locale, "Active practice · no answer key", "主动练习 · 不展示答案")}</h4><div class="study-exercises">${artifact.exercises.map((exercise) => `<form data-study-practice data-run-id="${escapeHtml(artifact.run_id)}" data-exercise-id="${escapeHtml(exercise.exercise_id)}"><b>${escapeHtml(exercise.kind.replace("_", " "))}</b><p>${escapeHtml(exercise.prompt)}</p><small>${exercise.hints.map(escapeHtml).join(" · ")}</small><label>${tr(locale, "Your response", "你的回答")}<textarea name="answer" required maxlength="8000" rows="3" autocomplete="off"></textarea></label><label>${tr(locale, "Confidence", "信心程度")}<select name="confidence" required><option value="1">1</option><option value="2">2</option><option value="3" selected>3</option><option value="4">4</option><option value="5">5</option></select></label><button type="submit">${tr(locale, "GRADE WITH MODEL", "交给模型评估")}</button><div class="study-attempt" role="status"></div></form>`).join("")}</div></section>
    ${artifact.note_preview ? `<section><h4>${tr(locale, "Markdown preview", "Markdown 预览")} · ${escapeHtml(artifact.note_preview.relative_path)}</h4><pre>${escapeHtml(artifact.note_preview.markdown)}</pre></section><button type="button" data-note-save="study" data-note-run-id="${escapeHtml(artifact.run_id)}">${tr(locale, "SAVE TO VAULT", "存入知识库")}</button>` : ""}
    <p class="fine">${tr(locale, "Raw answers are neither rendered back nor persisted. Review scheduling uses the verdict and your confidence.", "原始回答不会回显或持久化；复习时间只依据评估结果和你的信心程度。")}</p>
  </article>`;
}

export function studyAttemptMarkup(
  result: PracticeAttemptResult,
  locale: Locale = "en",
): string {
  return `<section class="study-feedback ${result.correct ? "is-correct" : "is-retry"}">
    <b>${result.correct ? tr(locale, "CORRECT · SPACED REVIEW", "正确 · 间隔复习") : tr(locale, "RETRY WITH HINT", "结合提示重试")}</b>
    <p>${escapeHtml(result.feedback)}</p>
    <small>${escapeHtml(result.next_review.reason)} · ${formatDate(result.next_review.due_at, locale)}</small>
  </section>`;
}

export function workHandoffMarkup(preview: WorkHandoffPreview, locale: Locale = "en"): string {
  return `<article class="work-result" aria-labelledby="work-handoff-title">
    <header><div><p class="eyebrow">${tr(locale, "HANDOFF PACKAGE PREVIEW", "交接包预览")}</p><h3 id="work-handoff-title">${escapeHtml(preview.envelope.goal)}</h3></div><span>${tr(locale, "REVIEW BEFORE EXPORT", "导出前请确认")}</span></header>
    <dl class="work-metrics"><div><dt>${tr(locale, "PACKAGE", "交接包")}</dt><dd>${preview.byte_count} B</dd></div><div><dt>${tr(locale, "FILES", "文件")}</dt><dd>${preview.envelope.context.length}</dd></div><div><dt>${tr(locale, "FINGERPRINT", "内容指纹")}</dt><dd>${escapeHtml(preview.package_hash.slice(0, 12))}…</dd></div><div><dt>${tr(locale, "DESTINATION", "去向")}</dt><dd>${tr(locale, "External", "外部")}</dd></div></dl>
    <section><h4>${tr(locale, "File content included in this package", "交接包将包含的文件内容")}</h4>
      <button type="button" class="quiet-button" data-preview-open data-preview-kind="files"
        data-preview-title="${tr(locale, "Handoff files", "交接包文件")}">${tr(locale, "Review file content", "查看文件内容")}</button>
      <div class="preview-source handoff-contexts" data-preview-source hidden>${preview.envelope.context.map((item) => `<article data-preview-file><summary><code>${escapeHtml(item.relative_path)}</code><span>${escapeHtml(item.data_class)} · ${item.byte_count} bytes · ${item.redactions.map(escapeHtml).join(", ") || tr(locale, "no redactions", "无脱敏项")}</span></summary><pre>${escapeHtml(item.content)}</pre></article>`).join("")}</div>
    </section>
    <section><h4>${tr(locale, "Handoff scope", "交接范围")}</h4><p><b>${tr(locale, "Targets:", "目标：")}</b> ${preview.envelope.target_files.map(escapeHtml).join(" · ")}</p><p><b>${tr(locale, "Criteria:", "完成条件：")}</b> ${preview.envelope.completion_criteria.map(escapeHtml).join(" · ")}</p><p><b>${tr(locale, "Suggested only:", "仅建议：")}</b> ${preview.envelope.proposed_verification_commands.map(escapeHtml).join(" · ") || tr(locale, "No command proposed", "未建议命令")}</p></section>
    <div class="work-actions"><button type="button" data-work-export data-run-id="${escapeHtml(preview.envelope.run_id)}" data-approval-id="${escapeHtml(preview.approval.approval_id)}">${tr(locale, "APPROVE &amp; EXPORT LOCALLY", "批准并在本地导出")}</button><button class="secondary" type="button" data-work-reject data-approval-id="${escapeHtml(preview.approval.approval_id)}">${tr(locale, "REJECT", "拒绝")}</button></div>
    <p class="fine">${tr(locale, "Your confirmation applies only to this package version. The exported file stays in Restork's private data directory.", "这次确认只适用于当前版本的交接包；导出文件会留在 Restork 的私有数据目录中。")}</p>
  </article>`;
}

export function workExportMarkup(
  result: WorkExportResult,
  plan: WorkPlanArtifact,
  locale: Locale = "en",
): string {
  const template = JSON.stringify({
    schema_version: 1,
    run_id: result.run_id,
    plan_artifact_id: plan.artifact_id,
    base_snapshot_hash: plan.workspace_snapshot_hash,
    changed_files: [],
    claimed_commands: [],
    artifacts: [],
    summary: tr(locale, "Describe the external result without secrets.", "描述外部执行结果，不要包含秘密。"),
  }, null, 2);
  return `<article class="work-result" aria-labelledby="work-export-title">
    <header><div><p class="eyebrow">${tr(locale, "PRIVATE HANDOFF EXPORTED", "私有交接包已导出")}</p><h3 id="work-export-title">${tr(locale, "External execution remains user-started", "外部执行仍由你自行启动")}</h3></div><span>0600 LOCAL</span></header>
    <dl class="work-metrics"><div><dt>${tr(locale, "REFERENCE", "引用")}</dt><dd>${escapeHtml(result.artifact_ref)}</dd></div><div><dt>${tr(locale, "BYTES", "字节")}</dt><dd>${result.byte_count}</dd></div><div><dt>HASH</dt><dd>${escapeHtml(result.package_hash.slice(0, 12))}…</dd></div><div><dt>${tr(locale, "NETWORK", "网络")}</dt><dd>${tr(locale, "none", "无")}</dd></div></dl>
    <p class="fine">${tr(locale, "Start your external coding session independently. Restork neither launches nor supervises it.", "请独立启动外部编码会话。Restork 既不启动，也不监督该会话。")}</p>
    <form data-work-verify data-run-id="${escapeHtml(result.run_id)}"><label>${tr(locale, "Paste result manifest", "粘贴结果清单")}<textarea name="manifest" required maxlength="2000000" rows="14" autocomplete="off" spellcheck="false">${escapeHtml(template)}</textarea></label><button type="submit">${tr(locale, "VERIFY READ-ONLY EVIDENCE", "验证只读证据")}</button></form>
  </article>`;
}

export function workVerificationMarkup(
  report: WorkVerificationReport,
  locale: Locale = "en",
): string {
  const evidence = [...report.changed_files, ...report.artifacts];
  return `<article class="work-result ${report.completion_eligible ? "is-verified" : "is-failed"}" aria-labelledby="work-verification-title">
    <header><div><p class="eyebrow">${tr(locale, "IMPORTED RESULT · INDEPENDENT CHECK", "导入结果 · 独立检查")}</p><h3 id="work-verification-title">${escapeHtml(report.status.toUpperCase())}</h3></div><span>${report.completion_eligible ? tr(locale, "ELIGIBLE", "符合条件") : tr(locale, "USER ACTION", "需要你处理")}</span></header>
    <section><h4>${tr(locale, "Filesystem evidence", "文件系统证据")}</h4><ul class="work-manifest">${evidence.map((item) => `<li><code>${escapeHtml(item.relative_path)}</code><span>${escapeHtml(item.status)} · ${escapeHtml(item.reason)}</span></li>`).join("") || `<li>${tr(locale, "No verifiable file evidence was supplied.", "未提供可验证的文件证据。")}</li>`}</ul></section>
    ${report.commands.length ? `<section><h4>${tr(locale, "Command claims", "命令声明")}</h4><p>${plural(locale, report.commands.length, {
      one: "{n} claim remains UNVERIFIED. Restork did not execute it.",
      other: "{n} claims remain UNVERIFIED. Restork did not execute them.",
      zh: "{n} 项声明仍未验证。Restork 没有执行这些命令。",
    })}</p></section>` : ""}
    ${report.unexpected_changes.length ? `<section><h4>${tr(locale, "Unexpected changes", "意外变更")}</h4><p>${report.unexpected_changes.map(escapeHtml).join(" · ")}</p></section>` : ""}
    ${report.task_update_preview ? `<section><h4>${tr(locale, "Markdown task update · preview only", "Markdown 任务更新 · 仅预览")}</h4><pre>${escapeHtml(report.task_update_preview.suggested_markdown)}</pre><p>${tr(locale, "Apply is disabled here; review it through the Core-owned Markdown task flow.", "此处禁止应用；请通过 Core 管理的 Markdown 任务流程进行审阅。")}</p></section>` : ""}
    <p class="fine">${tr(locale, "Verification", "验证")} ${escapeHtml(report.verification_id)} · ${formatDate(report.created_at, locale)}</p>
  </article>`;
}

export function errorText(error: unknown, locale: Locale = "en"): string {
  if (!(error instanceof Error)) return tr(locale, "Unexpected local error", "发生意外的本地错误");
  const message = error.message.trim();
  if (locale !== "zh-CN" || /[\u3400-\u9fff]/u.test(message)) return message;
  const lower = message.toLowerCase();
  if (lower.includes("provider") && (lower.includes("not configured") || lower.includes("unknown"))) {
    return "尚未配置模型，请先前往设置完成配置。";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) return "请求等待超时，请稍后重试。";
  if (lower.includes("failed to fetch") || lower.includes("network") || lower.includes("connection")) {
    return "暂时无法连接本地 Core 或外部服务，请检查连接后重试。";
  }
  if (lower.includes("unauthorized") || lower.includes("authentication")) return "凭据验证失败，请检查配置。";
  if (lower.includes("revision") || lower.includes("conflict")) return "内容已在别处更新，请刷新后重试。";
  if (lower.includes("not found")) return "没有找到对应内容，它可能已被移动或删除。";
  if (lower.includes("vault") && lower.includes("not configured")) return "尚未配置知识库，请先前往设置选择 Vault。";
  return "操作未完成，请稍后重试。";
}

export function waitNextForError(error: unknown, locale: Locale): AgentWaitNextStep {
  const message = `${error instanceof Error ? error.message : ""} ${errorText(error, locale)}`.toLowerCase();
  if (
    (message.includes("provider") && (message.includes("not configured") || message.includes("unknown")))
    || message.includes("尚未配置模型")
  ) {
    return { action: "settings", label: tr(locale, "Open Settings · Models", "打开设置 · 模型") };
  }
  if (message.includes("vault") || message.includes("知识库")) {
    return { action: "vault", label: tr(locale, "Open knowledge library", "打开知识库") };
  }
  if (
    message.includes("timeout")
    || message.includes("timed out")
    || message.includes("network")
    || message.includes("fetch")
    || message.includes("connection")
    || message.includes("超时")
    || message.includes("稍后重试")
  ) {
    return { action: "retry", label: tr(locale, "Retry", "重试") };
  }
  return { action: "retry", label: tr(locale, "Retry", "重试") };
}

/**
 * Prefer the command Core reports, because only Core knows where its own binary
 * lives. A bare `restorkd` is not on PATH for a packaged install, so guessing it
 * here left DMG users unable to configure a model at all.
 *
 * The literal is a last resort for a snapshot that carries no diagnostic.
 */
function providerNativeCommand(kind: ProviderKindV2, reported?: string): string {
  if (reported) return reported;
  return kind === "ollama" ? "ollama serve" : `restorkd provider configure ${kind}`;
}

function providerSetup(snapshot: DashboardSnapshot, locale: Locale): string {
  const report = snapshot.provider;
  const records = snapshot.workspaceV2?.providers ?? [];
  const definitions = snapshot.workspaceV2?.providerRegistry?.items ?? [];
  const configured = records.map(({ provider }) => {
    const definition = definitions.find((item) => item.kind === provider.kind);
    return {
      profileId: provider.profile_id,
      displayName: provider.display_name,
      kind: provider.kind,
      model: provider.model,
      authKind: definition?.auth_kind ?? (provider.kind === "ollama" ? "none" : "bearer"),
      setupCommand: definition?.setup_command ?? providerNativeCommand(provider.kind),
    };
  });
  if (report && !configured.some((item) => item.profileId === report.provider)) {
    configured.unshift({
      profileId: report.provider,
      displayName: report.provider === "deepseek" ? "DeepSeek V4 Pro" : report.provider,
      kind: report.provider === "deepseek" ? "deepseek" : "open_ai_compatible",
      model: report.model,
      authKind: "bearer",
      setupCommand: report.setup_command,
    });
  }
  const selected = configured.find((item) => item.profileId === report?.provider)
    ?? configured[0];
  const selectedKind = selected?.kind ?? "deepseek";
  const selectedModel = selected?.model ?? report?.model ?? "deepseek-v4-pro";
  const setupCommand = selected?.setupCommand
    ?? providerNativeCommand(
      selectedKind,
      report && report.provider === selected?.profileId ? report.setup_command : undefined,
    );
  const status = report && report.provider === selected?.profileId
    ? report.status
    : selected
    ? "not_tested"
    : "setup_required";
  const configuredOptions = configured.map((item) => `<option value="${escapeHtml(item.profileId)}" data-provider-profile-id="${escapeHtml(item.profileId)}" data-provider-kind="${escapeHtml(item.kind)}" data-provider-model="${escapeHtml(item.model)}" data-provider-name="${escapeHtml(item.displayName)}" data-provider-auth-kind="${escapeHtml(item.authKind)}" data-provider-setup-command="${escapeHtml(item.setupCommand)}" data-provider-configured="true" ${item.profileId === selected?.profileId ? "selected" : ""}>${escapeHtml(`${item.displayName} / ${item.model} · ${item.profileId}`)}</option>`).join("");
  const availableOptions = definitions.map((definition) => `<option value="setup:${escapeHtml(definition.kind)}" data-provider-profile-id="" data-provider-kind="${escapeHtml(definition.kind)}" data-provider-model="" data-provider-name="${escapeHtml(definition.display_name)}" data-provider-auth-kind="${escapeHtml(definition.auth_kind)}" data-provider-setup-command="${escapeHtml(definition.setup_command)}" data-provider-configured="false">${escapeHtml(tr(locale, `Add ${definition.display_name}`, `配置 ${definition.display_name}`))}</option>`).join("");
  const setupHelp = selectedKind === "ollama"
    ? tr(locale, "No API key is needed. Restork only connects to the local Ollama address saved here.", "无需 API Key。Restork 只会连接这里保存的本机 Ollama 地址。")
    : tr(locale, "The native prompt stores the key in system credentials. Saving it does not test the model or create a paid request.", "原生弹窗会把 Key 存入系统凭据库；保存时不会测试模型，也不会产生计费请求。")
  const reportMarkup = report && report.provider === selected?.profileId
    ? providerDiagnosticMarkup(report, locale)
    : `<p>${selected
      ? tr(locale, "This saved model has not been tested in this view yet.", "这个已保存模型尚未在当前页面测试。")
      : tr(locale, "Choose a provider, finish its local setup, then test the selected model.", "请选择供应商，完成本地配置后再测试所选模型。")}</p>`;
  return `<section class="provider-console" aria-labelledby="provider-title">
    <header>
      <div><p class="eyebrow">${tr(locale, "Model center · system credentials", "模型中心 · 系统凭据")}</p><h2 id="provider-title" data-provider-selected-name>${escapeHtml(selected?.displayName ?? tr(locale, "Choose a provider", "选择供应商"))}</h2><small data-provider-selected-model>${escapeHtml(selected ? `${selected.kind} / ${selectedModel}` : tr(locale, "No model saved", "尚未保存模型"))}</small></div>
      <span class="provider-status" data-provider-summary="${escapeHtml(status)}">${escapeHtml(status.replaceAll("_", " "))}</span>
    </header>
    <div class="provider-instructions">
      <label class="provider-picker" for="provider-profile-selector"><span>${tr(locale, "Provider and model", "供应商与模型")}</span><select id="provider-profile-selector" data-provider-selector>${configuredOptions ? `<optgroup label="${tr(locale, "Saved models", "已保存模型")}">${configuredOptions}</optgroup>` : ""}${availableOptions ? `<optgroup label="${tr(locale, "Add a provider", "添加供应商")}">${availableOptions}</optgroup>` : ""}</select></label>
      <button type="button" data-provider-overview-secret ${selectedKind === "ollama" ? "disabled" : ""}>${tr(locale, "SAVE API KEY SECURELY", "安全保存 API Key")}</button>
      <small data-provider-setup-help>${escapeHtml(setupHelp)}</small>
      <small data-provider-overview-secret-status>${selectedKind === "ollama" ? tr(locale, "Local Ollama needs no API key.", "本地 Ollama 无需 API Key。") : tr(locale, "The browser never receives it.", "浏览器永远不会接收到 Key。")}</small>
      <details class="source-build-fallback"><summary>${tr(locale, "Source-build command", "源码运行命令")}</summary><code data-provider-command>${escapeHtml(setupCommand)}</code></details>
    </div>
    <div class="provider-actions">
      <button type="button" data-provider-diagnostic="connect" ${selected ? "" : "disabled"}>${tr(locale, "CHECK ACCESS", "检查权限")}</button>
      <button type="button" class="quiet-button" data-provider-diagnostic="smoke" ${selected ? "" : "disabled"}>${tr(locale, "TEST MODEL", "测试模型")}</button>
      <button type="button" class="quiet-button manage-providers-button" data-open-provider-settings>${tr(locale, "MANAGE MODELS", "管理模型")}</button>
      <small>${tr(locale, "Access checks model discovery when supported. Test model sends one fixed public low-token sentence. Song research is started from the Daily track card only.", "权限检查会在供应商支持时读取模型列表；测试模型只发送固定的公开低 token 短句；歌曲联网分析只从“每日一曲”卡片发起。")}</small>
    </div>
    <div id="provider-diagnostic-result" class="provider-diagnostic-host" role="status" aria-live="polite">
      ${reportMarkup}
    </div>
  </section>`;
}

function overview(snapshot: DashboardSnapshot, locale: Locale): string {
  const run = snapshot.runs[0];
  const approval = snapshot.approvals.find((item) => item.decision === "pending");
  const tasks = snapshot.taskBoard.tasks.filter((task) => !task.completed).slice(0, 3);
  const runSummary = run
    ? runCard(run, locale)
    : emptyCard(
      tr(locale, "Runs", "运行"),
      tr(locale, "No runs yet. Choose Research or Work to begin.", "还没有运行。选择 Research 或 Work 开始。"),
      true,
    );
  const approvalSummary = approval
    ? approvalCardMarkup(approval, locale, true)
    : emptyCard(
      tr(locale, "Approvals", "审批"),
      tr(locale, "No actions are waiting for approval.", "没有待审批动作。"),
      true,
    );
  const taskRows = tasks.length
    ? tasks.map((task) => {
      const priority = escapeHtml(String(task.fields.priority ?? "P–"));
      const origin = task.origin === "vault"
        ? tr(locale, "Synced from Vault", "来自知识库同步")
        : task.origin === "model"
          ? tr(locale, "Accepted model suggestion", "已确认的模型建议")
          : tr(locale, "Added by you", "由你添加");
      return `<p class="task-row"><b>${priority}</b>${escapeHtml(cleanTaskText(task.text))}<small>${origin}</small></p>`;
    }).join("")
    : `<p class="empty">${tr(locale, "No incomplete tasks. Add one yourself or ask the model for suggestions.", "没有未完成任务；你可以自己添加，也可以让模型先给出建议。")}</p>`;
  const radarRows = snapshot.radar.items.slice(0, 4).map((item) => radarSummary(item, locale)).join("")
    || `<p class="empty">${snapshot.radar.configured
      ? tr(locale, "The next public refresh will appear here.", "下一次公开来源刷新后会显示在这里。")
      : tr(locale, "Choose public Radar sources to begin.", "选择公开 Radar 来源后开始。")}</p>`;
  return `<div class="board">
    ${runSummary}
    ${approvalSummary}
    <article class="paper-card dashboard-card"><header><h2>${tr(locale, "Tasks", "任务")}</h2><span class="ribbon work">${tr(locale, "YOUR LIST", "你的清单")}</span></header>
      <div class="dashboard-card-body">${taskRows}</div>
    </article>
    <article class="paper-card radar-summary dashboard-card"><header>
      <h2>${tr(locale, "Radar highlights", "雷达精选")}</h2>
      <button type="button" class="quiet-button" data-open-view="radar">${tr(locale, "View all", "查看全部")}</button>
    </header>
      <div class="dashboard-card-body">${radarRows}</div>
    </article>
  </div>`;
}

export function runsView(snapshot: DashboardSnapshot, locale: Locale): string {
  const runs = snapshot.runs;
  const page = snapshot.pagination?.runs;
  const notice = domainNotice(snapshot, "runs", locale);
  const chrome = runSubviewSwitch(locale, "runs");
  if (notice) {
    return `${chrome}<article class="paper-card full-card"><header><h2>${tr(locale, "Runs", "运行")}</h2></header>${notice}</article>`;
  }
  return `${chrome}<article class="paper-card full-card"><header><h2>${tr(locale, "Runs", "运行")}</h2><span class="ribbon research">CORE STATE</span></header>
    <div class="split-view"><div><div class="item-list">${runs.map((run) => `<button type="button" class="list-item" data-run-id="${escapeHtml(run.summary.run_id)}"><b>${escapeHtml(modeLabel(run.summary.mode, locale).toUpperCase())}</b><span>${escapeHtml(run.task?.goal ?? run.summary.task_id)}</span><small>${escapeHtml(runStateLabel(run.summary.state, locale))} · ${formatDate(run.summary.updated_at, locale)}</small></button>`).join("") || `<p class="empty">${tr(locale, "No runs yet. Start one from the home page.", "还没有运行。回开始页用一句话发起。")}</p>`}</div>${paginationControl("runs", page, locale)}</div><div id="run-detail" class="detail-placeholder">${tr(locale, "Select a run to inspect its activity.", "选择一个运行查看执行过程。")}</div></div>
  </article>`;
}

export function approvalsView(snapshot: DashboardSnapshot, locale: Locale): string {
  const approvals = snapshot.approvals;
  const page = snapshot.pagination?.approvals;
  const notice = domainNotice(snapshot, "approvals", locale);
  const chrome = runSubviewSwitch(locale, "approvals");
  if (notice) {
    return `${chrome}<article class="paper-card"><header><h2>${tr(locale, "Approvals", "审批")}</h2></header>${notice}</article>`;
  }
  const empty = emptyCard(
    tr(locale, "Approvals", "审批"),
    tr(locale, "No approval records.", "没有审批记录。"),
  );
  return `${chrome}<div class="stack"><div class="approval-list">
    ${approvals.map((approval) => approvalCardMarkup(approval, locale)).join("") || empty}
  </div>${paginationControl("approvals", page, locale)}</div>`;
}

export function tasksView(snapshot: DashboardSnapshot, locale: Locale): string {
  const notice = domainNotice(snapshot, "tasks", locale);
  if (notice && snapshot.domains?.tasks?.state !== "not_configured") {
    return `<article class="paper-card full-card"><header><h2>${tr(locale, "Tasks", "任务")}</h2></header>${notice}</article>`;
  }
  const localTasks = snapshot.taskBoard.tasks.filter(
    (task) => task.origin === "user" || task.origin === "model" || task.editable === true,
  );
  const vaultTasks = snapshot.taskBoard.tasks.filter((task) => !localTasks.includes(task));
  const deletedTasks = snapshot.taskBoard.deleted_tasks ?? [];
  return `<article class="paper-card full-card">
    <header><h2>${tr(locale, "Tasks", "任务")}</h2><span class="ribbon work">LOCAL · EDITABLE</span></header>
    ${notice ?? ""}
    <form id="local-todo-form" class="todo-create-form">
      <label>${tr(locale, "What needs doing?", "要做什么？")}<input name="title" required maxlength="2000" placeholder="${tr(locale, "For example: review the experiment results", "例如：复核实验结果")}"></label>
      <label>${tr(locale, "Priority", "优先级")}<select name="priority">
        <option value="">${tr(locale, "No priority", "不设优先级")}</option>
        <option>P0</option><option>P1</option><option>P2</option><option>P3</option>
      </select></label>
      <label>${tr(locale, "Due date", "截止日期")}<input name="due_date" type="date"></label>
      <label class="wide-label">${tr(locale, "Notes (optional)", "补充说明（可选）")}
        <textarea name="details" rows="2" maxlength="16000"
          placeholder="${tr(locale, "Add context in your own words", "用自然语言补充背景")}"></textarea>
      </label>
      <button type="submit">${tr(locale, "ADD TASK", "添加任务")}</button>
      <button type="button" class="quiet-button" data-todo-suggest>${tr(locale, "ASK MODEL IN CONVERSATION", "去对话中让模型建议")}</button>
      <p id="local-todo-status" role="status"></p>
    </form>
    <div class="todo-section-heading"><h3>${tr(locale, "My tasks", "我的任务")}</h3><span>${localTasks.length}</span></div>
    <div class="task-list todo-list">${localTasks.map((task) => localTodoMarkup(task, locale)).join("") || todoEmpty(locale)}</div>
    ${todoTrashMarkup(deletedTasks, snapshot.taskBoard.deleted_page, locale)}
    ${vaultTasksMarkup(snapshot, vaultTasks, locale)}
    ${paginationControl("tasks", snapshot.pagination?.tasks, locale)}
  </article>`;
}

function todoEmpty(locale: Locale): string {
  return `<p class="empty">${tr(locale, "Add a task yourself, or ask the model for suggestions.", "你可以自己添加，也可以让模型先给出建议。")}</p>`;
}

function todoTrashMarkup(tasks: MarkdownTask[], page: PageInfo | undefined, locale: Locale): string {
  const rows = tasks.map((task) => deletedTodoMarkup(task, locale)).join("");
  const empty = `<p class="empty">${tr(locale, "Nothing has been deleted.", "暂时没有已删除任务。")}</p>`;
  return `<details class="todo-trash">
    <summary>${tr(locale, `Recently deleted · ${tasks.length}`, `最近删除 · ${tasks.length}`)}</summary>
    <p class="fine">${tr(locale, "Deleted tasks stay on this device and can be restored.", "删除的任务仍保留在本机，可以随时恢复。")}</p>
    <div class="todo-trash-list">${rows || empty}</div>${deletedTodoPagination(page, locale)}
  </details>`;
}

function vaultTasksMarkup(snapshot: DashboardSnapshot, tasks: MarkdownTask[], locale: Locale): string {
  const empty = `<p class="empty">${tr(locale, "No tasks found in the granted Vault.", "已授权知识库中没有任务。")}</p>`;
  const disconnected = `<p class="empty">${tr(locale, "Connect an Obsidian Vault only if you want Markdown task sync.", "只有需要同步 Markdown 任务时才连接 Obsidian 知识库。")}</p>`;
  const vaultConfigured = snapshot.taskBoard.vault_configured ?? tasks.length > 0;
  const body = vaultConfigured ? `<form id="quick-task-form" class="quick-task-form">
      <label for="quick-task">${tr(locale, "Add to the Vault task file", "添加到知识库任务文件")}</label>
      <div><input id="quick-task" name="text" required maxlength="500" placeholder="${tr(locale, "One task to add", "写下准备添加的任务")}">
      <select name="priority" aria-label="${tr(locale, "Priority", "优先级")}"><option value="">P–</option><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select>
      <button type="submit">${tr(locale, "PREVIEW WRITE", "预览写入")}</button></div></form>
      <div class="task-list vault-task-list">${tasks.map((task) => vaultTodoMarkup(task, locale)).join("") || empty}</div>
      <p class="fine">${tr(locale, "Vault changes show a line-by-line diff and wait for your confirmation.", "知识库改动会先显示逐行差异，确认后才写入。")}</p>` : disconnected;
  return `<details class="vault-task-source"><summary>${tr(locale, `Obsidian / Markdown sync · ${tasks.length}`, `Obsidian / Markdown 同步 · ${tasks.length}`)}</summary>${body}</details>`;
}

function localTodoMarkup(task: MarkdownTask, locale: Locale): string {
  const priority = task.fields.priority || tr(locale, "No priority", "无优先级");
  const due = task.fields.due ? formatDate(task.fields.due, locale) : tr(locale, "No due date", "无截止日期");
  const origin = task.origin === "model" ? tr(locale, "Model suggestion · accepted", "模型建议 · 已确认") : tr(locale, "Added by you", "由你添加");
  const dateValue = typeof task.fields.due === "string" ? task.fields.due.slice(0, 10) : "";
  const priorityOptions = ["P0", "P1", "P2", "P3"]
    .map((value) => `<option ${task.fields.priority === value ? "selected" : ""}>${value}</option>`)
    .join("");
  return `<article class="todo-row ${task.completed ? "is-complete" : ""}">
    <label><input type="checkbox" data-local-todo-toggle data-task-id="${escapeHtml(task.task_id)}" data-task-updated="${escapeHtml(task.updated_at ?? "")}" ${task.completed ? "checked" : ""}>
    <span><strong>${escapeHtml(task.text)}</strong>${task.details ? `<p>${escapeHtml(task.details)}</p>` : ""}
    <small>${escapeHtml(String(priority))} · ${escapeHtml(due)} · ${escapeHtml(origin)}</small></span></label>
    <details><summary>${tr(locale, "Edit", "编辑")}</summary>
      <form data-local-todo-edit data-task-id="${escapeHtml(task.task_id)}" data-task-updated="${escapeHtml(task.updated_at ?? "")}" data-task-completed="${task.completed}">
        <label>${tr(locale, "Task", "任务")}<input name="title" required maxlength="2000" value="${escapeHtml(task.text)}"></label>
        <label>${tr(locale, "Notes", "说明")}<textarea name="details" rows="2" maxlength="16000">${escapeHtml(task.details ?? "")}</textarea></label>
        <label>${tr(locale, "Priority", "优先级")}<select name="priority"><option value="">${tr(locale, "None", "无")}</option>${priorityOptions}</select></label>
        <label>${tr(locale, "Due date", "截止日期")}<input name="due_date" type="date" value="${escapeHtml(dateValue)}"></label>
        <div class="record-actions"><button type="submit">${tr(locale, "SAVE", "保存")}</button>
        <button type="button" class="danger-text" data-local-todo-delete
          data-task-id="${escapeHtml(task.task_id)}" data-task-updated="${escapeHtml(task.updated_at ?? "")}">
          ${tr(locale, "MOVE TO DELETED", "移到最近删除")}</button></div>
      </form>
    </details>
  </article>`;
}

function deletedTodoMarkup(task: MarkdownTask, locale: Locale): string {
  const deletedAt = task.deleted_at ? formatDate(task.deleted_at, locale) : tr(locale, "Recently", "刚刚");
  return `<article class="todo-trash-row"><div><strong>${escapeHtml(task.text)}</strong>
    ${task.details ? `<p>${escapeHtml(task.details)}</p>` : ""}<small>${tr(locale, "Deleted", "已删除")} · ${escapeHtml(deletedAt)}</small></div>
    <button type="button" data-local-todo-restore data-task-id="${escapeHtml(task.task_id)}"
      data-task-updated="${escapeHtml(task.updated_at ?? "")}">${tr(locale, "RESTORE", "恢复")}</button></article>`;
}

function deletedTodoPagination(page: PageInfo | undefined, locale: Locale): string {
  if (!page?.has_more || !page.next_cursor) return "";
  return `<div class="pagination"><button type="button" data-deleted-todo-page="${escapeHtml(page.next_cursor)}">
    ${tr(locale, "LOAD MORE DELETED", "加载更多已删除任务")}</button>
    <small>${tr(locale, "Deleted tasks are loaded a page at a time.", "已删除任务会分批加载，不会一次读取全部。")}</small></div>`;
}

function vaultTodoMarkup(task: MarkdownTask, locale: Locale): string {
  const source = escapeHtml(task.relative_path ?? tr(locale, "Vault", "知识库"));
  const line = task.line_number ? ` · L${task.line_number}` : "";
  const due = escapeHtml(String(task.fields.due ?? tr(locale, "no due date", "无截止日期")));
  return `<label class="task-row ${task.completed ? "is-complete" : ""}">
    <input type="checkbox" data-task-id="${escapeHtml(task.task_id)}" ${task.completed ? "checked" : ""}>
    <span>${escapeHtml(cleanTaskText(task.text))}<small>${source}${line} · ${due}</small></span>
  </label>`;
}

export function radarView(snapshot: DashboardSnapshot, locale: Locale): string {
  const notice = domainNotice(snapshot, "radar", locale);
  const radarState = snapshot.domains?.radar?.state;
  if (notice && radarState !== "not_configured") {
    return `<article class="paper-card full-card"><header><h2>Radar</h2></header>${notice}</article>`;
  }
  const configForm = `<form id="radar-config-form" class="radar-config">
    <label class="radar-config-source"><input type="checkbox" name="github_discovery" value="1" checked> ${tr(locale, "Discover public AI, Agent and MCP projects on GitHub", "发现 GitHub 上公开的 AI、Agent 与 MCP 项目")}</label>
    <label class="radar-config-source"><input type="checkbox" name="hacker_news" value="1" checked> ${tr(locale, "Include Hacker News top stories", "收录 Hacker News 热门")}</label>
    <button type="submit">${tr(locale, "SAVE & FETCH", "保存并拉取")}</button>
    <small>${tr(locale, "GitHub discovery uses fixed public searches, engineering relevance ranking and a 30-minute cache. All fetching happens through the Core; the browser never goes online.", "GitHub 发现使用固定公开搜索、工程相关性排序和 30 分钟缓存。所有抓取都由 Core 完成；浏览器不会自行联网。")}</small>
    <p class="form-hint" id="radar-config-status" role="status"></p>
  </form>`;
  if (!snapshot.radar.configured) {
    return `<article class="paper-card full-card"><header><h2>Radar</h2><span class="ribbon radar">CORE CONNECTORS</span></header>
      <div class="radar-onboarding"><strong>${tr(locale, "Choose what Restork should watch", "选择 Restork 要关注的公开来源")}</strong><p>${tr(locale, "No account or GitHub username is needed. Restork searches public AI, Agent and MCP projects and can also include Hacker News. The Core fetches and caches them only after you opt in here.", "无需账号或 GitHub 用户名。Restork 会发现公开的 AI、Agent 与 MCP 项目，也可收录 Hacker News；只有你在这里明确启用后，Core 才会联网拉取并缓存。")}</p></div>
      ${configForm}
    </article>`;
  }
  const githubItems = snapshot.radar.items.filter((item) => item.lane === "trending");
  const hackerNewsItems = snapshot.radar.items.filter((item) => item.lane === "hn");
  return `<article class="paper-card full-card"><header><h2>Radar</h2><span class="ribbon radar">CORE CONNECTORS</span></header>
    <div id="research-result" class="research-result-host" role="status"></div>
    <div class="lanes"><section class="radar-github-lane"><h3>GitHub AI / Agent</h3>${radarGithubPeriods(githubItems, locale)}</section><section><h3>Hacker News</h3>${hackerNewsItems.map((item) => radarItem(item, locale)).join("") || `<p class="empty">${tr(locale, "No public stories in this refresh.", "本次刷新没有公开条目。")}</p>`}</section></div>${paginationControl("radar", snapshot.pagination?.radar, locale)}
    <details class="radar-recheck"><summary>${tr(locale, "Radar sources", "Radar 来源设置")}</summary>${configForm}</details>
  </article>`;
}

export function memoryView(snapshot: DashboardSnapshot, locale: Locale): string {
  const notice = domainNotice(snapshot, "memory", locale);
  const chrome = knowledgeSubviewSwitch(locale, "memory");
  if (notice) {
    return `${chrome}<article class="paper-card full-card"><header><h2>${tr(locale, "What Restork remembers", "Restork 记住的内容")}</h2></header>${notice}</article>`;
  }
  if (!snapshot.memory) {
    return chrome + emptyCard(
      tr(locale, "What Restork remembers", "Restork 记住的内容"),
      tr(locale, "Memory is not available yet.", "记忆功能尚未启用。"),
    );
  }
  const records = snapshot.memory.records.filter((record) => record.summary);
  return `${chrome}<article class="paper-card full-card"><header><h2>${tr(locale, "What Restork remembers", "Restork 记住的内容")}</h2><span class="ribbon study">LOCAL</span></header>
    <div class="memory-layers">${snapshot.memory.architecture.map((layer) => `<section><b>${escapeHtml(memoryLayerLabel(layer, locale))}</b><strong>${snapshot.memory?.counts[layer] ?? 0}</strong></section>`).join("")}</div>
    <div class="memory-list">${records.map((record) => memoryRow(record, locale)).join("") || `<p class="empty">${tr(locale, "Nothing has been saved here yet. Keep a useful answer and it will appear.", "这里还没有保存任何内容。留下一条有用的回答，就会出现在这里。")}</p>`}</div>${paginationControl("memory", snapshot.pagination?.memory, locale)}
    <p class="fine">${tr(locale, "Automatic cleanup removes only temporary or rebuildable data. Your notes, settings, approvals, and run history remain.", "自动清理只会移除临时或可以重新生成的数据；你的笔记、设置、审批和运行记录会保留下来。")}</p>
  </article>`;
}

function runCard(run: RunListEntry, locale: Locale): string {
  const usage = run.budget?.usage;
  const budget = run.budget?.budget;
  const tokenRatio = usage && budget?.max_tokens ? Math.min(100, (usage.tokens / budget.max_tokens) * 100) : 0;
  return `<article class="paper-card run-card dashboard-card"><header>
    <h2>${tr(locale, "Latest run", "最近运行")}</h2>
    <span class="ribbon ${escapeHtml(run.summary.mode)}">${escapeHtml(modeLabel(run.summary.mode, locale))}</span></header>
    <div class="dashboard-card-body"><p class="run-title">${escapeHtml(run.task?.goal ?? run.summary.task_id)}</p>
    <progress class="progress-native" aria-label="Token budget ${tokenRatio.toFixed(0)}%" max="100" value="${tokenRatio.toFixed(1)}">${tokenRatio.toFixed(0)}%</progress>
    <p class="fine">${escapeHtml(runStateLabel(run.summary.state, locale))} · ${usage?.tokens ?? 0} tokens · ${formatDate(run.summary.updated_at, locale)}</p></div>
  </article>`;
}

function dailyContext(snapshot: DashboardSnapshot, locale: Locale): string {
  const daily = snapshot.daily;
  const systemDaily = snapshot.workspaceV2?.dailyContext;
  const weather = daily?.weather;
  const calendar = daily?.calendar;
  const nativeCalendar = daily?.native_calendar;
  const music = daily?.music;
  const recommendation = music?.recommendation;
  const fallbackMusicSources: Array<Pick<MusicSourceDefinition, "provider" | "label" | "stability" | "setup_status" | "setup_command">> = [
    { provider: "qqmusic", label: "QQ Music", stability: "experimental", setup_status: "ready", setup_command: "" },
    { provider: "netease", label: "NetEase Cloud Music", stability: "experimental", setup_status: "ready", setup_command: "" },
    { provider: "apple-music", label: "Apple Music", stability: "official", setup_status: "credential_missing", setup_command: "restorkd music apple configure" },
  ];
  const musicSources = (snapshot.musicSources?.length ? snapshot.musicSources : fallbackMusicSources)
    .filter((source) => source.provider !== "local-file");
  const currentMusicProvider = music?.source?.provider && music?.source?.provider !== "local-file"
    ? music.source.provider
    : "qqmusic";
  const musicSourceOptions = musicSources.map((source) => `<option value="${escapeHtml(source.provider)}" data-status="${escapeHtml(source.setup_status)}" data-setup="${escapeHtml(source.setup_command)}" ${source.provider === currentMusicProvider ? "selected" : ""}>${escapeHtml(source.label)} · ${escapeHtml(source.stability)}${source.setup_status === "credential_missing" ? tr(locale, " · setup needed", " · 需要配置") : ""}</option>`).join("");
  const calendarDate = systemDaily?.local_date;
  const weekStart = snapshot.workspaceV2?.personal?.settings.week_start;
  return `<section class="daily-context" aria-label="${tr(locale, "Daily context", "每日上下文")}">
    <article class="daily-card clock-card">
      <header><h2>${tr(locale, "Local time", "本地时间")}</h2><span>LOCAL</span></header>
      <svg class="roman-clock" viewBox="0 0 100 100" role="img" aria-labelledby="clock-title clock-description">
        <title id="clock-title">${tr(locale, "Roman numeral local clock", "罗马数字本地时钟")}</title><desc id="clock-description">${tr(locale, "An analog clock marked I through XII.", "一个以 I 到 XII 标记的模拟时钟。")}</desc>
        <circle cx="50" cy="50" r="45"></circle><circle class="clock-rule" cx="50" cy="50" r="39"></circle>
        <g class="clock-numerals"><text x="50" y="14">XII</text><text x="70" y="19">I</text><text x="84" y="33">II</text><text x="89" y="53">III</text><text x="84" y="73">IV</text><text x="70" y="87">V</text><text x="50" y="92">VI</text><text x="30" y="87">VII</text><text x="16" y="73">VIII</text><text x="11" y="53">IX</text><text x="16" y="33">X</text><text x="30" y="19">XI</text></g>
        <line data-clock-hour class="clock-hand hour-hand" x1="50" y1="53" x2="50" y2="29"></line><line data-clock-minute class="clock-hand minute-hand" x1="50" y1="54" x2="50" y2="19"></line><line data-clock-second class="clock-hand second-hand" x1="50" y1="57" x2="50" y2="16"></line><circle class="clock-pin" cx="50" cy="50" r="2.5"></circle>
      </svg><time id="clock-text">${tr(locale, "Reading local time…", "读取本地时间…")}</time>
    </article>
    <article class="daily-card weather-card"><header><h2>${tr(locale, "Weather", "天气")}</h2><span>${escapeHtml(dailyStatusLabel(weather?.status ?? "offline", locale))}</span></header>
      ${weather?.configured && weather.temperature_c !== null ? `<strong class="weather-temperature">${weather.temperature_c.toFixed(1)}°</strong><p>${escapeHtml(weather.condition)} · ${tr(locale, "feels like", "体感")} ${weather.apparent_temperature_c?.toFixed(1) ?? "–"}°</p><small>${escapeHtml(weather.location_label)} · ${tr(locale, "humidity", "湿度")} ${weather.relative_humidity_percent ?? "–"}%</small><em>${escapeHtml(weather.attribution)}</em>` : `<p class="daily-empty">${escapeHtml(localeCompatibleMessage(weather?.message, locale) || tr(locale, "Weather is off. Enter a city, or allow one-time location access when you choose.", "天气尚未启用；可以手动填写城市，也可以在你需要时授权一次定位。"))}</p>`}
      <button type="button" class="settings-trigger" data-weather-open>${weather?.configured ? tr(locale, "CHANGE LOCATION", "修改位置") : tr(locale, "SET UP WEATHER", "设置天气")}</button>
      <dialog id="weather-settings-dialog" class="settings-dialog weather-settings" aria-labelledby="weather-settings-title">
        <form id="weather-form">
          <header><strong id="weather-settings-title">${tr(locale, "WEATHER & LOCATION", "天气与位置")}</strong><button type="button" class="dialog-close" data-settings-close aria-label="${tr(locale, "Close weather settings", "关闭天气设置")}">×</button></header>
          <p>${tr(locale, "Enter a city, or explicitly request browser location. IP location is never used.", "输入城市即可，或主动请求浏览器定位；Restork 永不使用 IP 定位。")}</p>
          <label for="weather-query">${tr(locale, "City or region", "城市或地区")}</label><input id="weather-query" name="query" minlength="2" maxlength="120" required autocomplete="address-level2" placeholder="${tr(locale, "Guangzhou, China", "广州")}">
          <div class="weather-actions"><button type="submit">${tr(locale, "SEARCH & ENABLE", "搜索并启用")}</button><button type="button" class="quiet-button" data-weather-locate>${tr(locale, "USE CURRENT LOCATION", "使用当前位置")}</button>${weather?.configured ? `<button type="button" class="quiet-button" data-weather-disable>${tr(locale, "DISABLE", "停用")}</button>` : ""}</div>
          <small>${tr(locale, "Location permission is requested only after you press the button. Saved coordinates stay on this device.", "只有点击按钮后才会请求定位权限；保存的坐标只留在这台设备上。")}</small>
        </form>
      </dialog>
    </article>
    <article class="daily-card calendar-card"><header><h2>${tr(locale, "Calendar", "日历")}</h2><span>${escapeHtml(dailyStatusLabel(calendar?.configured ? calendar.status : systemDaily ? "system" : "local", locale))}</span></header>
      ${calendarMonth(calendarDate, calendar?.events ?? [], weekStart, locale)}
      <button type="button" class="settings-trigger" data-calendar-open>${calendar?.configured ? tr(locale, "CALENDAR SETTINGS", "日历设置") : tr(locale, "CONNECT CALENDAR", "连接日历")}</button>
      <dialog id="calendar-settings-dialog" class="settings-dialog calendar-settings" aria-labelledby="calendar-settings-title">
        <form id="calendar-form">
          <header><strong id="calendar-settings-title">${tr(locale, "LOCAL CALENDAR", "本地日历")}</strong><button type="button" class="dialog-close" data-settings-close aria-label="${tr(locale, "Close calendar settings", "关闭日历设置")}">×</button></header>
          <p>${tr(locale, "The date and month already follow this device. Restork asks for system Calendar access only after you press Connect, reads at most 30 days, and never edits an event.", "日期和月份已自动跟随本设备。只有点击“连接”后 Restork 才会请求系统日历权限；仅读取最多 30 天，绝不修改事件。")}</p>
          <p class="fine">${escapeHtml(nativeCalendar?.message ?? tr(locale, "Native Calendar capability is being checked.", "正在检查原生日历能力。"))}</p>
          <label>${tr(locale, "Event detail", "事件详情")}<select name="native_detail_scope"><option value="busy_only">${tr(locale, "Busy time only (recommended)", "仅忙碌时间（推荐）")}</option><option value="titles">${tr(locale, "Include event titles", "包含事件标题")}</option></select></label>
          <div class="calendar-actions">${nativeCalendar?.available ? `<button type="button" data-native-calendar-connect>${tr(locale, "CONNECT SYSTEM CALENDAR", "连接系统日历")}</button>` : ""}${calendar?.configured ? `<button type="button" class="quiet-button" data-calendar-disable>${tr(locale, "DISCONNECT & CLEAR", "断开并清除")}</button>` : ""}</div>
          <details><summary>${tr(locale, "Use an ICS fallback instead", "改用 ICS 兼容回退")}</summary><label for="calendar-file">${tr(locale, "Optional ICS event file", "可选 ICS 事件文件")}<input id="calendar-file" name="calendar" type="file" accept=".ics,text/calendar"></label><button type="submit">${tr(locale, "IMPORT READ-ONLY SNAPSHOT", "导入只读快照")}</button></details>
          <small>${tr(locale, "Events use this device's clock and time zone. Native access and ICS import are both optional.", "事件使用本设备时钟与时区；原生访问和 ICS 导入均为可选。")}</small>
        </form>
      </dialog>
    </article>
    <article class="daily-card music-card"><header><h2>${tr(locale, "Daily track", "每日一曲")}</h2><span>${escapeHtml(music?.source?.provider ?? dailyStatusLabel(music?.status ?? "offline", locale))}</span></header>
      ${recommendation ? `<div class="music-layout"><div class="disc" data-music-disc><div class="disc-label"><span>RESTORK</span><img id="music-cover" alt="${escapeHtml(tr(locale, `${recommendation.title} cover`, `${recommendation.title} 封面`))}" hidden></div></div><div class="music-copy"><strong>${escapeHtml(recommendation.title)}</strong><p>${escapeHtml([recommendation.artist, recommendation.album].filter(Boolean).join(" · ") || tr(locale, "Private playlist", "私有歌单"))}</p><div class="music-track-actions"><button type="button" data-music-toggle aria-pressed="false">${tr(locale, "ROTATE CD", "转动唱片")}</button><button type="button" data-music-research aria-describedby="music-research-consent">${tr(locale, "RESEARCH ONLINE", "联网分析")}</button>${recommendation.source_url ? `${safeLink(recommendation.source_url, tr(locale, "TRACK SOURCE", "歌曲来源"), 'target="_blank" rel="noopener noreferrer"')}` : ""}</div><details class="music-research-panel"><summary>${tr(locale, "Research, sources and notes", "研究、来源与洞察")}</summary><small id="music-research-consent" class="music-research-consent" role="status">${tr(locale, "Uses the same API key with V4 Flash Web Search. Sends only this title, artist and album; a small API charge may apply.", "使用同一 API Key 调用 V4 Flash 联网检索；只发送当前歌名、歌手与专辑，可能产生少量 API 费用。")}</small>${musicRecommendationInsights(recommendation, music?.source?.provider ?? "", locale)}</details></div></div>` : `<p class="daily-empty">${escapeHtml(localeCompatibleMessage(music?.message, locale) || tr(locale, "Connect a supported music source or import a private JSON/CSV playlist.", "连接受支持的音乐来源，或导入私有 JSON/CSV 歌单。"))}</p>`}
      ${musicSourceSummary(music?.source, locale)}
      ${musicDiscoveries(music?.discoveries ?? [], locale)}
      <button type="button" class="settings-trigger" data-music-open>${music?.configured ? tr(locale, "MANAGE PLAYLIST", "管理歌单") : tr(locale, "CONNECT PLAYLIST", "连接歌单")}</button>
      <dialog id="music-settings-dialog" class="settings-dialog music-settings" aria-labelledby="music-settings-title">
        <form id="music-form">
          <header><strong id="music-settings-title">${tr(locale, "PRIVATE MUSIC SOURCE", "私有音乐来源")}</strong><button type="button" class="dialog-close" data-settings-close aria-label="${tr(locale, "Close playlist settings", "关闭歌单设置")}">×</button></header>
          <p>${tr(locale, "Choose a source, then paste one public playlist link. QQ Music and NetEase need no login or cookies; Apple Music uses an official API token kept in native credential storage.", "选择来源并粘贴一个公开歌单链接。QQ 音乐和网易云无需登录或 Cookie；Apple Music 使用只保存在系统凭据库中的官方 API token。")}</p>
          <label for="music-source">${tr(locale, "Music source", "音乐来源")}<select id="music-source" name="source">${musicSourceOptions}</select></label>
          <label for="music-share-url">${tr(locale, "Public playlist share link", "公开歌单分享链接")}<input id="music-share-url" name="share_url" type="url" inputmode="url" autocomplete="off" maxlength="2048" placeholder="https://…" required></label>
          <div class="music-actions"><button type="submit">${tr(locale, "CONNECT & SYNC", "连接并同步")}</button>${music?.source?.refresh_supported ? `<button type="button" class="quiet-button" data-music-refresh>${tr(locale, "REFRESH SNAPSHOT", "刷新快照")}</button>` : ""}${music?.configured ? `<button type="button" class="quiet-button" data-music-disable>${tr(locale, "DISCONNECT & DELETE", "断开并删除")}</button>` : ""}</div>
          <p class="music-sync-status" data-music-source-help>${tr(locale, "Experimental sources are read-only. Apple Music is official and needs `restorkd music apple configure` first.", "实验性来源均为只读。Apple Music 为官方接口，需要先运行 `restorkd music apple configure`。")}</p>
          <p class="music-sync-status" data-music-sync-status role="status">${tr(locale, "Nothing is sent until you press Connect. Account passwords, cookies, audio and lyrics are never accepted.", "只有点击“连接”后才会联网；Restork 永不接收账号密码、Cookie、音频或歌词。")}</p>
          <details><summary>${tr(locale, "Use a JSON/CSV file instead", "改用 JSON/CSV 文件")}</summary><label for="music-file">${tr(locale, "Playlist file", "歌单文件")}<input id="music-file" name="playlist" type="file" accept=".json,.csv,application/json,text/csv"></label><button type="button" data-music-file>${tr(locale, "IMPORT LOCAL FILE", "导入本地文件")}</button></details>
          <small>${tr(locale, "Refresh is manual and failure keeps the last valid private snapshot. Provider capabilities and stability are exposed by Core.", "仅手动刷新；失败时会保留上次有效的私有快照。来源能力与稳定性由 Core 明确展示。")}</small>
        </form>
      </dialog>
    </article>
  </section>`;
}

function calendarMonth(
  localDate: string | undefined,
  events: CalendarEvent[],
  weekStartSetting: string | undefined,
  locale: Locale,
): string {
  const selectedDate = parseLocalCalendarDate(localDate);
  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();
  const todayKey = calendarDateKey(selectedDate);
  const weekStart = weekStartSetting === "sunday"
    ? 0
    : weekStartSetting === "monday"
      ? 1
      : locale === "zh-CN" ? 0 : 1;
  const weekdayLabels = locale === "zh-CN"
    ? ["日", "一", "二", "三", "四", "五", "六"]
    : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const orderedWeekdays = Array.from(
    { length: 7 },
    (_, index) => weekdayLabels[(weekStart + index) % 7],
  );
  const leadingCells = (new Date(year, month, 1).getDay() - weekStart + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const eventsByDay = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = calendarEventDateKey(event);
    if (!key) continue;
    const dayEvents = eventsByDay.get(key) ?? [];
    dayEvents.push(event);
    eventsByDay.set(key, dayEvents);
  }
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = index - leadingCells + 1;
    if (day < 1 || day > daysInMonth) {
      return `<span class="calendar-day is-blank" aria-hidden="true"></span>`;
    }
    const date = new Date(year, month, day);
    const key = calendarDateKey(date);
    const eventCount = eventsByDay.get(key)?.length ?? 0;
    const dateLabel = new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(date);
    const eventLabel = eventCount
      ? plural(locale, eventCount, { one: "{n} event", other: "{n} events", zh: "{n} 个事件" })
      : tr(locale, "No events", "无事件");
    const classes = [
      "calendar-day",
      key === todayKey ? "is-today" : "",
      eventCount ? "has-events" : "",
    ].filter(Boolean).join(" ");
    return `<time class="${classes}" datetime="${key}"${key === todayKey ? ' aria-current="date"' : ""} aria-label="${escapeHtml(`${dateLabel}, ${eventLabel}`)}"><span>${day}</span>${eventCount ? `<i aria-hidden="true"></i>` : ""}</time>`;
  }).join("");
  const monthLabel = new Intl.DateTimeFormat(locale, { month: "long" }).format(selectedDate);
  const secondaryLabel = locale === "zh-CN"
    ? chineseCalendarDate(selectedDate)
    : new Intl.DateTimeFormat(locale, { weekday: "long" }).format(selectedDate);
  const upcoming = events
    .filter((event) => {
      const key = calendarEventDateKey(event);
      return key && key >= todayKey;
    })
    .sort((left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at))
    .slice(0, 2);
  return `<div class="calendar-month" aria-label="${escapeHtml(tr(locale, `${monthLabel} ${year} calendar`, `${year}年${monthLabel}月历`))}">
    <div class="calendar-month-heading"><strong>${escapeHtml(monthLabel)}</strong><span>${year}</span>${secondaryLabel ? `<em>${escapeHtml(secondaryLabel)}</em>` : ""}</div>
    <div class="calendar-weekdays" aria-hidden="true">${orderedWeekdays.map((day) => `<span>${day}</span>`).join("")}</div>
    <div class="calendar-month-grid">${cells}</div>
    <div class="calendar-agenda" aria-label="${tr(locale, "Upcoming calendar events", "近期日历事件")}">
      ${upcoming.map((event) => `<p><time datetime="${escapeHtml(event.starts_at)}">${escapeHtml(calendarAgendaTime(event, selectedDate, locale))}</time><span><b>${escapeHtml(event.title)}</b>${event.redacted ? `<small>${tr(locale, "PRIVATE / REDACTED", "私有 / 已脱敏")}</small>` : ""}</span></p>`).join("") || `<p class="calendar-agenda-empty"><span><b>${tr(locale, "The month follows this device", "月份已跟随本设备")}</b><small>${tr(locale, "Connecting events is optional.", "连接事件是可选项。")}</small></span></p>`}
    </div>
  </div>`;
}

function parseLocalCalendarDate(value: string | undefined): Date {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (
      date.getFullYear() === Number(match[1])
      && date.getMonth() === Number(match[2]) - 1
      && date.getDate() === Number(match[3])
    ) return date;
  }
  return new Date();
}

function calendarDateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function calendarEventDateKey(event: CalendarEvent): string {
  if (event.all_day && /^\d{4}-\d{2}-\d{2}/.test(event.starts_at)) {
    return event.starts_at.slice(0, 10);
  }
  const date = new Date(event.starts_at);
  return Number.isNaN(date.getTime()) ? "" : calendarDateKey(date);
}

function chineseCalendarDate(date: Date): string {
  try {
    const formatted = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
      month: "long",
      day: "numeric",
    }).format(date);
    return formatted.replace(/(\d+)日/, (_, day: string) => chineseLunarDay(Number(day)));
  } catch {
    return "";
  }
}

function chineseLunarDay(day: number): string {
  const digits = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (day <= 0 || day > 30) return String(day);
  if (day <= 10) return `初${day === 10 ? "十" : digits[day]}`;
  if (day < 20) return `十${digits[day - 10]}`;
  if (day === 20) return "二十";
  if (day < 30) return `廿${digits[day - 20]}`;
  return "三十";
}

function calendarAgendaTime(event: CalendarEvent, today: Date, locale: Locale): string {
  const eventDate = event.all_day && /^\d{4}-\d{2}-\d{2}/.test(event.starts_at)
    ? parseLocalCalendarDate(event.starts_at.slice(0, 10))
    : new Date(event.starts_at);
  if (Number.isNaN(eventDate.getTime())) return tr(locale, "Scheduled", "已安排");
  const sameDay = calendarEventDateKey(event) === calendarDateKey(today);
  if (event.all_day) {
    return sameDay
      ? tr(locale, "All day", "全天")
      : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(eventDate);
  }
  return new Intl.DateTimeFormat(locale, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(eventDate);
}

function musicRecommendationInsights(
  recommendation: NonNullable<NonNullable<DashboardSnapshot["daily"]>["music"]["recommendation"]>,
  provider: string,
  locale: Locale,
): string {
  const research = recommendation.research;
  const reason = tr(
    locale,
    "Selected from your private playlist with a stable daily rotation, so the same day can be replayed and explained.",
    "来自你的私有歌单，并通过稳定的每日轮换选中，因此同一天的结果可以复现和解释。",
  );
  const facts = [
    recommendation.published_on ? tr(locale, `released ${musicDate(recommendation.published_on, locale)}`, `发行于 ${musicDate(recommendation.published_on, locale)}`) : "",
    recommendation.language ? tr(locale, `language ${recommendation.language}`, `语种 ${recommendation.language}`) : "",
    recommendation.genre ? tr(locale, `genre ${recommendation.genre}`, `流派 ${recommendation.genre}`) : "",
  ].filter(Boolean).join(tr(locale, "; ", "；"));
  const legacyAnalysis = localeCompatibleMusicText(recommendation.song_analysis, locale);
  const legacyPopularity = localeCompatibleMusicText(recommendation.popularity_reason, locale);
  const analysis = (research
    ? (locale === "zh-CN" ? research.song_analysis_zh_cn : research.song_analysis_en)
    : "") || facts || legacyAnalysis || tr(
    locale,
    "No reviewed song-detail evidence is cached yet. Choose Research online to investigate today's track.",
    "尚未缓存经过核验的歌曲资料；可点击“联网分析”研究今日歌曲。",
  );
  const popularity = (research
    ? (locale === "zh-CN" ? research.popularity_reason_zh_cn : research.popularity_reason_en)
    : "") || legacyPopularity || (provider === "qqmusic"
    ? tr(locale, "No current chart evidence was recorded for this track, so Restork will not invent a reason for its popularity.", "本次没有记录到这首歌的当前榜单证据，因此 Restork 不会编造它走红的原因。")
    : tr(locale, "Popularity evidence is available after an explicit online research pass.", "主动执行一次联网分析后，才会显示热度证据。"));
  return `<dl class="music-insights"><div><dt>${tr(locale, "WHY TODAY", "为什么推荐")}</dt><dd>${escapeHtml(reason)}</dd></div><div><dt>${tr(locale, "SONG NOTES", "歌曲解读")}</dt><dd>${escapeHtml(analysis)}</dd></div><div><dt>${tr(locale, "WHY IT IS HOT", "为什么火")}</dt><dd>${escapeHtml(popularity)}</dd></div></dl>${musicResearchSources(research, locale)}`;
}

function localeCompatibleMusicText(value: string | null | undefined, locale: Locale): string {
  return localeCompatibleMessage(value, locale);
}

function localeCompatibleMessage(value: string | null | undefined, locale: Locale): string {
  const text = value?.trim() ?? "";
  if (!text) return "";
  if (locale === "zh-CN") {
    return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(text) ? text : "";
  }
  return /[A-Za-z]{2}/u.test(text) ? text : "";
}

function dailyStatusLabel(status: string, locale: Locale): string {
  const labels: Record<string, readonly [string, string]> = {
    not_configured: ["off", "未启用"],
    offline: ["offline", "离线"],
    ready: ["ready", "就绪"],
    fresh: ["fresh", "最新"],
    stale: ["stale", "已过期"],
    error: ["error", "异常"],
    system: ["device", "本机"],
    local: ["local", "本地"],
  };
  const label = labels[status];
  return label ? tr(locale, label[0], label[1]) : status;
}

function musicResearchSources(
  research: MusicResearchSummary | null | undefined,
  locale: Locale,
): string {
  if (!research?.sources.length) return "";
  const status = research.status === "stale"
    ? tr(locale, "STALE CACHE", "缓存已过期")
    : research.status.toUpperCase();
  return `<details class="music-research-sources"><summary>${tr(locale, `WEB EVIDENCE · ${research.sources.length} SOURCES`, `联网证据 · ${research.sources.length} 个来源`)}</summary><div><small>${escapeHtml(research.model)} · ${escapeHtml(status)} · ${escapeHtml(musicDate(research.researched_at, locale))}</small>${research.sources.map((source, index) => `${safeAnchor(source.url, `<b>${index + 1}</b><span>${escapeHtml(source.title)}</span><em>${escapeHtml(source.publisher || tr(locale, "public source", "公开来源"))}</em>`, 'target="_blank" rel="noopener noreferrer"')}`).join("")}</div></details>`;
}

function musicSourceSummary(
  source: NonNullable<DashboardSnapshot["daily"]>["music"]["source"] | undefined,
  locale: Locale,
): string {
  if (!source) return "";
  const synced = source.synced_at ? musicDate(source.synced_at, locale) : tr(locale, "local", "本地");
  return `<p class="music-source-summary"><b>${escapeHtml(source.label || source.provider)}</b><span>${source.item_count} ${tr(locale, "tracks", "首")} · ${tr(locale, "synced", "同步于")} ${escapeHtml(synced)}</span>${source.experimental ? `<em>${tr(locale, "EXPERIMENTAL · READ ONLY", "实验性 · 只读")}</em>` : ""}</p>`;
}

function musicDiscoveries(discoveries: MusicDiscovery[], locale: Locale): string {
  if (!discoveries.length) return "";
  return `<details class="music-discoveries"><summary>${tr(locale, `Connected discoveries (${discoveries.length})`, `联网发现（${discoveries.length}）`)}</summary><div>${discoveries.map((item) => {
    const affinity = item.affinity_count > 0
      ? tr(locale, `Your playlist contains ${item.affinity_count} track(s) by ${item.affinity_artist}; this recommendation stays close to that preference.`, `你的歌单收录了 ${item.affinity_artist} 的 ${item.affinity_count} 首作品，这次推荐与已有偏好相连。`)
      : tr(locale, "A current Cantonese chart entry that expands beyond the artists already in your playlist.", "一首当前上榜的粤语歌，用来扩展你现有歌手圈之外的发现。")
    const facts = [item.published_on ? tr(locale, `released ${musicDate(item.published_on, locale)}`, `发行于 ${musicDate(item.published_on, locale)}`) : "", item.language, item.genre, item.label].filter(Boolean).join(tr(locale, " · ", " · "));
    const popularity = tr(locale, `#${item.chart_rank} on ${item.chart_name}${item.chart_updated_on ? ` · updated ${musicDate(item.chart_updated_on, locale)}` : ""}.`, `${item.chart_name}第 ${item.chart_rank} 位${item.chart_updated_on ? ` · 更新于 ${musicDate(item.chart_updated_on, locale)}` : ""}。`);
    const song = facts || localeCompatibleMusicText(item.song_analysis, locale) || tr(
      locale,
      "No reviewed song details are available yet.",
      "暂时没有经过核验的歌曲资料。",
    );
    return `<article><header><b>#${item.chart_rank} ${escapeHtml(item.title)}</b>${safeLink(item.source_url, tr(locale, "SOURCE", "来源"), 'target="_blank" rel="noopener noreferrer"')}</header><p>${escapeHtml(item.artist)}${item.album ? ` · ${escapeHtml(item.album)}` : ""}</p><small><b>${tr(locale, "For you:", "推荐给你：")}</b> ${escapeHtml(affinity)}</small><small><b>${tr(locale, "Song:", "歌曲：")}</b> ${escapeHtml(song)}</small><small><b>${tr(locale, "Evidence:", "热度证据：")}</b> ${escapeHtml(popularity)}</small></article>`;
  }).join("")}</div></details>`;
}

function radarGithubPeriods(items: RadarItem[], locale: Locale): string {
  if (!items.length) return `<p class="empty">${tr(locale, "No public repositories in this refresh.", "本次刷新没有公开项目。")}</p>`;
  const daily = [...items].sort((left, right) => radarGrowth(right.stars_daily) - radarGrowth(left.stars_daily) || radarGrowth(right.stars_total) - radarGrowth(left.stars_total));
  const weekly = [...items].sort((left, right) => radarGrowth(right.stars_weekly) - radarGrowth(left.stars_weekly) || radarGrowth(right.stars_total) - radarGrowth(left.stars_total));
  return `<div class="radar-periods">
    <input id="radar-period-daily" name="radar-period" type="radio" checked><label for="radar-period-daily">${tr(locale, "DAILY · 24H", "每日 · 24 小时")}</label>
    <input id="radar-period-weekly" name="radar-period" type="radio"><label for="radar-period-weekly">${tr(locale, "WEEKLY · 7D", "每周 · 7 天")}</label>
    <div class="radar-period-panel is-daily"><p class="radar-baseline-note">${tr(locale, "Ranked by verified 24-hour Star growth. A first sync creates the local baseline.", "按真实 24 小时 Star 增长排序；第一次同步会先建立本地基线。")}</p>${daily.map((item) => radarItem(item, locale, "daily")).join("")}</div>
    <div class="radar-period-panel is-weekly"><p class="radar-baseline-note">${tr(locale, "Ranked by verified 7-day Star growth from daily public snapshots.", "根据每日公开快照，按真实 7 天 Star 增长排序。")}</p>${weekly.map((item) => radarItem(item, locale, "weekly")).join("")}</div>
  </div>`;
}

function radarGrowth(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function formatRadarStars(value: number | null | undefined, locale: Locale): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat(locale === "zh-CN" ? "zh-CN" : "en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)
    : "—";
}

function radarDelta(value: number | null | undefined, period: "daily" | "weekly", locale: Locale): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return tr(locale, `${period === "daily" ? "24h" : "7d"} baseline pending`, `${period === "daily" ? "24 小时" : "7 天"}基线待建立`);
  }
  const sign = value > 0 ? "+" : "";
  return `${period === "daily" ? "24h" : "7d"} ${sign}${formatRadarStars(value, locale)}`;
}

function radarItem(item: RadarItem, locale: Locale, emphasis?: "daily" | "weekly"): string {
  const metrics = item.lane === "trending" ? `<div class="radar-star-metrics"><span class="is-total">★ ${formatRadarStars(item.stars_total, locale)}</span><span class="${emphasis === "daily" ? "is-emphasis" : ""}">${escapeHtml(radarDelta(item.stars_daily, "daily", locale))}</span><span class="${emphasis === "weekly" ? "is-emphasis" : ""}">${escapeHtml(radarDelta(item.stars_weekly, "weekly", locale))}</span></div>` : "";
  return `<article class="radar-item">${safeLink(item.url, item.title, 'target="_blank" rel="noreferrer"')}${metrics}<p>${escapeHtml(item.summary)}</p><small>${escapeHtml(item.source)} · ${escapeHtml(item.state)}</small><div class="radar-item-actions"><button type="button" data-radar-id="${escapeHtml(item.item_id)}" data-radar-action="research">${tr(locale, "research", "研究")}</button><button type="button" data-radar-id="${escapeHtml(item.item_id)}" data-radar-action="read_later">${tr(locale, "read later", "稍后阅读")}</button><button type="button" data-radar-id="${escapeHtml(item.item_id)}" data-radar-action="make_task">${tr(locale, "make task", "建任务")}</button><button type="button" data-radar-id="${escapeHtml(item.item_id)}" data-radar-action="dismiss">${tr(locale, "dismiss", "忽略")}</button></div></article>`;
}

function radarSummary(item: RadarItem, locale: Locale): string {
  const growth = item.lane === "trending"
    ? `★ ${formatRadarStars(item.stars_total, locale)} · ${radarDelta(item.stars_daily, "daily", locale)} · ${radarDelta(item.stars_weekly, "weekly", locale)}`
    : item.source;
  return `<p class="radar-row"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.summary)}</span><small>${escapeHtml(growth)}</small></p>`;
}

function memoryLayerLabel(layer: string, locale: Locale): string {
  const labels: Record<MemoryRecord["layer"], [string, string]> = {
    working: ["Current conversation", "当前对话"],
    episodic: ["Run history", "运行记录"],
    semantic: ["Your notes", "你的笔记"],
    profile: ["Your settings", "你的设置"],
  };
  const label = labels[layer as MemoryRecord["layer"]];
  return label ? tr(locale, label[0], label[1]) : layer.replaceAll("_", " ");
}

function memoryKindLabel(kind: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    decision: ["Decision", "决定"],
    preference: ["Preference", "偏好"],
    summary: ["Summary", "摘要"],
    run_summary: ["Run summary", "运行摘要"],
    fact: ["Note", "记录"],
  };
  const label = labels[kind];
  if (label) return tr(locale, label[0], label[1]);
  return kind.replaceAll("_", " ");
}

function memoryRetentionLabel(retention: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    transient: ["Cleared after use", "用完即清"],
    cache: ["Rebuilt when needed", "需要时可重新生成"],
    session: ["Kept for this conversation", "本次对话保留"],
    durable: ["Kept until you remove it", "保留到你删除为止"],
    protected: ["Kept with your records", "随你的记录保留"],
  };
  const label = labels[retention];
  return label ? tr(locale, label[0], label[1]) : retention.replaceAll("_", " ");
}

function memoryProvenanceLabel(provenance: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    user: ["Saved by you", "由你保存"],
    run: ["Saved from a run", "来自一次运行"],
    source: ["Saved from a source", "来自一份资料"],
    system: ["Saved by Restork", "由 Restork 保存"],
  };
  const label = labels[provenance];
  return label ? tr(locale, label[0], label[1]) : provenance.replaceAll("_", " ");
}

function memoryRow(record: MemoryRecord, locale: Locale): string {
  return `<article><b>${escapeHtml(memoryLayerLabel(record.layer, locale))} · ${escapeHtml(memoryKindLabel(record.kind, locale))}</b><p>${escapeHtml(record.summary)}</p><small>${escapeHtml(memoryRetentionLabel(record.retention_class, locale))} · ${escapeHtml(memoryProvenanceLabel(record.provenance, locale))} · ${formatDate(record.updated_at, locale)}</small></article>`;
}

function paginationControl(
  kind: string,
  page: PageInfo | undefined,
  locale: Locale,
  label = tr(locale, "LOAD MORE", "加载更多"),
): string {
  if (!page?.has_more || !page.next_cursor) return "";
  return `<div class="pagination"><button type="button" data-page-kind="${escapeHtml(kind)}" data-page-cursor="${escapeHtml(page.next_cursor)}">${escapeHtml(label)}</button><small>${tr(locale, "Core loads one page at a time.", "Core 会分批加载，不会一次读取全部列表。")}</small></div>`;
}

interface ResearchEnvelope {
  answer: string;
  claims: { statement: string; kind: string; evidenceRefs: string[] }[];
  conflicts: string[];
  unresolvedQuestions: string[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** The research contract ends in one JSON object; anything else stays raw. */
function parseResearchEnvelope(output: string): ResearchEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value == null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.answer !== "string" || !record.answer.trim()) return null;
  const claims = (Array.isArray(record.claims) ? record.claims : []).flatMap((claim) => {
    if (typeof claim !== "object" || claim == null) return [];
    const entry = claim as Record<string, unknown>;
    if (typeof entry.statement !== "string") return [];
    return [{
      statement: entry.statement,
      kind: typeof entry.kind === "string" ? entry.kind : "",
      evidenceRefs: stringList(entry.evidence_refs),
    }];
  });
  return {
    answer: record.answer,
    claims,
    conflicts: stringList(record.conflicts),
    unresolvedQuestions: stringList(record.unresolved_questions),
  };
}

function envelopeList(title: string, items: string[]): string {
  if (!items.length) return "";
  const rows = items
    .slice(0, 8)
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  return `<h4>${escapeHtml(title)}</h4><ul>${rows}</ul>`;
}

/**
 * The assistant stream box. While a run streams, the raw text accumulates in a
 * plain pre; once the research JSON envelope is complete it is upgraded to a
 * readable answer with the raw payload tucked behind a disclosure.
 */
export function assistantStreamMarkup(output: string, locale: Locale = "en"): string {
  const envelope = parseResearchEnvelope(output);
  if (!envelope) return `<pre data-assistant-stream>${escapeHtml(output)}</pre>`;
  const claims = envelope.claims.slice(0, 12).map((claim) => {
    const refs = claim.evidenceRefs.slice(0, 4).join(" · ");
    const kind = claim.kind ? ` <b>${escapeHtml(claim.kind)}</b>` : "";
    const source = refs ? `<small>${escapeHtml(refs)}</small>` : "";
    return `<li>${escapeHtml(claim.statement)}${kind}${source}</li>`;
  }).join("");
  const claimsSection = claims
    ? `<h4>${tr(locale, "Claims", "关键论断")}</h4><ul>${claims}</ul>`
    : "";
  const conflicts = envelopeList(tr(locale, "Conflicts", "冲突"), envelope.conflicts);
  const open = envelopeList(
    tr(locale, "Unresolved questions", "未解问题"),
    envelope.unresolvedQuestions,
  );
  return `<div class="assistant-answer" data-assistant-stream><p>${escapeHtml(envelope.answer)}</p>`
    + `${claimsSection}${conflicts}${open}`
    + `<details><summary>JSON</summary><pre>${escapeHtml(output)}</pre></details></div>`;
}

/**
 * One event row. Exported so a live stream can append a single row instead of
 * re-serialising the whole run, which is quadratic in event count.
 *
 * The row leads with a human-readable summary; the raw payload stays one click
 * away in a collapsed details block so the stream remains auditable.
 */
export function eventRow(event: RunEvent, locale: Locale = "en"): string {
  const id = escapeHtml(String(event.id));
  const type = escapeHtml(eventLabel(event.type, locale));
  const summary = eventSummary(event, locale);
  const raw = escapeHtml(JSON.stringify(event.data));
  return `<li data-event-id="${id}"><b>${type}</b><span>#${event.id}</span>`
    + `<div class="event-detail"><p>${summary}</p>`
    + `<details><summary>${tr(locale, "Technical details", "技术详情")}</summary><small>${escapeHtml(event.type)}</small><code>${raw}</code></details></div></li>`;
}

function modeLabel(mode: string, locale: Locale): string {
  if (mode === "research") return tr(locale, "Research", "研究");
  if (mode === "study") return tr(locale, "Study", "学习");
  if (mode === "work") return tr(locale, "Work", "工作");
  return mode;
}

function runStateLabel(state: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    proposed: ["Ready to start", "等待开始"], queued: ["Queued", "排队中"],
    running: ["Running", "进行中"], succeeded: ["Completed", "已完成"],
    completed: ["Completed", "已完成"], failed: ["Needs attention", "需要处理"],
    blocked: ["Blocked", "受阻"], cancelled: ["Cancelled", "已取消"],
    canceled: ["Cancelled", "已取消"],
  };
  const label = labels[state];
  return label ? tr(locale, label[0], label[1]) : state.replaceAll("_", " ");
}

function eventLabel(type: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    "run.created": ["Run created", "已创建运行"],
    "run.started": ["Run started", "运行已开始"],
    "run.cancelled": ["Run cancelled", "运行已取消"],
    "run.completed": ["Run completed", "运行已完成"],
    "run.stopped": ["Run stopped", "运行已停止"],
    "run.runtime_failed": ["Run needs attention", "运行需要处理"],
    "model.started": ["Model started", "模型开始处理"],
    "model.completed": ["Model completed", "模型处理完成"],
    "tool.completed": ["Tool completed", "工具执行完成"],
    "tool.failed": ["Tool failed", "工具执行失败"],
    "approval.requested": ["Waiting for approval", "等待审批"],
    "retry.scheduled": ["Retry scheduled", "已安排重试"],
    "context.compacted": ["Context organized", "上下文已整理"],
  };
  const label = labels[type];
  return label ? tr(locale, label[0], label[1]) : type.replaceAll(".", " ").replaceAll("_", " ");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function esc(value: unknown): string {
  return escapeHtml(text(value));
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clipped(value: string, max = 160): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function costLabel(micros: number | null): string {
  return micros == null ? "" : ` · $${(micros / 1_000_000).toFixed(4)}`;
}

/** Count hint for common tool-result shapes ({items|results|notes|hits: []}). */
function resultCount(result: unknown): number | null {
  if (typeof result !== "object" || result == null) return null;
  for (const key of ["items", "results", "notes", "hits"]) {
    const list = (result as Record<string, unknown>)[key];
    if (Array.isArray(list)) return list.length;
  }
  return null;
}

function toolNameList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string").map(escapeHtml)
    : [];
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value != null ? (value as Record<string, unknown>) : {};
}

function eventSummary(event: RunEvent, locale: Locale): string {
  const data = event.data;
  switch (event.type) {
    case "run.created": {
      const mode = esc(data.mode) || "run";
      const provider = esc(data.provider_profile_id) || tr(locale, "default", "默认");
      return tr(locale, `Created · ${mode} · provider ${provider}`, `已创建 · ${mode} · 提供商 ${provider}`);
    }
    case "run.started":
      return tr(locale, "Run started.", "运行已开始。");
    case "model.started": {
      const iteration = num(data.iteration) ?? "?";
      return tr(locale, `Model call · iteration ${iteration}`, `模型调用 · 第 ${iteration} 轮`);
    }
    case "model.completed": {
      const iteration = num(data.iteration) ?? "?";
      const tools = toolNameList(data.tool_calls);
      const tokens = num(data.total_tokens);
      const base = tr(locale, `Iteration ${iteration} done`, `第 ${iteration} 轮完成`);
      const usage = tokens == null ? "" : ` · ${tokens.toLocaleString()} tokens`;
      const calls = tools.length
        ? tr(locale, ` · tools: ${tools.join(", ")}`, ` · 工具：${tools.join("、")}`)
        : "";
      return `${base}${usage}${costLabel(num(data.cost_usd_micros))}${calls}`;
    }
    case "tool.completed": {
      const count = resultCount(recordOf(data.observation).result);
      const tool = esc(data.tool) || "tool";
      const hint = count == null ? "" : tr(locale, ` · ${count} result(s)`, ` · ${count} 条结果`);
      return tr(locale, `Tool ok · ${tool}${hint}`, `工具成功 · ${tool}${hint}`);
    }
    case "tool.failed": {
      const failure = recordOf(recordOf(data.observation).error);
      const tool = esc(data.tool) || "tool";
      const kind = esc(failure.kind) || "error";
      const message = escapeHtml(clipped(text(failure.message)));
      const detail = message ? ` · ${message}` : "";
      return tr(locale, `Tool failed · ${tool} · ${kind}${detail}`, `工具失败 · ${tool} · ${kind}${detail}`);
    }
    case "approval.requested": {
      const tool = esc(data.tool) || tr(locale, "tool", "工具");
      return tr(locale, `Approval required · ${tool}`, `等待审批 · ${tool}`);
    }
    case "retry.scheduled": {
      const attempt = num(data.attempt) ?? "?";
      const kind = esc(data.kind) || "provider";
      const status = data.status == null ? "" : ` · HTTP ${num(data.status) ?? esc(data.status)}`;
      return tr(locale, `Retry ${attempt} · ${kind}${status}`, `第 ${attempt} 次重试 · ${kind}${status}`);
    }
    case "context.compacted": {
      const removed = num(data.removed_messages) ?? "?";
      return tr(
        locale,
        `Context compacted · merged ${removed} earlier messages`,
        `上下文压缩 · 合并了 ${removed} 条早期消息`,
      );
    }
    case "run.completed": {
      const iterations = num(data.iterations) ?? "?";
      const tokens = num(data.total_tokens);
      const usage = tokens == null ? "" : ` · ${tokens.toLocaleString()} tokens`;
      return tr(locale, `Completed · ${iterations} iteration(s)${usage}`, `运行完成 · 共 ${iterations} 轮${usage}`);
    }
    case "run.stopped": {
      const reason = esc(data.stop_reason) || tr(locale, "unknown reason", "未知原因");
      return tr(locale, `Stopped · ${reason}`, `运行停止 · ${reason}`);
    }
    case "run.cancelled":
      return tr(locale, "Cancelled before start.", "运行已在启动前取消。");
    case "run.runtime_failed":
      return tr(locale, "Runtime error · the run can be retried.", "运行时错误 · 运行可重试。");
    case "run.snapshot":
      return tr(locale, "State snapshot.", "状态快照。");
    default:
      return escapeHtml(event.type);
  }
}

function metric(kind: string, label: string, value: string, note: string): string {
  return `<article class="metric ${kind}"><small>${label}</small><strong>${value}</strong><span>${escapeHtml(note)}</span></article>`;
}

function emptyCard(title: string, copy: string, dashboardCard = false): string {
  const body = `<p class="empty">${escapeHtml(copy)}</p>`;
  const content = dashboardCard ? `<div class="dashboard-card-body">${body}</div>` : body;
  return `<article class="paper-card${dashboardCard ? " dashboard-card" : ""}">
    <header><h2>${escapeHtml(title)}</h2></header>${content}</article>`;
}

/**
 * Render why a domain has no data. "You have no runs yet" and "Core did not
 * answer" are different facts and MUST NOT share a surface.
 *
 * Returns an empty string for `ready`, letting the caller render real content.
 */
export function domainNotice(
  snapshot: DashboardSnapshot,
  key: DomainKey,
  locale: Locale,
): string {
  const status = snapshot.domains?.[key];
  if (!status || status.state === "ready") return "";

  const copy: Record<Exclude<DomainState, "ready">, [string, string]> = {
    not_configured: [
      "The connected Core does not provide this yet.",
      "已连接的 Core 尚未提供此功能。",
    ],
    unavailable: [
      "Core did not answer. This is not an empty workspace.",
      "Core 没有响应。这不是空工作区。",
    ],
    forbidden: [
      "This session is not authorised for this data.",
      "当前会话无权访问这部分数据。",
    ],
  };
  const [english, chinese] = copy[status.state];
  const role = status.state === "unavailable" ? "alert" : "status";
  // Core's own detail is shown verbatim; nothing here is synthesised.
  const detail = status.detail
    ? `<small class="domain-notice-detail">${escapeHtml(status.detail)}</small>`
    : "";
  return `<p class="domain-notice domain-notice-${status.state}" role="${role}">`
    + `${escapeHtml(tr(locale, english, chinese))}${detail}</p>`;
}

function modeCounts(runs: RunListEntry[], locale: Locale): string {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.summary.mode, (counts.get(run.summary.mode) ?? 0) + 1);
  return [...counts].map(([mode, count]) => `${mode} ×${count}`).join(" · ")
    || tr(locale, "Waiting for a new task", "等待新任务");
}

function cleanTaskText(value: string): string {
  return value.replace(/\s+#todo\b/, "").replace(/\s+\[[a-z]+:: [^\]]+\]/g, "").replace(/\s+\^restork-[a-z0-9]+$/, "").trim();
}

function isTerminal(state: string): boolean {
  return ["completed", "failed", "cancelled"].includes(state);
}

function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? tr(locale, "unknown", "未知")
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function musicDate(value: string, locale: Locale): string {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? tr(locale, "unknown", "未知")
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function localeSwitch(locale: Locale): string {
  const target = alternateLocale(locale);
  const label = target === "zh-CN" ? "中文" : "EN";
  const accessible = tr(locale, "Switch to Chinese", "切换到英文");
  return `<button class="locale-switch" type="button" data-locale-switch="${target}" lang="${target}" aria-label="${accessible}">${label}</button>`;
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function measuredPercent(value: number | null, locale: Locale): string {
  return value == null ? tr(locale, "NOT MEASURED", "未测量") : percent(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

/**
 * Tool output, connector output, and Radar feeds are untrusted data. `escapeHtml`
 * escapes `& < > ' "`, none of which appear in `javascript:alert(1)`, so escaping
 * alone does not make a value safe to place in `href`.
 *
 * Returns null for anything outside the allowlist; callers MUST then render the
 * value as inert text rather than a link.
 */
export function safeHref(value: string | null | undefined): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol === "https:") return parsed.toString();
  // Plain HTTP is permitted only for the local Core, never for remote content.
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (parsed.protocol === "http:" && loopback.has(parsed.hostname)) return parsed.toString();
  return null;
}

/**
 * Renders an anchor when the URL is safe and inert text when it is not, so a
 * rejected URL is still visible to the user instead of silently disappearing.
 */
export function safeLink(
  value: string | null | undefined,
  label: string,
  attributes = "",
): string {
  return safeAnchor(value, escapeHtml(label), attributes);
}

/** As `safeLink`, but `innerHtml` is already escaped by the caller. */
export function safeAnchor(
  value: string | null | undefined,
  innerHtml: string,
  attributes = "",
): string {
  const href = safeHref(value);
  if (href === null) {
    return `<span class="unsafe-link" title="${escapeHtml(String(value ?? ""))}">${innerHtml}</span>`;
  }
  return `<a href="${escapeHtml(href)}"${attributes ? ` ${attributes}` : ""}>${innerHtml}</a>`;
}
