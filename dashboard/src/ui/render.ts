import type {
  ApprovalRequest,
  ConversationTurn,
  DashboardSnapshot,
  MemoryRecord,
  PageInfo,
  ProviderDefinitionV2,
  ProviderDiagnostic,
  RadarItem,
  ResearchArtifact,
  PracticeAttemptResult,
  RunEvent,
  RunListEntry,
  StudyArtifact,
  StudyDiagnostic,
  WorkExportResult,
  WorkHandoffPreview,
  WorkPlanArtifact,
  WorkVerificationReport,
  RunProposalV2,
  ReasoningEffortV2,
  SessionMessageV2,
  ToolCallPreviewV2,
  ToolSearchResultV2,
} from "../api/types";
import type { Locale } from "../i18n";
import { alternateLocale, tr } from "../i18n";

export type AgentWaitStage =
  | "prepare"
  | "sources"
  | "model"
  | "verify"
  | "retry"
  | "complete"
  | "error";

export function pairingMarkup(locale: Locale = "en"): string {
  return `
    <div class="aurora" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <section class="pairing" aria-labelledby="pairing-title">
      ${localeSwitch(locale)}
      <p class="eyebrow">Restork · LOCAL-FIRST AGENT · LOOPBACK ONLY</p>
      <h1 id="pairing-title">RES<span>TORK</span></h1>
      <p class="pairing-copy">${tr(locale, "One governed Core for <b>Research</b>, <b>Study</b>, and <b>Work</b>.", "一个受控 Core，连接 <b>Research</b>、<b>Study</b> 与 <b>Work</b>。")}</p>
      <form id="pair-form" class="pair-form">
        <label for="pair-code">${tr(locale, "Enter the one-time Web pairing code shown in the terminal", "输入终端显示的一次性 Web 配对码")}</label>
        <div><input id="pair-code" name="code" required autocomplete="off" spellcheck="false"><button type="submit">PAIR</button></div>
      </form>
      <p id="pair-status" class="status" role="status">${tr(locale, "The token stays in this page's memory only.", "Token 仅保存在当前页面内存中。")}</p>
    </section>`;
}

export function workspaceMarkup(snapshot: DashboardSnapshot, locale: Locale = "en"): string {
  const active = snapshot.runs.filter((entry) => !isTerminal(entry.summary.state));
  const pending = snapshot.approvals.filter((approval) => approval.decision === "pending");
  const incomplete = snapshot.taskBoard.tasks.filter((task) => !task.completed);
  const memories = snapshot.memory?.records.filter((record) => record.summary) ?? [];
  const v2 = snapshot.workspaceV2;
  const greeting = personalGreeting(snapshot, locale);
  return `
    <div class="aurora" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <section class="dashboard" aria-label="${tr(locale, "Restork local workspace", "Restork 本地工作台")}">
      <aside class="sidebar">
        <div class="brand"><strong>RES<span>TORK</span></strong><small>LOCAL-FIRST AGENT</small></div>
        <nav aria-label="${tr(locale, "Main navigation", "主导航")}">
          ${navButton("overview", "R", tr(locale, "Dashboard", "仪表盘"), true)}
          ${navButton("runs", "›", tr(locale, "Runs", "运行"), false, active.length)}
          ${navButton("approvals", "✓", tr(locale, "Approvals", "审批"), false, pending.length)}
          ${navButton("tasks", "□", tr(locale, "Tasks", "任务"), false, incomplete.length)}
          ${navButton("radar", "◇", tr(locale, "Radar", "雷达"), false, snapshot.radar.items.length)}
          ${navButton("memory", "M", tr(locale, "Memory", "记忆"), false, memories.length)}
          ${v2 ? navButton("conversation", "C", tr(locale, "Conversation", "对话"), false, v2.sessions.length) : ""}
          ${v2 ? navButton("deliverables", "D", tr(locale, "Deliverables", "交付物"), false, v2.deliverables.length) : ""}
          ${v2 ? navButton("extensions", "+", tr(locale, "Extensions", "扩展"), false, v2.extensions.length) : ""}
          ${v2 ? navButton("automation", "A", tr(locale, "Automation", "自动化"), false, v2.schedules.length) : ""}
          ${v2 ? navButton("settings", "⚙", tr(locale, "Settings", "设置"), false) : ""}
        </nav>
        <p class="sidebar-label">${tr(locale, "New run", "新建运行")}</p>
        <div class="mode-grid">
          ${modeButton("research", "R", tr(locale, "Source checks and evidence cards", "来源核查和证据卡片"))}
          ${modeButton("study", "S", tr(locale, "Learning paths and active recall", "学习路径和主动回忆"))}
          ${modeButton("work", "W", tr(locale, "Read-only plans and handoffs", "只读规划和交接包"))}
        </div>
        <p class="session">127.0.0.1 · LOCAL<br><b>CORE PAIRED</b></p>
      </aside>
      <main class="workspace">
        <header class="topline">
          <p>&gt; <span id="greeting">${escapeHtml(greeting)}</span><span class="caret" aria-hidden="true"></span></p>
          <div class="topline-actions">${localeSwitch(locale)}<button class="quiet-button" id="refresh" type="button">${tr(locale, "REFRESH", "刷新")}</button></div>
        </header>
        <p id="global-status" class="sr-only" role="status"></p>
        <section id="action-panel" class="action-panel" hidden>
          <form id="run-form">
            <input type="hidden" name="mode" id="run-mode" value="research">
            <label for="run-goal">${tr(locale, "Goal", "目标")}</label>
            <div><input id="run-goal" name="goal" required maxlength="1000"><button type="submit">${tr(locale, "START", "开始")}</button></div>
            <label id="study-target-label" for="study-target-note" hidden>${tr(locale, "Optional Obsidian note", "可选 Obsidian 笔记")}</label>
            <input id="study-target-note" name="target_note" maxlength="1024" hidden placeholder="Study/Topic.md">
            <fieldset id="work-fields" class="work-fields" hidden>
              <legend>${tr(locale, "PLANNING ONLY · RESTORK WILL NOT RUN CODE", "仅规划 · RESTORK 不会运行代码")}</legend>
              <label for="work-root">${tr(locale, "Workspace root · absolute local path", "本地仓库绝对路径")}</label>
              <input id="work-root" name="workspace_root" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="/path/to/repository">
              <label for="work-targets">${tr(locale, "Target files · one relative path per line", "目标文件 · 每行一个相对路径")}</label>
              <textarea id="work-targets" name="target_files" maxlength="16000" rows="3" spellcheck="false" placeholder="src/app.py"></textarea>
              <label for="work-context">${tr(locale, "Optional context files", "可选上下文文件")}</label>
              <textarea id="work-context" name="context_files" maxlength="30000" rows="2" spellcheck="false" placeholder="README.md"></textarea>
              <label for="work-class">${tr(locale, "Context class", "上下文分类")}</label>
              <select id="work-class" name="context_data_class"><option value="public">public</option><option value="personal">personal</option><option value="confidential">confidential</option></select>
              <label for="work-constraints">${tr(locale, "Constraints · one per line", "约束 · 每行一项")}</label>
              <textarea id="work-constraints" name="constraints" maxlength="30000" rows="2"></textarea>
              <label for="work-non-goals">${tr(locale, "Non-goals · one per line", "非目标 · 每行一项")}</label>
              <textarea id="work-non-goals" name="non_goals" maxlength="30000" rows="2"></textarea>
              <label for="work-verification">${tr(locale, "Proposed verification commands · never executed by Restork", "建议验证命令 · Restork 永不执行")}</label>
              <textarea id="work-verification" name="verification_commands" maxlength="30000" rows="2" spellcheck="false" placeholder="uv run pytest -q"></textarea>
              <p class="fine">${tr(locale, "Paths go only to the paired local Core. Review the plan, then the exact redacted context, then separately approve the private handoff.", "路径只发送到配对的本地 Core。先查看计划，再查看精确脱敏上下文，最后单独审批私有交接包。")}</p>
            </fieldset>
          </form>
          <p id="action-status" class="status" role="status"></p>
          <div id="agent-wait-host"></div>
          <div id="study-workspace" class="study-workspace" aria-live="polite"></div>
          <div id="work-workspace" class="work-workspace" aria-live="polite"></div>
        </section>
        <section class="metrics" aria-label="${tr(locale, "Run overview", "运行概览")}">
          ${metric("research", tr(locale, "Active runs", "进行中运行"), String(active.length), modeCounts(active, locale))}
          ${metric("approval", tr(locale, "Pending approvals", "待审批"), String(pending.length), tr(locale, "Single-use · expires", "单次能力 · 到期失效"))}
          ${metric("work", tr(locale, "Markdown tasks", "Markdown 任务"), String(incomplete.length), snapshot.taskBoard.configured ? tr(locale, "Markdown is canonical", "Markdown 为准") : tr(locale, "Vault not configured", "尚未配置 Vault"))}
          ${metric("study", tr(locale, "Memory records", "记忆记录"), String(memories.length), tr(locale, "Four layers · locally governed", "四层 · 本地可控"))}
        </section>
        ${providerSetup(snapshot.provider, locale)}
        ${dailyContext(snapshot, locale)}
        <section class="view is-visible" data-view-panel="overview">${overview(snapshot, locale)}</section>
        <section class="view" data-view-panel="runs" hidden>${runsView(snapshot.runs, snapshot.pagination?.runs, locale)}</section>
        <section class="view" data-view-panel="approvals" hidden>${approvalsView(snapshot.approvals, snapshot.pagination?.approvals, locale)}</section>
        <section class="view" data-view-panel="tasks" hidden>${tasksView(snapshot, locale)}</section>
        <section class="view" data-view-panel="radar" hidden>${radarView(snapshot, locale)}</section>
        <section class="view" data-view-panel="memory" hidden>${memoryView(snapshot, locale)}</section>
        ${v2 ? `<section class="view" data-view-panel="conversation" hidden>${conversationWorkspace(snapshot, locale)}</section>` : ""}
        ${v2 ? `<section class="view" data-view-panel="deliverables" hidden>${deliverablesWorkspace(snapshot, locale)}</section>` : ""}
        ${v2 ? `<section class="view" data-view-panel="extensions" hidden>${extensionsWorkspace(snapshot, locale)}</section>` : ""}
        ${v2 ? `<section class="view" data-view-panel="automation" hidden>${automationWorkspace(snapshot, locale)}</section>` : ""}
        ${v2 ? `<section class="view" data-view-panel="settings" hidden>${personalSettingsWorkspace(snapshot, locale)}</section>` : ""}
      </main>
    </section>`;
}

function personalGreeting(snapshot: DashboardSnapshot, locale: Locale): string {
  const band = snapshot.workspaceV2?.dailyContext?.time_band;
  const name = snapshot.workspaceV2?.personal?.settings.display_name?.trim();
  const salutation = {
    morning: tr(locale, "Good morning", "早上好"),
    noon: tr(locale, "Good noon", "中午好"),
    afternoon: tr(locale, "Good afternoon", "下午好"),
    evening: tr(locale, "Good evening", "晚上好"),
    late_night: tr(locale, "Still awake", "夜深了"),
  }[band ?? "morning"];
  const who = name ? `, ${name}` : "";
  return `${salutation}${who}. ${tr(locale, "What will you research, study, or finish today?", "今天想研究、学习，还是完成一项工作？")}`;
}

function conversationWorkspace(snapshot: DashboardSnapshot, locale: Locale): string {
  const sessions = snapshot.workspaceV2?.sessions ?? [];
  const profiles = snapshot.workspaceV2?.profiles ?? [];
  const active = sessions.find((session) => session.status === "active");
  const customProfiles = profiles.filter(({ profile }) =>
    profile.profile_id !== "safe-mode" && profile.profile_id !== "deepseek"
  );
  return `<article class="paper-card full-card conversation-workspace">
    <header><div><p class="eyebrow">WORKSPACE · TOOL-FREE INTAKE</p><h2>${tr(locale, "Conversation", "对话工作区")}</h2></div><span class="ribbon study">LOCAL</span></header>
    <div class="conversation-layout">
      <aside class="session-rail">
        <form id="session-create-form"><label for="session-title">${tr(locale, "New conversation", "新建对话")}</label><div><input id="session-title" name="title" maxlength="240" required placeholder="${tr(locale, "What are we working on?", "这次想做什么？")}"><button type="submit">+</button></div><label for="session-profile" class="sr-only">${tr(locale, "Conversation profile", "对话 Profile")}</label><select id="session-profile" name="profile_id" aria-describedby="session-profile-help"><option value="safe-mode">${tr(locale, "Safe Mode · local only", "安全模式 · 仅本地")}</option><option value="deepseek">DeepSeek V4 Pro · ${tr(locale, "cloud · public only", "云端 · 仅 public")}</option>${customProfiles.map(({ profile }) => `<option value="${escapeHtml(profile.profile_id)}">${escapeHtml(profile.name)} · ${escapeHtml(profile.maximum_data_class)}</option>`).join("")}</select><small id="session-profile-help">${tr(locale, "The selected profile is frozen for this conversation; cloud use is never selected silently.", "所选 Profile 会固定到本次对话；系统绝不会静默切换到云端。")}</small></form>
        <form id="session-search-form" class="compact-search"><label class="sr-only" for="session-search">${tr(locale, "Search conversations", "搜索对话")}</label><input id="session-search" name="query" maxlength="256" placeholder="${tr(locale, "Search message history", "搜索消息历史")}"><button type="submit">⌕</button></form><div id="session-search-results" aria-live="polite"></div>
        <div class="session-list">${sessions.map((session) => `<button type="button" data-session-select="${escapeHtml(session.session_id)}" data-session-title="${escapeHtml(session.title)}" data-session-profile="${escapeHtml(session.profile_id)}" data-session-version="${session.version}" class="session-item ${session.session_id === active?.session_id ? "is-active" : ""}"><strong>${escapeHtml(session.title)}</strong><small>${escapeHtml(session.profile_id)} · ${formatDate(session.updated_at, locale)}</small></button>`).join("") || `<p class="empty">${tr(locale, "Create a conversation to begin locally.", "新建一个对话，从本地开始。")}</p>`}</div>
      </aside>
      <section class="conversation-pane" data-active-session="${escapeHtml(active?.session_id ?? "")}" data-active-profile="${escapeHtml(active?.profile_id ?? "safe-mode")}">
        <header><div><small>${tr(locale, "Selected conversation", "当前对话")}</small><strong id="conversation-title">${escapeHtml(active?.title ?? tr(locale, "No conversation selected", "尚未选择对话"))}</strong></div><div class="session-actions"><span>${tr(locale, "No tools before proposal review", "提案确认前不调用工具")}</span><button type="button" data-session-export ${active ? "" : "disabled"}>${tr(locale, "EXPORT", "导出")}</button><button type="button" data-session-archive ${active ? "" : "disabled"}>${tr(locale, "ARCHIVE", "归档")}</button><button type="button" class="danger-text" data-session-delete ${active ? "" : "disabled"}>${tr(locale, "DELETE", "删除")}</button></div></header>
        <div id="conversation-messages" class="conversation-messages" tabindex="0" aria-live="polite"><p class="empty">${active ? tr(locale, "Loading local messages…", "正在加载本地消息…") : tr(locale, "Choose or create a conversation.", "请选择或新建对话。")}</p></div>
        <div id="conversation-wait" aria-live="polite"></div>
        <details class="context-preview" ${active && active.profile_id !== "safe-mode" ? "" : "hidden"}><summary>${tr(locale, "Add local files with an exact context preview", "添加本地文件并预览确切上下文")}</summary><form id="context-preview-form"><label>${tr(locale, "Text files (explicit selection only)", "文本文件（仅明确选择）")}<input name="files" type="file" multiple accept=".md,.txt,.json,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.toml,.yaml,.yml"></label><label>${tr(locale, "Data class", "数据分类")}<select name="data_class"><option value="public">public</option><option value="personal">personal</option><option value="confidential">confidential</option></select></label><button type="submit">${tr(locale, "PREVIEW CONTEXT", "预览上下文")}</button></form><div id="context-preview-result" role="status"><p class="fine">${tr(locale, "Restork reads only files you choose here. The preview expires in 15 minutes and can be used once.", "Restork 只读取你在这里选择的文件；预览 15 分钟后过期且只能使用一次。")}</p></div></details>
        <form id="session-message-form" class="conversation-composer" ${active ? "" : "hidden"}><label for="session-message" class="sr-only">${tr(locale, "Message", "消息")}</label><textarea id="session-message" name="content" rows="3" maxlength="1000000" required placeholder="${tr(locale, "Describe what you need. Enter sends; Shift+Enter adds a line.", "说说你需要什么。Enter 发送，Shift+Enter 换行。")}"></textarea><div><select name="data_class" aria-label="${tr(locale, "Data class", "数据分类")}"><option value="public">public</option><option value="personal">personal</option><option value="confidential">confidential</option></select><button type="submit">${tr(locale, "SEND", "发送")}</button></div></form>
        <form id="proposal-form" class="proposal-composer" ${active ? "" : "hidden"}><label>${tr(locale, "Turn the conversation into a reviewable run proposal", "将对话整理成可审查的运行提案")}</label><div><select name="mode"><option value="research">Research</option><option value="study">Study</option><option value="work">Work</option></select><input name="goal" maxlength="4000" required placeholder="${tr(locale, "Proposed goal", "提案目标")}"><button type="submit">${tr(locale, "PREVIEW", "预览")}</button></div></form>
        <div id="proposal-preview"></div>
        <details class="tool-discovery"><summary>${tr(locale, "Discover already-granted tools", "查找已授权工具")}</summary><form id="tool-search-form"><input name="query" maxlength="512" required placeholder="${tr(locale, "Search this session's frozen catalog", "搜索本会话冻结的工具目录")}"><button type="submit">${tr(locale, "SEARCH", "搜索")}</button></form><div id="tool-search-results"><p class="fine">${tr(locale, "Search cannot reveal or grant tools outside this conversation Profile.", "搜索不会显示或授予此对话 Profile 之外的工具。")}</p></div></details>
      </section>
    </div>
  </article>`;
}

function extensionsWorkspace(snapshot: DashboardSnapshot, locale: Locale): string {
  const records = snapshot.workspaceV2?.extensions ?? [];
  const sessions = snapshot.workspaceV2?.sessions.filter((session) => session.status === "active") ?? [];
  return `<article class="paper-card full-card catalog-workspace"><header><div><p class="eyebrow">EXTENSION CENTER</p><h2>${tr(locale, "Skills, MCP & plugins", "Skills、MCP 与插件")}</h2></div><span class="ribbon research">${tr(locale, "GOVERNED", "受控")}</span></header>
    <div class="catalog-toolbar" role="tablist"><button type="button" class="is-active" data-extension-filter="all">${tr(locale, "All", "全部")}</button><button type="button" data-extension-filter="skill">Skills</button><button type="button" data-extension-filter="mcp">MCP</button><button type="button" data-extension-filter="plugin">Plugins</button></div>
    <div class="catalog-grid extension-grid">${records.map((record) => `<article data-extension-card-kind="${escapeHtml(record.package_kind ?? "unknown")}"><strong>${escapeHtml(record.package_id ?? "extension")}</strong><span>${escapeHtml(record.package_kind ?? "extension")} · ${escapeHtml(record.state)}</span><small>${escapeHtml(record.manifest_hash?.slice(0, 16) ?? "no hash")}… · ${formatDate(record.updated_at, locale)}</small><details><summary>${tr(locale, "Manifest", "清单")}</summary><pre>${prettyJson(record.manifest)}</pre></details>${record.manifest_hash ? `<div class="record-actions"><button type="button" data-extension-state="${record.state === "enabled" ? "disable" : "enable"}" data-extension-id="${escapeHtml(record.package_id ?? "")}" data-extension-hash="${escapeHtml(record.manifest_hash)}">${record.state === "enabled" ? tr(locale, "DISABLE", "停用") : tr(locale, "REVIEW & ENABLE", "审查并启用")}</button><button type="button" class="quiet-button" data-extension-history data-extension-id="${escapeHtml(record.package_id ?? "")}" data-extension-hash="${escapeHtml(record.manifest_hash)}">${tr(locale, "VERSIONS & ROLLBACK", "版本与回滚")}</button></div><div class="extension-history" data-extension-history-results role="status"></div>` : ""}</article>`).join("") || `<p class="empty">${tr(locale, "No extensions installed. Safe Mode remains blank by default.", "尚未安装扩展；安全模式默认保持空白。")}</p>`}</div>
    <div class="catalog-compose-grid"><form id="extension-install-form"><h3>${tr(locale, "Install a pinned manifest", "安装已固定版本的清单")}</h3><label>${tr(locale, "Package type", "包类型")}<select name="package_kind"><option value="skill">Skill</option><option value="mcp">MCP</option><option value="plugin">Plugin</option></select></label><label class="wide-label">JSON<textarea name="manifest" rows="12" maxlength="2000000" required spellcheck="false" placeholder='{"schema_version":1}'></textarea></label><button type="submit">${tr(locale, "VALIDATE & QUARANTINE", "验证并隔离")}</button><p id="extension-install-status" role="status"></p></form>
    <form id="extension-tool-search-form"><h3>${tr(locale, "Session tool search", "会话工具搜索")}</h3><label>${tr(locale, "Conversation", "对话")}<select name="session_id">${sessions.map((session) => `<option value="${escapeHtml(session.session_id)}">${escapeHtml(session.title)}</option>`).join("")}</select></label><label>${tr(locale, "Query", "查询")}<input name="query" maxlength="512" required></label><button type="submit" ${sessions.length ? "" : "disabled"}>${tr(locale, "SEARCH FROZEN CATALOG", "搜索冻结目录")}</button><div id="extension-tool-results"></div></form></div>
    <p class="fine">${tr(locale, "Packages begin quarantined. Exact source, license, hash, permissions, secrets, transports, and tools must be reviewed before enablement. Dynamic npx, shell interpolation, and ambient environment inheritance are rejected by Core.", "扩展初始处于隔离状态；启用前必须审查精确来源、许可证、哈希、权限、Secret 引用、传输方式与工具。Core 会拒绝动态 npx、Shell 插值和环境变量继承。")}</p></article>`;
}

function deliverablesWorkspace(snapshot: DashboardSnapshot, locale: Locale): string {
  const records = snapshot.workspaceV2?.deliverables ?? [];
  const reports = records.filter((record) => record.kind === "daily_report" || record.kind === "weekly_report");
  return `<article class="paper-card full-card catalog-workspace"><header><div><p class="eyebrow">DELIVERABLES</p><h2>${tr(locale, "Reports & presentations", "报告与演示文稿")}</h2></div><span class="ribbon work">${tr(locale, "EVIDENCE FIRST", "证据优先")}</span></header>
    <div class="catalog-grid deliverable-grid">${records.map((record) => { const markdown = typeof record.artifact?.markdown === "string" ? record.artifact.markdown : null; const renderActions = record.kind === "deck" ? `<div class="record-actions"><button type="button" data-render-format="pptx" data-render-id="${escapeHtml(record.deliverable_id ?? "")}" data-render-revision="${record.revision ?? 1}">${tr(locale, "REVIEW PPTX", "审查 PPTX")}</button><button type="button" data-render-format="pdf" data-render-id="${escapeHtml(record.deliverable_id ?? "")}" data-render-revision="${record.revision ?? 1}">${tr(locale, "REVIEW PDF", "审查 PDF")}</button></div>` : ""; return `<article><strong>${escapeHtml(record.deliverable_id ?? "deliverable")}</strong><span>${escapeHtml(record.kind ?? "artifact")} · ${escapeHtml(record.state)}</span><small>v${record.revision ?? 1} · ${formatDate(record.updated_at, locale)}</small><details><summary>${markdown ? tr(locale, "Markdown preview", "Markdown 预览") : tr(locale, "DeckSpec preview", "DeckSpec 预览")}</summary><pre class="deliverable-preview">${markdown ? escapeHtml(markdown) : prettyJson(record.artifact)}</pre></details>${renderActions}</article>`; }).join("") || `<p class="empty">${tr(locale, "Create an evidence-labelled report draft to begin.", "先创建一份带证据标签的报告草稿。")}</p>`}</div>
    <div class="catalog-compose-grid"><form id="manual-report-form"><h3>${tr(locale, "Daily / weekly report draft", "日报 / 周报草稿")}</h3><label>ID<input name="report_id" required maxlength="128" pattern="[A-Za-z0-9:._-]+" value="report-${new Date().toISOString().slice(0, 10)}"></label><label>${tr(locale, "Kind", "类型")}<select name="kind"><option value="daily">${tr(locale, "Daily", "日报")}</option><option value="weekly">${tr(locale, "Weekly", "周报")}</option></select></label><label>${tr(locale, "Title", "标题")}<input name="title" required maxlength="300" value="${tr(locale, "Daily report", "日报")}"></label><label>${tr(locale, "Section", "章节")}<select name="section"><option value="completed">${tr(locale, "Completed", "已完成")}</option><option value="progress">${tr(locale, "Progress", "进展")}</option><option value="decisions">${tr(locale, "Decisions", "决策")}</option><option value="blockers">${tr(locale, "Blockers", "阻塞")}</option><option value="next">${tr(locale, "Next", "下一步")}</option><option value="notes">${tr(locale, "Notes", "备注")}</option></select></label><label class="wide-label">${tr(locale, "One explicit assertion per line", "每行一条明确自述")}<textarea name="entries" rows="8" maxlength="200000" required></textarea></label><button type="submit">${tr(locale, "BUILD REVIEWABLE DRAFT", "生成可审查草稿")}</button><p id="manual-report-status" role="status"></p></form>
    <form id="deck-from-report-form"><h3>${tr(locale, "Presentation outline", "演示文稿大纲")}</h3><label>ID<input name="deck_id" required maxlength="128" pattern="[A-Za-z0-9:._-]+" value="deck-${new Date().toISOString().slice(0, 10)}"></label><label>${tr(locale, "Source report", "来源报告")}<select name="report">${reports.map((record) => `<option value="${escapeHtml(record.deliverable_id ?? "")}" data-revision="${record.revision ?? 1}">${escapeHtml(record.deliverable_id ?? "report")} · v${record.revision ?? 1}</option>`).join("")}</select></label><label>${tr(locale, "Audience", "受众")}<input name="audience" required maxlength="120" value="team"></label><label>${tr(locale, "Purpose", "目的")}<input name="purpose" required maxlength="300" value="${tr(locale, "Review and decision", "复盘与决策")}"></label><label>${tr(locale, "Expertise", "专业程度")}<input name="expertise" required maxlength="300" value="${tr(locale, "Mixed", "混合")}"></label><button type="submit" ${reports.length ? "" : "disabled"}>${tr(locale, "FREEZE OUTLINE", "冻结大纲")}</button><p id="deck-from-report-status" role="status"></p><p class="fine">${tr(locale, "PPTX/PDF rendering is deterministic and macro-free. Restork shows the exact artifact hash before download approval.", "PPTX/PDF 渲染可复现且不含宏；下载批准前 Restork 会展示精确的产物哈希。")}</p></form></div></article>`;
}

function automationWorkspace(snapshot: DashboardSnapshot, locale: Locale): string {
  const records = snapshot.workspaceV2?.schedules ?? [];
  const profiles = snapshot.workspaceV2?.profiles ?? [];
  return `<article class="paper-card full-card catalog-workspace"><header><div><p class="eyebrow">AUTOMATION & RECOVERY</p><h2>${tr(locale, "Bounded schedules and recovery", "有界调度与恢复")}</h2></div><span class="ribbon work">${tr(locale, "NO SILENT EFFECTS", "无静默副作用")}</span></header>
    <div class="catalog-grid automation-grid">${records.map((record) => `<article><strong>${escapeHtml(record.schedule_id ?? "schedule")}</strong><span>${escapeHtml(record.state)} · v${record.revision ?? 1}</span><small>${record.next_run_at ? `${tr(locale, "Next", "下次")} ${formatDate(record.next_run_at, locale)}` : tr(locale, "Paused", "已暂停")}</small><details><summary>${tr(locale, "Frozen job", "冻结任务")}</summary><pre>${prettyJson(record.schedule)}</pre></details><div class="record-actions"><button type="button" data-schedule-action="run" data-schedule-id="${escapeHtml(record.schedule_id ?? "")}" data-schedule-revision="${record.revision ?? 1}">${tr(locale, "RUN NOW", "立即运行")}</button><button type="button" data-schedule-action="${record.state === "active" ? "pause" : "resume"}" data-schedule-id="${escapeHtml(record.schedule_id ?? "")}" data-schedule-revision="${record.revision ?? 1}">${record.state === "active" ? tr(locale, "PAUSE", "暂停") : tr(locale, "RESUME", "恢复")}</button><button type="button" class="danger-text" data-schedule-action="delete" data-schedule-id="${escapeHtml(record.schedule_id ?? "")}" data-schedule-revision="${record.revision ?? 1}">${tr(locale, "REMOVE", "移除")}</button></div></article>`).join("") || `<p class="empty">${tr(locale, "No schedules. Restork will not start background model work by itself.", "尚无调度；Restork 不会自行启动后台模型任务。")}</p>`}</div>
    <div class="catalog-compose-grid"><form id="schedule-create-form"><h3>${tr(locale, "New bounded schedule", "新建有界调度")}</h3><label>ID<input name="schedule_id" required maxlength="128" pattern="[A-Za-z0-9:._-]+"></label><label>${tr(locale, "Time", "时间")}<input name="time" type="time" required value="09:00"></label><label>${tr(locale, "Recurrence", "重复")}<select name="recurrence"><option value="daily">${tr(locale, "Daily", "每天")}</option><option value="weekly">${tr(locale, "Weekly", "每周")}</option></select></label><label>${tr(locale, "Weekday", "星期")}<select name="weekday"><option value="0">${tr(locale, "Monday", "周一")}</option><option value="1">${tr(locale, "Tuesday", "周二")}</option><option value="2">${tr(locale, "Wednesday", "周三")}</option><option value="3">${tr(locale, "Thursday", "周四")}</option><option value="4">${tr(locale, "Friday", "周五")}</option><option value="5">${tr(locale, "Saturday", "周六")}</option><option value="6">${tr(locale, "Sunday", "周日")}</option></select></label><label>${tr(locale, "Job", "任务")}<select name="job"><option value="health.check">${tr(locale, "Local health check · no model", "本地健康检查 · 无模型")}</option><option value="daily.refresh">${tr(locale, "Refresh daily cache · no model", "刷新每日缓存 · 无模型")}</option>${profiles.map(({ profile }) => `<option value="model:${escapeHtml(profile.profile_id)}">${tr(locale, "Create model draft", "创建模型草稿")} · ${escapeHtml(profile.name)}</option>`).join("")}</select></label><button type="submit">${tr(locale, "CREATE SCHEDULE", "创建调度")}</button><p id="schedule-create-status" role="status"></p></form>
    <section class="automation-contracts"><h3>${tr(locale, "Recovery & evaluation contracts", "恢复与评估契约")}</h3><ul><li>${tr(locale, "Checkpoints require explicit relative paths, byte limits, and a pre-rollback checkpoint.", "检查点要求明确的相对路径、字节上限和回滚前检查点。")}</li><li>${tr(locale, "Evaluation manifests freeze model, prompt, Skill, tool, policy, and fixture versions.", "评估清单会冻结模型、Prompt、Skill、工具、Policy 与 fixture 版本。")}</li><li>${tr(locale, "Delegated subtasks receive subset-only sources, tools, and budgets; recursion, approvals, effects, and durable memory are disabled.", "委派子任务只能获得来源、工具和预算的子集；递归、审批、副作用和持久记忆均被禁用。")}</li></ul></section></div></article>`;
}

export function toolSearchMarkup(result: ToolSearchResultV2, locale: Locale): string {
  return `<div class="tool-results"><small>${tr(locale, "Frozen catalog", "冻结目录")} · ${escapeHtml(result.catalog_fingerprint.slice(0, 16))}…</small>${result.items.map((item) => `<button type="button" data-tool-preview="${escapeHtml(item.tool_id)}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.tool_id)} · ${item.score}</span></button>`).join("") || `<p class="empty">${tr(locale, "No already-granted tool matched.", "没有已授权工具匹配。")}</p>`}</div>`;
}

export function toolCallPreviewMarkup(preview: ToolCallPreviewV2, locale: Locale): string {
  return `<article class="proposal-card"><header><strong>${tr(locale, "Tool review required", "工具调用需要审查")}</strong><span>${escapeHtml(preview.resolved_call.real_tool_id)}</span></header><p>${tr(locale, "Execution has not started. Review the exact tool, input, permissions, transport, and digest below.", "执行尚未开始；请审查下方精确的工具、输入、权限、传输方式与摘要。")}</p><pre>${prettyJson(preview.resolved_call)}</pre><small>SHA-256 · ${escapeHtml(preview.call_digest)}</small><button type="button" data-tool-execute>${tr(locale, "APPROVE & RUN", "批准并运行")}</button></article>`;
}

function prettyJson(value: unknown): string {
  return escapeHtml(JSON.stringify(value ?? {}, null, 2));
}

function providerRegistryOption(definition: ProviderDefinitionV2, locale: Locale): string {
  return `<option value="${escapeHtml(definition.id)}" data-base-url="${escapeHtml(definition.default_base_url)}" data-auth-kind="${escapeHtml(definition.auth_kind)}" data-discovery="${escapeHtml(definition.model_discovery)}" data-reasoning-efforts="${escapeHtml(definition.reasoning.supported_efforts.join(","))}" data-reasoning-can-disable="${definition.reasoning.can_disable}" data-reasoning-budget="${definition.reasoning.supports_token_budget}">${escapeHtml(definition.display_name)}${definition.kind === "ollama" ? ` (${tr(locale, "local", "本地")})` : ""}</option>`;
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
  return `<article class="paper-card full-card settings-workspace"><header><div><p class="eyebrow">LOCAL PROFILE</p><h2>${tr(locale, "Make Restork yours", "让 Restork 更像你的工作台")}</h2></div><span class="ribbon study">PRIVATE</span></header>
    <div class="settings-sections">
      <section class="settings-section"><header><div><small>PERSONAL</small><h3>${tr(locale, "Profile & appearance", "个人资料与外观")}</h3></div></header>
        <form id="personal-settings-form" data-version="${record?.version ?? 0}">
          <label>${tr(locale, "Display name (optional)", "称呼（可选）")}<input name="display_name" maxlength="80" value="${escapeHtml(settings.display_name ?? "")}" autocomplete="nickname"></label>
          <label>${tr(locale, "Language", "语言")}<select name="locale"><option value="en" ${settings.locale === "en" ? "selected" : ""}>English</option><option value="zh-CN" ${settings.locale === "zh-CN" ? "selected" : ""}>简体中文</option></select></label>
          <label>${tr(locale, "Time zone", "时区")}<input name="timezone" maxlength="128" value="${escapeHtml(settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC")}"></label>
          <label>${tr(locale, "Theme", "主题")}<select name="theme"><option value="system">${tr(locale, "System", "跟随系统")}</option><option value="light" ${settings.theme === "light" ? "selected" : ""}>${tr(locale, "Light", "浅色")}</option><option value="dark" ${settings.theme === "dark" ? "selected" : ""}>${tr(locale, "Dark", "深色")}</option></select></label>
          <button type="submit">${tr(locale, "SAVE LOCALLY", "保存到本地")}</button><p id="personal-settings-status" role="status"></p>
        </form>
        <p class="fine">${tr(locale, "Your display name is not sent to a model unless a profile explicitly opts in.", "称呼默认不会发送给模型，只有明确启用的 Profile 才会包含它。")}</p>
      </section>
      <section class="settings-section"><header><div><small>MODEL CENTER</small><h3>${tr(locale, "Providers", "模型供应商")}</h3></div><span>${providers.length}</span></header>
        <div class="settings-records">${providers.map((record) => `<article><strong>${escapeHtml(record.provider.display_name)}</strong><span>${escapeHtml(record.provider.kind)} · ${escapeHtml(record.provider.model)}</span><small>v${record.revision} · ${tr(locale, "reasoning", "思考强度")} ${escapeHtml(record.provider.reasoning?.effort ?? "auto")} · ${record.provider.secret_ref ? tr(locale, "native secret reference", "原生密钥引用") : tr(locale, "no secret", "无需密钥")}</small><button type="button" data-provider-edit="${escapeHtml(record.provider.profile_id)}" data-provider-record="${escapeHtml(JSON.stringify(record))}">${tr(locale, "EDIT", "编辑")}</button></article>`).join("") || `<p class="empty">${tr(locale, "Choose a cloud provider, local Ollama, or a generic OpenAI-compatible endpoint.", "选择云端供应商、本地 Ollama 或通用 OpenAI 兼容端点。")}</p>`}</div>
        <form id="provider-profile-form" data-version="0">
          <label>ID<input name="profile_id" required maxlength="80" pattern="[A-Za-z0-9._-]+" placeholder="deepseek-main"></label>
          <label>${tr(locale, "Name", "名称")}<input name="display_name" required maxlength="120" placeholder="DeepSeek V4 Pro"></label>
          <label>${tr(locale, "Kind", "类型")}<select name="kind">${providerRegistry.length ? providerRegistry.map((definition) => providerRegistryOption(definition, locale)).join("") : `<option value="deepseek" data-base-url="https://api.deepseek.com" data-auth-kind="bearer" data-reasoning-efforts="high,max" data-reasoning-can-disable="true" data-reasoning-budget="false">DeepSeek</option><option value="glm" data-base-url="https://open.bigmodel.cn/api/paas/v4" data-auth-kind="bearer" data-reasoning-efforts="high,max" data-reasoning-can-disable="true" data-reasoning-budget="false">GLM</option><option value="kimi" data-base-url="https://api.moonshot.cn/v1" data-auth-kind="bearer" data-reasoning-efforts="" data-reasoning-can-disable="true" data-reasoning-budget="false">Kimi</option><option value="qwen" data-base-url="https://dashscope.aliyuncs.com/compatible-mode/v1" data-auth-kind="bearer" data-reasoning-efforts="minimal,low,medium,high,xhigh,max" data-reasoning-can-disable="true" data-reasoning-budget="true">Qwen</option><option value="ollama" data-base-url="http://127.0.0.1:11434" data-auth-kind="none" data-reasoning-efforts="low,medium,high" data-reasoning-can-disable="true" data-reasoning-budget="false">Ollama (${tr(locale, "local", "本地")})</option><option value="openrouter" data-base-url="https://openrouter.ai/api/v1" data-auth-kind="bearer" data-reasoning-efforts="minimal,low,medium,high,xhigh,max" data-reasoning-can-disable="true" data-reasoning-budget="true">OpenRouter</option><option value="open_ai_compatible" data-base-url="https://api.example.invalid/v1" data-auth-kind="bearer" data-reasoning-efforts="" data-reasoning-can-disable="false" data-reasoning-budget="false">OpenAI-compatible</option>`}</select></label>
          <label>${tr(locale, "Base URL", "基础地址")}<input name="base_url" required maxlength="2048" value="https://api.deepseek.com"></label>
          <label>${tr(locale, "Model", "模型")}<input name="model" required maxlength="256" value="deepseek-v4-pro"></label>
          <label>${tr(locale, "Reasoning intensity", "思考强度")}<select name="reasoning_effort">${reasoningEffortOptions(locale)}</select></label>
          <label data-reasoning-budget-field hidden>${tr(locale, "Reasoning token budget (optional)", "思考 Token 预算（可选）")}<input name="reasoning_max_tokens" type="number" min="256" max="128000" step="1" disabled></label>
          <label>${tr(locale, "Native secret reference (never the key)", "原生密钥引用（绝不是 Key 本身）")}<input name="secret_ref" maxlength="256" placeholder="keychain:restork/provider/deepseek"></label>
          <button type="submit">${tr(locale, "SAVE PROVIDER", "保存供应商")}</button><p id="provider-profile-status" role="status"></p>
        </form>
        <p class="fine">${tr(locale, "Each provider exposes only supported reasoning levels. The selected policy is frozen with the profile and run; Restork does not retain or display private chain-of-thought. Cloud keys use the native secret prompt or CLI and never pass through Dashboard JavaScript.", "每个供应商只显示真正支持的思考档位；所选策略会随 Profile 与运行冻结。Restork 不保存、也不展示模型的私有思维链。云端 Key 只经原生密钥提示或 CLI，绝不经过 Dashboard JavaScript。")}</p>
      </section>
      <section class="settings-section"><header><div><small>PROMPT STUDIO</small><h3>${tr(locale, "Versioned instructions", "版本化指令")}</h3></div><span>${prompts.length}</span></header>
        <div class="settings-records prompt-history">${prompts.map((record) => `<article><strong>${escapeHtml(record.prompt.prompt_id)} · v${record.prompt.revision}</strong><span>${escapeHtml(record.prompt.layer)} · ${escapeHtml(record.content_hash.slice(0, 12))}…</span><small>${record.active ? tr(locale, "ACTIVE", "当前启用") : formatDate(record.created_at, locale)}</small>${record.active ? "" : `<button type="button" data-prompt-activate="${record.prompt.revision}" data-prompt-id="${escapeHtml(record.prompt.prompt_id)}" data-active-revision="${activePrompt?.prompt.revision ?? 0}">${tr(locale, "ACTIVATE", "启用")}</button>`}</article>`).join("") || `<p class="empty">${tr(locale, "Create a personal or Skill prompt revision. Core policy cannot be edited here.", "新建个人或 Skill Prompt 修订；Core Policy 不能在这里编辑。")}</p>`}</div>
        <form id="prompt-revision-form" data-version="${prompts[0]?.prompt.revision ?? 0}">
          <label>Prompt ID<input name="prompt_id" required maxlength="80" pattern="[A-Za-z0-9._-]+" value="personal"></label>
          <label>${tr(locale, "Layer", "层级")}<select name="layer"><option value="personal">personal</option><option value="skill">skill</option></select></label>
          <label class="wide-label">${tr(locale, "Instructions", "指令")}<textarea name="content" required maxlength="64000" rows="8" placeholder="${tr(locale, "Describe preferences; permissions still come only from Core policy.", "描述你的偏好；权限仍只来自 Core Policy。")}"></textarea></label>
          <button type="submit">${tr(locale, "SAVE NEW REVISION", "保存新修订")}</button><p id="prompt-revision-status" role="status"></p>
        </form>
      </section>
      <section class="settings-section"><header><div><small>PROFILES</small><h3>${tr(locale, "Governed work profiles", "受控工作 Profile")}</h3></div><span>${profiles.length}</span></header>
        <div class="settings-records">${profiles.map((record) => `<article><strong>${escapeHtml(record.profile.name)}</strong><span>${escapeHtml(record.profile.provider_profile_id)} · ${escapeHtml(record.profile.maximum_data_class)}</span><small>v${record.revision}${record.builtin ? ` · ${tr(locale, "built-in", "内置")}` : ""}</small></article>`).join("") || `<p class="empty">${tr(locale, "Profiles freeze a provider, prompt, tools, and data boundary for each run.", "Profile 会为每次运行冻结供应商、Prompt、工具和数据边界。")}</p>`}</div>
        <form id="configuration-profile-form" data-version="0" data-prompt-hash="${escapeHtml(activePrompt?.content_hash ?? "")}">
          <label>ID<input name="profile_id" required maxlength="80" pattern="[A-Za-z0-9._-]+" placeholder="research-cloud"></label>
          <label>${tr(locale, "Name", "名称")}<input name="name" required maxlength="120" placeholder="Research Cloud"></label>
          <label>${tr(locale, "Provider", "供应商")}<select name="provider_profile_id" required>${providers.map((record) => `<option value="${escapeHtml(record.provider.profile_id)}">${escapeHtml(record.provider.display_name)}</option>`).join("")}</select></label>
          <label>${tr(locale, "Maximum data class", "最高数据等级")}<select name="maximum_data_class"><option value="public">public</option><option value="personal">personal</option><option value="confidential">confidential</option></select></label>
          <label>${tr(locale, "Enabled Skills (comma separated)", "启用的 Skills（逗号分隔）")}<input name="enabled_skill_ids" maxlength="4000" placeholder="research,last-30-days"></label>
          <label>${tr(locale, "Allowed tools (comma separated)", "允许的工具（逗号分隔）")}<input name="allowed_tools" maxlength="4000" placeholder="source-read,vault-search"></label>
          <label class="check-label"><input type="checkbox" name="include_display_name_in_prompt">${tr(locale, "Include my display name in this profile's prompts", "允许此 Profile 在 Prompt 中包含我的称呼")}</label>
          <button type="submit" ${providers.length && activePrompt ? "" : "disabled"}>${tr(locale, "SAVE PROFILE", "保存 PROFILE")}</button><p id="configuration-profile-status" role="status">${providers.length && activePrompt ? "" : tr(locale, "Add a provider and activate a prompt first.", "请先添加供应商并启用一个 Prompt。")}</p>
        </form>
      </section>
      <section class="settings-section"><header><div><small>UPDATES & RECOVERY</small><h3>${tr(locale, "Verified desktop recovery", "已验证的桌面恢复")}</h3></div></header>
        <p>${tr(locale, "Restork keeps at most two updater packages after their Tauri signature has been verified. They are never executed as a downgrade automatically.", "Restork 最多保留两个已经通过 Tauri 签名校验的更新包，并且绝不会自动降级执行它们。")}</p>
        <button type="button" data-update-recovery>${tr(locale, "SHOW RECOVERY COPIES", "查看恢复副本")}</button>
        <div id="update-recovery-results" class="settings-records" role="status"><p class="empty">${tr(locale, "Available in the signed desktop app.", "仅在已签名桌面应用中可用。")}</p></div>
      </section>
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
    cancelling: ["Stopping safely", "正在安全停止"],
    cancelled: ["Stopped; the partial answer was not saved", "已停止；未保存不完整回答"],
    failed: ["The model turn ended safely", "模型回合已安全结束"],
  };
  const [en, zh] = copy[phase] ?? copy.queued;
  return `<div class="conversation-wait" data-operation-phase="${escapeHtml(phase)}"><i aria-hidden="true"></i><span><strong>${tr(locale, en, zh)}</strong><small>${tr(locale, "Tools remain off · the event stream can reconnect", "工具保持关闭 · 事件流可断线重连")}</small></span>${canCancel ? `<button type="button" class="quiet-button" data-conversation-cancel>${tr(locale, "STOP", "停止")}</button>` : ""}</div>`;
}

export function runProposalMarkup(proposal: RunProposalV2, locale: Locale): string {
  return `<article class="proposal-card"><header><strong>${tr(locale, "Review required", "需要审查")}</strong><span>${escapeHtml(proposal.mode)}</span></header><p>${escapeHtml(proposal.goal)}</p><dl><div><dt>${tr(locale, "Tools", "工具")}</dt><dd>${proposal.requested_tools.length}</dd></div><div><dt>${tr(locale, "Sources", "来源")}</dt><dd>${proposal.sources.length}</dd></div><div><dt>${tr(locale, "Boundary", "边界")}</dt><dd>${tr(locale, "Local intake only", "仅本地接收")}</dd></div></dl><small>${tr(locale, "No network, file, provider, or tool access happened while creating this proposal.", "生成这个提案时没有访问网络、文件、模型供应商或工具。")}</small></article>`;
}

export function agentWaitMarkup(
  stage: AgentWaitStage,
  locale: Locale = "en",
): string {
  const current = stage === "retry" ? 2 : Math.min(
    ["prepare", "sources", "model", "verify", "complete"].indexOf(stage),
    4,
  );
  const labels = [
    tr(locale, "Bound context", "有界上下文"),
    tr(locale, "Sources & tools", "来源与工具"),
    tr(locale, "Synthesis", "综合推理"),
    tr(locale, "Validation", "结果校验"),
  ];
  const status = {
    prepare: tr(locale, "Preparing the minimum necessary context…", "正在准备最小必要上下文…"),
    sources: tr(locale, "Reading approved sources and tool results…", "正在读取获准的来源与工具结果…"),
    model: tr(locale, "Running the configured synthesizer…", "正在运行已配置的综合器…"),
    verify: tr(locale, "Validating evidence, schema, and policy…", "正在校验证据、Schema 与策略…"),
    retry: tr(locale, "A bounded retry was scheduled…", "已安排一次有界重试…"),
    complete: tr(locale, "The reviewable result is ready.", "可审阅结果已就绪。"),
    error: tr(locale, "The run stopped safely; inspect the status for details.", "运行已安全停止；请查看状态详情。"),
  }[stage];
  const busy = !["complete", "error"].includes(stage);
  return `<section class="agent-wait is-${stage}" role="status" aria-live="polite" aria-busy="${String(busy)}">
    <div class="typewriter-motion" aria-hidden="true"><i></i><i></i><i></i><span></span></div>
    <div class="agent-wait-copy"><small>CORE EVENT STREAM · ${escapeHtml(stage.toUpperCase())}</small><strong>${escapeHtml(status)}</strong>
      <ol>${labels.map((label, index) => `<li class="${index < current || stage === "complete" ? "is-done" : index === current && stage !== "error" ? "is-current" : ""}">${escapeHtml(label)}</li>`).join("")}</ol>
      <p>${tr(locale, "Only durable phases are shown; private reasoning content is never streamed to the Dashboard.", "这里只显示持久阶段；私有推理内容不会流式发送到 Dashboard。")}</p>
    </div>
  </section>`;
}

export function providerDiagnosticMarkup(
  report: ProviderDiagnostic,
  locale: Locale = "en",
): string {
  const successful = ["ready", "connected", "smoke_passed"].includes(report.status);
  const facts = [
    report.latency_ms === null
      ? null
      : tr(locale, `${report.latency_ms} ms`, `${report.latency_ms} 毫秒`),
    report.request_id ? `request ${report.request_id}` : null,
    report.total_tokens === null
      ? null
      : tr(locale, `${report.total_tokens} test tokens`, `${report.total_tokens} 个测试 token`),
  ].filter((value): value is string => value !== null);
  return `<article class="provider-diagnostic-result ${successful ? "is-ready" : "is-action"}" data-provider-status="${escapeHtml(report.status)}">
    <strong>${escapeHtml(report.status.replaceAll("_", " ").toUpperCase())}</strong>
    <p>${escapeHtml(providerStatusMessage(report.status, locale))}</p>
    ${facts.length ? `<small>${facts.map(escapeHtml).join(" · ")}</small>` : ""}
    ${report.restart_required ? `<em>${tr(locale, "Restart Restork Core before starting a model-backed run.", "启动模型任务前，请重启 Restork Core。")}</em>` : ""}
  </article>`;
}

export function providerWaitMarkup(smoke: boolean, locale: Locale = "en"): string {
  return `<section class="provider-wait" role="status" aria-live="polite" aria-busy="true">
    <div class="typewriter-motion" aria-hidden="true"><i></i><i></i><i></i><span></span></div>
    <div><small>${smoke ? "FIXED PUBLIC SMOKE TEST" : "BOUNDED MODEL ACCESS CHECK"}</small>
      <strong>${smoke
        ? tr(locale, "Waiting for the fixed low-token completion…", "正在等待固定的低 token 短句响应…")
        : tr(locale, "Checking authentication and model access…", "正在检查认证与模型权限…")}</strong>
      <p>${tr(locale, "No Vault, memory, task, location, or daily-context content is included.", "不会包含 Vault、记忆、任务、位置或每日上下文内容。")}</p>
    </div>
  </section>`;
}

export function providerErrorMarkup(locale: Locale = "en"): string {
  return `<article class="provider-diagnostic-result is-action" data-provider-status="provider_unavailable">
    <strong>${tr(locale, "CHECK FAILED", "检查失败")}</strong>
    <p>${tr(locale, "The bounded provider check could not complete. Review Core and try again.", "有界模型检查未能完成，请检查 Core 后重试。")}</p>
  </article>`;
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
  return `
    <article class="paper-card detail-card">
      <header><h2>${escapeHtml(run.task?.goal ?? summary.task_id)}</h2><span class="ribbon ${escapeHtml(summary.mode)}">${escapeHtml(summary.mode)}</span></header>
      <dl class="metadata">
        <div><dt>RUN</dt><dd>${escapeHtml(summary.run_id)}</dd></div>
        <div><dt>STATE</dt><dd>${escapeHtml(summary.state)}</dd></div>
        <div><dt>${tr(locale, "UPDATED", "更新时间")}</dt><dd>${formatDate(summary.updated_at, locale)}</dd></div>
        <div><dt>TOKENS</dt><dd>${String(run.budget?.usage.tokens ?? 0)}</dd></div>
      </dl>
      ${paginationControl("events", page, locale, tr(locale, "LOAD EARLIER EVENTS", "加载更早事件"))}
      <ol class="event-list">${events.length ? events.map(eventRow).join("") : `<li>${tr(locale, "No new events.", "暂无新事件。")}</li>`}</ol>
      <section class="conversation-panel" aria-labelledby="conversation-title">
        <header>
          <div><p class="eyebrow">RUN-SCOPED · NO TOOLS</p><h3 id="conversation-title">${tr(locale, "Conversation", "多轮对话")}</h3></div>
          <span>${prompt ? `PROMPT ${escapeHtml(prompt.prompt_version)}` : "BOUNDED CONTEXT"}</span>
        </header>
        <div class="conversation-history" data-conversation-scroll role="log" aria-live="polite" tabindex="0">
          ${paginationControl("conversation", conversation?.page, locale, tr(locale, "LOAD EARLIER MESSAGES", "加载更早消息"))}
          ${turns.length ? turns.map((turn) => conversationTurnMarkup(turn, locale)).join("") : `<p class="empty">${tr(locale, "Ask about this run. Conversation history stays local.", "围绕此运行提问；对话历史留在本地。")}</p>`}
          ${conversation?.busy ? `<div class="conversation-wait" role="status" aria-busy="true"><i></i><i></i><i></i><span>${tr(locale, "The configured model is composing a bounded answer…", "已配置模型正在生成受限回答…")}</span></div>` : ""}
        </div>
        ${conversation?.error ? `<p class="conversation-error" role="alert">${escapeHtml(conversation.error)}</p>` : ""}
        <form class="conversation-composer" data-conversation-form data-run-id="${escapeHtml(summary.run_id)}">
          <label for="conversation-input">${tr(locale, "Message for this run", "给当前运行发送消息")}</label>
          <textarea id="conversation-input" name="content" rows="3" maxlength="16000" required ${conversation?.enabled && !conversation.busy ? "" : "disabled"} placeholder="${tr(locale, "Ask, compare, explain, or refine…", "提问、比较、解释或继续细化…")}">${escapeHtml(conversation?.draft ?? "")}</textarea>
          <div><small>${tr(locale, "Sliding context window · no tools · effects still require a separate approval", "滑动上下文窗口 · 无工具权限 · 所有副作用仍需单独审批")}</small><button type="submit" ${conversation?.enabled && !conversation.busy ? "" : "disabled"}>${tr(locale, "SEND", "发送")}</button></div>
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
    <header><div><p class="eyebrow">${tr(locale, "VALIDATED RESEARCH ARTIFACT", "已验证的研究产物")}</p><h3 id="research-result-title">${escapeHtml(artifact.question)}</h3></div><span>${escapeHtml(artifact.note_preview.action.toUpperCase())}</span></header>
    <dl class="research-metrics">
      <div><dt>${tr(locale, "SUPPORTED", "有证据")}</dt><dd>${percent(metrics.supported_claim_rate)}</dd></div>
      <div><dt>${tr(locale, "PRIMARY", "一手来源")}</dt><dd>${percent(metrics.primary_source_ratio)}</dd></div>
      <div><dt>${tr(locale, "CITATIONS", "引用")}</dt><dd>${percent(metrics.citation_correctness)}</dd></div>
      <div><dt>${tr(locale, "RELATED", "相关笔记")}</dt><dd>${metrics.related_note_count}</dd></div>
    </dl>
    <section><h4>${tr(locale, "Claims", "论断")}</h4><ol>${artifact.claims.map((claim) => `<li><b>${escapeHtml(claim.kind)}</b>${escapeHtml(claim.statement)}<small>${claim.evidence_refs.map(escapeHtml).join(" · ") || escapeHtml(claim.inference_basis ?? tr(locale, "explicit inference", "显式推断"))}</small></li>`).join("")}</ol></section>
    ${artifact.conflicts.length ? `<section><h4>${tr(locale, "Conflicts", "冲突")}</h4><ul>${artifact.conflicts.map((conflict) => `<li>${escapeHtml(conflict.description)}</li>`).join("")}</ul></section>` : ""}
    <section><h4>${tr(locale, "Markdown preview", "Markdown 预览")} · ${escapeHtml(artifact.note_preview.relative_path)}</h4><pre>${escapeHtml(artifact.note_preview.markdown)}</pre></section>
    <p class="fine">${tr(locale, "Preview only · Core has not written this note.", "仅预览 · Core 尚未写入此笔记。")} ${tr(locale, "Artifact", "产物")} ${escapeHtml(artifact.artifact_id)}</p>
  </article>`;
}

export function studyDiagnosticMarkup(
  diagnostic: StudyDiagnostic,
  locale: Locale = "en",
): string {
  return `<article class="study-result" aria-labelledby="study-diagnostic-title">
    <header><div><p class="eyebrow">${tr(locale, "DIAGNOSTIC FIRST · ANSWERS STAY LOCAL", "先诊断 · 回答留在本地")}</p><h3 id="study-diagnostic-title">${escapeHtml(diagnostic.objective)}</h3></div><span>${tr(locale, "PLANNING", "规划中")}</span></header>
    <form data-study-diagnostic data-run-id="${escapeHtml(diagnostic.run_id)}">
      ${diagnostic.questions.map((question, index) => `<label>${index + 1}. ${escapeHtml(question.prompt)}${question.response_kind === "rating" ? `<input data-diagnostic-question name="${escapeHtml(question.question_id)}" type="number" min="0" max="4" required inputmode="numeric">` : `<textarea data-diagnostic-question name="${escapeHtml(question.question_id)}" required maxlength="4000" rows="3"></textarea>`}</label>`).join("")}
      <button type="submit">${tr(locale, "BUILD PATH", "生成路径")}</button>
    </form>
    <p class="fine">${tr(locale, "The Core creates no learning path until every diagnostic question is answered.", "所有诊断问题回答完成后，Core 才会生成学习路径。")}</p>
  </article>`;
}

export function studyArtifactMarkup(
  artifact: StudyArtifact,
  locale: Locale = "en",
): string {
  return `<article class="study-result" aria-labelledby="study-artifact-title">
    <header><div><p class="eyebrow">${tr(locale, "VALIDATED STUDY PATH", "已验证的学习路径")}</p><h3 id="study-artifact-title">${escapeHtml(artifact.objective.outcome)}</h3></div><span>${escapeHtml(artifact.readiness_signal.toUpperCase())}</span></header>
    <section><h4>${tr(locale, "Learning path", "学习路径")}</h4><ol class="study-path">${artifact.learning_path.map((step) => `<li><b>${step.order}</b><span>${escapeHtml(step.title)}<small>${escapeHtml(step.outcome)}</small></span></li>`).join("")}</ol></section>
    ${artifact.prerequisites.length ? `<section><h4>${tr(locale, "Explicit prerequisites", "明确的前置知识")}</h4><ul>${artifact.prerequisites.map((item) => `<li>${escapeHtml(item.title)}<small>${escapeHtml(item.relative_path)}</small></li>`).join("")}</ul></section>` : ""}
    <section><h4>${tr(locale, "Active practice · answers are never revealed", "主动练习 · 不展示答案")}</h4><div class="study-exercises">${artifact.exercises.map((exercise) => `<form data-study-practice data-run-id="${escapeHtml(artifact.run_id)}" data-exercise-id="${escapeHtml(exercise.exercise_id)}"><b>${escapeHtml(exercise.kind.replace("_", " "))}</b><p>${escapeHtml(exercise.prompt)}</p><small>${exercise.hints.map(escapeHtml).join(" · ")}</small><label>${tr(locale, "Your response", "你的回答")}<textarea name="answer" required maxlength="8000" rows="3" autocomplete="off"></textarea></label><label>${tr(locale, "Confidence", "信心程度")}<select name="confidence" required><option value="1">1</option><option value="2">2</option><option value="3" selected>3</option><option value="4">4</option><option value="5">5</option></select></label><button type="submit">${tr(locale, "CHECK LOCALLY", "本地检查")}</button><div class="study-attempt" role="status"></div></form>`).join("")}</div></section>
    <p class="fine">${tr(locale, "No answer key is present in this artifact. Progress notes remain preview-only.", "此产物不包含答案。进度笔记仍然仅供预览。")}</p>
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
    ${result.record_preview ? `<details><summary>${tr(locale, "Progress note preview · write disabled", "进度笔记预览 · 尚未写入")}</summary><pre>${escapeHtml(result.record_preview.markdown)}</pre></details>` : `<small>${tr(locale, "Complete another attempt before a progress preview is meaningful.", "再完成一次尝试后，进度预览才有意义。")}</small>`}
  </section>`;
}

export function workPlanMarkup(plan: WorkPlanArtifact, locale: Locale = "en"): string {
  return `<article class="work-result" aria-labelledby="work-plan-title">
    <header><div><p class="eyebrow">${tr(locale, "READ-ONLY WORK PLAN · VALIDATED", "只读工作计划 · 已验证")}</p><h3 id="work-plan-title">${escapeHtml(plan.goal)}</h3></div><span>${tr(locale, "NO EXECUTOR", "无执行器")}</span></header>
    <dl class="work-metrics"><div><dt>${tr(locale, "WORKSPACE", "工作区")}</dt><dd>${escapeHtml(plan.workspace_id)}</dd></div><div><dt>${tr(locale, "FILES", "文件")}</dt><dd>${plan.context_manifest.length}</dd></div><div><dt>${tr(locale, "TARGETS", "目标")}</dt><dd>${plan.target_files.length}</dd></div><div><dt>${tr(locale, "CLASS", "分类")}</dt><dd>${escapeHtml(plan.sensitivity)}</dd></div></dl>
    <section><h4>${tr(locale, "Bounded plan", "有界计划")}</h4><ol class="work-plan">${plan.plan_steps.map((step) => `<li><b>${step.order}</b><span>${escapeHtml(step.title)}<small>${escapeHtml(step.intent)}</small></span></li>`).join("")}</ol></section>
    <section><h4>${tr(locale, "Frozen context manifest", "冻结的上下文清单")}</h4><ul class="work-manifest">${plan.context_manifest.map((item) => `<li><code>${escapeHtml(item.relative_path)}</code><span>${escapeHtml(item.data_class)} · ${item.byte_count} bytes · ${item.included_in_handoff ? tr(locale, "selected", "已选择") : tr(locale, "reference only", "仅引用")}</span></li>`).join("")}</ul></section>
    ${plan.instruction_refs.length ? `<section><h4>${tr(locale, "Untrusted repository instructions", "不受信任的仓库指令")}</h4><p>${plan.instruction_refs.map(escapeHtml).join(" · ")}</p></section>` : ""}
    <ul class="work-warnings">${plan.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
    <button type="button" data-work-preview data-run-id="${escapeHtml(plan.run_id)}">${tr(locale, "REVIEW EXACT HANDOFF", "审阅精确交接包")}</button>
    <p class="fine">${tr(locale, "Plan only. No source file, shell, Git state, deployment, or message was changed.", "仅生成计划。源文件、Shell、Git 状态、部署和消息均未改变。")}</p>
  </article>`;
}

export function workHandoffMarkup(preview: WorkHandoffPreview, locale: Locale = "en"): string {
  return `<article class="work-result" aria-labelledby="work-handoff-title">
    <header><div><p class="eyebrow">${tr(locale, "EXACT LOCAL HANDOFF PREVIEW", "精确的本地交接预览")}</p><h3 id="work-handoff-title">${escapeHtml(preview.envelope.goal)}</h3></div><span>${tr(locale, "APPROVAL REQUIRED", "需要审批")}</span></header>
    <dl class="work-metrics"><div><dt>${tr(locale, "PACKAGE", "交接包")}</dt><dd>${preview.byte_count} B</dd></div><div><dt>${tr(locale, "CONTEXTS", "上下文")}</dt><dd>${preview.envelope.context.length}</dd></div><div><dt>HASH</dt><dd>${escapeHtml(preview.package_hash.slice(0, 12))}…</dd></div><div><dt>${tr(locale, "BOUNDARY", "边界")}</dt><dd>external</dd></div></dl>
    <section><h4>${tr(locale, "Exact sanitized contexts", "精确脱敏后的上下文")}</h4><div class="handoff-contexts">${preview.envelope.context.map((item) => `<details><summary><code>${escapeHtml(item.relative_path)}</code><span>${escapeHtml(item.data_class)} · ${item.byte_count} bytes · ${item.redactions.map(escapeHtml).join(", ") || tr(locale, "no redactions", "无脱敏项")}</span></summary><pre>${escapeHtml(item.content)}</pre></details>`).join("")}</div></section>
    <section><h4>${tr(locale, "Frozen contract", "冻结的契约")}</h4><p><b>${tr(locale, "Targets:", "目标：")}</b> ${preview.envelope.target_files.map(escapeHtml).join(" · ")}</p><p><b>${tr(locale, "Criteria:", "完成条件：")}</b> ${preview.envelope.completion_criteria.map(escapeHtml).join(" · ")}</p><p><b>${tr(locale, "Suggested only:", "仅建议：")}</b> ${preview.envelope.proposed_verification_commands.map(escapeHtml).join(" · ") || tr(locale, "No command proposed", "未建议命令")}</p></section>
    <div class="work-actions"><button type="button" data-work-export data-run-id="${escapeHtml(preview.envelope.run_id)}" data-approval-id="${escapeHtml(preview.approval.approval_id)}">${tr(locale, "APPROVE &amp; EXPORT LOCALLY", "批准并在本地导出")}</button><button class="secondary" type="button" data-work-reject data-approval-id="${escapeHtml(preview.approval.approval_id)}">${tr(locale, "REJECT", "拒绝")}</button></div>
    <p class="fine">${tr(locale, "Approval binds this package hash and every frozen resource version. Export stays in Restork's private data directory.", "审批绑定此交接包哈希和每个冻结的资源版本。导出文件留在 Restork 的私有数据目录。")}</p>
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
    <header><div><p class="eyebrow">${tr(locale, "PRIVATE HANDOFF EXPORTED", "私有交接包已导出")}</p><h3 id="work-export-title">${tr(locale, "External execution remains user-started", "外部执行仍由用户自行启动")}</h3></div><span>0600 LOCAL</span></header>
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
    <header><div><p class="eyebrow">${tr(locale, "IMPORTED RESULT · INDEPENDENT CHECK", "导入结果 · 独立检查")}</p><h3 id="work-verification-title">${escapeHtml(report.status.toUpperCase())}</h3></div><span>${report.completion_eligible ? tr(locale, "ELIGIBLE", "符合条件") : tr(locale, "USER ACTION", "需要用户处理")}</span></header>
    <section><h4>${tr(locale, "Filesystem evidence", "文件系统证据")}</h4><ul class="work-manifest">${evidence.map((item) => `<li><code>${escapeHtml(item.relative_path)}</code><span>${escapeHtml(item.status)} · ${escapeHtml(item.reason)}</span></li>`).join("") || `<li>${tr(locale, "No verifiable file evidence was supplied.", "未提供可验证的文件证据。")}</li>`}</ul></section>
    ${report.commands.length ? `<section><h4>${tr(locale, "Command claims", "命令声明")}</h4><p>${tr(locale, `${report.commands.length} claim(s) remain UNVERIFIED. Restork did not execute them.`, `${report.commands.length} 项声明仍未验证。Restork 没有执行这些命令。`)}</p></section>` : ""}
    ${report.unexpected_changes.length ? `<section><h4>${tr(locale, "Unexpected changes", "意外变更")}</h4><p>${report.unexpected_changes.map(escapeHtml).join(" · ")}</p></section>` : ""}
    ${report.task_update_preview ? `<section><h4>${tr(locale, "Markdown task update · preview only", "Markdown 任务更新 · 仅预览")}</h4><pre>${escapeHtml(report.task_update_preview.suggested_markdown)}</pre><p>${tr(locale, "Apply is disabled here; review it through the Core-owned Markdown task flow.", "此处禁止应用；请通过 Core 管理的 Markdown 任务流程进行审阅。")}</p></section>` : ""}
    <p class="fine">${tr(locale, "Verification", "验证")} ${escapeHtml(report.verification_id)} · ${formatDate(report.created_at, locale)}</p>
  </article>`;
}

export function errorText(error: unknown, locale: Locale = "en"): string {
  return error instanceof Error
    ? error.message
    : tr(locale, "Unexpected local error", "发生意外的本地错误");
}

function providerSetup(report: ProviderDiagnostic | null, locale: Locale): string {
  const setupCommand = report?.setup_command ?? "restorkd provider configure";
  const status = report?.status ?? "provider_unavailable";
  return `<section class="provider-console" aria-labelledby="provider-title">
    <header>
      <div><p class="eyebrow">MODEL ACCESS · KEYCHAIN</p><h2 id="provider-title">DeepSeek V4 Pro</h2></div>
      <span class="provider-status" data-provider-summary="${escapeHtml(status)}">${escapeHtml(status.replaceAll("_", " "))}</span>
    </header>
    <div class="provider-instructions">
      <p>${tr(locale, "Add or replace the API key in Terminal. The browser never receives it.", "请在终端添加或替换 API Key；浏览器永远不会接收它。")}</p>
      <code>${escapeHtml(setupCommand)}</code>
      <small>${tr(locale, "macOS Keychain prompts securely · restart Core after setup", "由 macOS Keychain 安全提示输入 · 配置后重启 Core")}</small>
    </div>
    <div class="provider-actions">
      <button type="button" data-provider-diagnostic="connect">${tr(locale, "TEST CONNECTION", "测试连接")}</button>
      <button type="button" class="quiet-button" data-provider-diagnostic="smoke">${tr(locale, "PUBLIC SMOKE TEST", "公开短句测试")}</button>
      <small>${tr(locale, "Connection checks /models. Smoke sends one fixed public sentence (max 16 tokens).", "连接测试仅检查 /models；短句测试只发送固定公开句子（最多 16 token）。")}</small>
    </div>
    <div id="provider-diagnostic-result" class="provider-diagnostic-host" role="status" aria-live="polite">
      ${report ? providerDiagnosticMarkup(report, locale) : `<p>${tr(locale, "Provider status is temporarily unavailable.", "暂时无法读取模型接入状态。")}</p>`}
    </div>
  </section>`;
}

function providerStatusMessage(status: ProviderDiagnostic["status"], locale: Locale): string {
  const messages: Record<ProviderDiagnostic["status"], [string, string]> = {
    not_configured: [
      "Run the secure terminal setup command to begin.",
      "请先运行安全的终端配置命令。",
    ],
    invalid_configuration: [
      "The non-secret provider configuration needs correction.",
      "非敏感的模型配置需要修正。",
    ],
    credential_missing: [
      "The API key is not available in macOS Keychain.",
      "macOS Keychain 中没有可用的 API Key。",
    ],
    ready: [
      "Configuration and Keychain metadata are ready; no network check has run.",
      "配置与 Keychain 元数据已就绪；尚未联网检查。",
    ],
    connected: [
      "Authentication succeeded and the configured model is available.",
      "认证成功，已配置模型可用。",
    ],
    manual_model_ready: [
      "This provider uses manual model entry; run the public smoke test to verify access.",
      "此供应商使用手动模型名称；可运行公开短句测试来验证接入。",
    ],
    smoke_passed: [
      "The fixed public low-token completion passed.",
      "固定公开短句的低 token 调用已通过。",
    ],
    authentication_failed: [
      "The provider rejected the API key; replace it from the native credential flow.",
      "供应商拒绝了此 API Key；请通过原生凭据流程替换。",
    ],
    insufficient_balance: [
      "The provider account has insufficient balance.",
      "供应商账户余额不足。",
    ],
    rate_limited: ["The provider rate limited this check.", "此次检查触发了供应商限流。"],
    timeout: ["The bounded provider check timed out.", "有界模型检查已超时。"],
    provider_unavailable: [
      "The provider service is temporarily unavailable.",
      "模型服务暂时不可用。",
    ],
    model_unavailable: [
      "The configured model is not available to this account.",
      "此账户暂时无法使用已配置模型。",
    ],
    invalid_response: [
      "The provider returned an unexpected diagnostic response.",
      "模型服务返回了非预期的诊断响应。",
    ],
    policy_denied: [
      "Restork's outbound policy denied this check.",
      "Restork 出站策略拒绝了此次检查。",
    ],
  };
  const [english, chinese] = messages[status];
  return tr(locale, english, chinese);
}

function overview(snapshot: DashboardSnapshot, locale: Locale): string {
  const run = snapshot.runs[0];
  const approval = snapshot.approvals.find((item) => item.decision === "pending");
  const tasks = snapshot.taskBoard.tasks.filter((task) => !task.completed).slice(0, 3);
  return `<div class="board">
    ${run ? runCard(run, locale) : emptyCard(tr(locale, "Runs", "运行"), tr(locale, "No runs yet. Choose Research, Study, or Work to begin.", "还没有运行。选择 Research、Study 或 Work 开始。"))}
    ${approval ? approvalCard(approval, locale) : emptyCard(tr(locale, "Approvals", "审批"), tr(locale, "No actions are waiting for approval.", "没有待审批动作。"))}
    <article class="paper-card"><header><h2>${tr(locale, "Markdown tasks", "Markdown 任务")}</h2><span class="ribbon work">CORE AUTHORITY</span></header>
      ${tasks.length ? tasks.map((task) => `<p class="task-row"><b>${escapeHtml(task.fields.priority ?? "P–")}</b>${escapeHtml(cleanTaskText(task.text))}<small>${escapeHtml(task.relative_path)} · L${task.line_number}</small></p>`).join("") : `<p class="empty">${snapshot.taskBoard.configured ? tr(locale, "No incomplete tasks.", "没有未完成任务。") : tr(locale, "Configure a Vault to show Markdown tasks.", "配置 Vault 后显示 Markdown 任务。")}</p>`}
    </article>
    <article class="paper-card radar-summary"><header><h2>${tr(locale, "Today's radar", "今日雷达")}</h2><span class="ribbon radar">VIA CORE</span></header>
      ${snapshot.radar.items.slice(0, 4).map(radarSummary).join("") || `<p class="empty">${snapshot.radar.configured ? tr(locale, "No Radar items right now.", "暂时没有 Radar 项。") : tr(locale, "Radar sources are not configured.", "Radar 尚未配置来源。")}</p>`}
    </article>
  </div>`;
}

function runsView(runs: RunListEntry[], page: PageInfo | undefined, locale: Locale): string {
  return `<article class="paper-card full-card"><header><h2>${tr(locale, "Runs", "运行")}</h2><span class="ribbon research">CORE STATE</span></header>
    <div class="split-view"><div><div class="item-list">${runs.map((run) => `<button type="button" class="list-item" data-run-id="${escapeHtml(run.summary.run_id)}"><b>${escapeHtml(run.summary.mode.toUpperCase())}</b><span>${escapeHtml(run.task?.goal ?? run.summary.task_id)}</span><small>${escapeHtml(run.summary.state)} · ${formatDate(run.summary.updated_at, locale)}</small></button>`).join("") || `<p class="empty">${tr(locale, "No runs.", "没有运行。")}</p>`}</div>${paginationControl("runs", page, locale)}</div><div id="run-detail" class="detail-placeholder">${tr(locale, "Select a run to inspect its events.", "选择一个运行查看事件。")}</div></div>
  </article>`;
}

function approvalsView(approvals: ApprovalRequest[], page: PageInfo | undefined, locale: Locale): string {
  return `<div class="stack">${approvals.map((approval) => approvalCard(approval, locale)).join("") || emptyCard(tr(locale, "Approvals", "审批"), tr(locale, "No approval records.", "没有审批记录。"))}${paginationControl("approvals", page, locale)}</div>`;
}

function tasksView(snapshot: DashboardSnapshot, locale: Locale): string {
  if (!snapshot.taskBoard.configured) return emptyCard(tr(locale, "Markdown tasks", "Markdown 任务"), tr(locale, "Configure a private Vault with --vault-dir. The browser receives no authority outside that Vault path.", "使用 --vault-dir 配置私有 Vault。浏览器不会持有 Vault 路径之外的权限。"));
  return `<article class="paper-card full-card"><header><h2>${tr(locale, "Markdown tasks", "Markdown 任务")}</h2><span class="ribbon work">MARKDOWN TRUTH</span></header>
    <form id="quick-task-form" class="quick-task-form"><label for="quick-task">${tr(locale, "Quick capture", "快速捕获")}</label><div><input id="quick-task" name="text" required maxlength="500" placeholder="${tr(locale, "One Markdown task", "一行 Markdown 任务")}"><select name="priority" aria-label="${tr(locale, "Priority", "优先级")}"><option value="">P–</option><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select><button type="submit">${tr(locale, "PREVIEW", "预览")}</button></div></form>
    <div class="task-list">${snapshot.taskBoard.tasks.map((task) => `<label class="task-row ${task.completed ? "is-complete" : ""}"><input type="checkbox" data-task-id="${escapeHtml(task.task_id)}" ${task.completed ? "checked" : ""}><span>${escapeHtml(cleanTaskText(task.text))}<small>${escapeHtml(task.relative_path)} · L${task.line_number} · ${escapeHtml(task.fields.due ?? tr(locale, "no due date", "无截止日期"))}</small></span></label>`).join("") || `<p class="empty">${tr(locale, "No tasks.", "没有任务。")}</p>`}</div>${paginationControl("tasks", snapshot.pagination?.tasks, locale)}
    <p class="fine">${tr(locale, "Checking or capturing creates an exact diff only. Core writes Markdown atomically after approval.", "勾选与捕获只生成精确 diff；Markdown 仅在审批后由 Core 原子写入。")}</p>
  </article>`;
}

function radarView(snapshot: DashboardSnapshot, locale: Locale): string {
  const lanes: Array<[RadarItem["lane"], string]> = [["my_stars", "My Stars"], ["trending", "Trending"], ["hn", "HN"], ["papers", "Papers"]];
  return `<article class="paper-card full-card"><header><h2>Radar</h2><span class="ribbon radar">CORE CONNECTORS</span></header>
    <div id="research-result" class="research-result-host" role="status"></div>
    ${snapshot.radar.configured ? `<div class="lanes">${lanes.map(([lane, label]) => `<section><h3>${label}</h3>${snapshot.radar.items.filter((item) => item.lane === lane).map((item) => radarItem(item, locale)).join("") || `<p class="empty">${tr(locale, "Empty", "暂无内容")}</p>`}</section>`).join("")}</div>${paginationControl("radar", snapshot.pagination?.radar, locale)}` : `<p class="empty">${tr(locale, "Radar sources are not configured; the browser never fetches them directly.", "Radar 来源尚未配置；浏览器不会自行联网。")}</p>`}
  </article>`;
}

function memoryView(snapshot: DashboardSnapshot, locale: Locale): string {
  if (!snapshot.memory) return emptyCard(tr(locale, "Four-layer memory", "四层记忆"), tr(locale, "The memory service is not configured.", "Memory service 尚未配置。"));
  const records = snapshot.memory.records.filter((record) => record.summary);
  return `<article class="paper-card full-card"><header><h2>${tr(locale, "Four-layer memory", "四层记忆")}</h2><span class="ribbon study">LOCAL</span></header>
    <div class="memory-layers">${snapshot.memory.architecture.map((layer) => `<section><b>${escapeHtml(layer.toUpperCase())}</b><strong>${snapshot.memory?.counts[layer] ?? 0}</strong></section>`).join("")}</div>
    <div class="memory-list">${records.map((record) => memoryRow(record, locale)).join("") || `<p class="empty">${tr(locale, "No user-approved memories have been saved.", "尚未保存用户批准的记忆。")}</p>`}</div>${paginationControl("memory", snapshot.pagination?.memory, locale)}
    <p class="fine">${tr(locale, "TTL/LRU removes only transient or rebuildable data, never Markdown, Profile, approvals, or audit records.", "TTL/LRU 只清理临时和可重建数据，不会清理 Markdown、Profile、审批或审计记录。")}</p>
  </article>`;
}

function runCard(run: RunListEntry, locale: Locale): string {
  const usage = run.budget?.usage;
  const budget = run.budget?.budget;
  const tokenRatio = usage && budget?.max_tokens ? Math.min(100, (usage.tokens / budget.max_tokens) * 100) : 0;
  return `<article class="paper-card run-card"><header><h2>${tr(locale, "Latest run", "最近运行")}</h2><span class="ribbon ${escapeHtml(run.summary.mode)}">${escapeHtml(run.summary.mode)}</span></header>
    <p class="run-title">${escapeHtml(run.task?.goal ?? run.summary.task_id)}</p>
    <progress class="progress-native" aria-label="Token budget ${tokenRatio.toFixed(0)}%" max="100" value="${tokenRatio.toFixed(1)}">${tokenRatio.toFixed(0)}%</progress>
    <p class="fine">${escapeHtml(run.summary.state)} · ${usage?.tokens ?? 0} tokens · ${formatDate(run.summary.updated_at, locale)}</p>
  </article>`;
}

function approvalCard(approval: ApprovalRequest, locale: Locale): string {
  const pending = approval.decision === "pending";
  const taskReady = approval.decision === "approved" && approval.action_kind === "task_write";
  return `<article class="paper-card approval-card"><header><h2>${tr(locale, "Approval request", "审批请求")}</h2><span class="ribbon approval">${escapeHtml(approval.decision)}</span></header>
    <p class="run-title">${escapeHtml(approval.human_summary)}</p>
    <dl class="metadata compact"><div><dt>${tr(locale, "TARGET", "目标")}</dt><dd>${escapeHtml(approval.canonical_scope)}</dd></div><div><dt>${tr(locale, "POLICY", "策略")}</dt><dd>${escapeHtml(approval.policy_version)}</dd></div><div><dt>${tr(locale, "DIGEST", "摘要")}</dt><dd>${escapeHtml(approval.action_digest.slice(0, 16))}…</dd></div><div><dt>${tr(locale, "EXPIRES", "失效时间")}</dt><dd>${formatDate(approval.expires_at, locale)}</dd></div></dl>
    ${pending ? `<div class="stamps"><button class="stamp approve" type="button" data-approval-id="${escapeHtml(approval.approval_id)}" data-action-kind="${escapeHtml(approval.action_kind)}" data-decision="approve">${tr(locale, "APPROVE", "批准")}</button><button class="stamp reject" type="button" data-approval-id="${escapeHtml(approval.approval_id)}" data-action-kind="${escapeHtml(approval.action_kind)}" data-decision="reject">${tr(locale, "REJECT", "拒绝")}</button></div>` : ""}
    ${taskReady ? `<div class="stamps"><button class="stamp approve" type="button" data-task-apply="${escapeHtml(approval.approval_id)}">${tr(locale, "APPLY TASK", "应用任务")}</button></div>` : ""}
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
    <article class="daily-card weather-card"><header><h2>${tr(locale, "Weather", "天气")}</h2><span>${escapeHtml(weather?.status ?? "offline")}</span></header>
      ${weather?.configured && weather.temperature_c !== null ? `<strong class="weather-temperature">${weather.temperature_c.toFixed(1)}°</strong><p>${escapeHtml(weather.condition)} · ${tr(locale, "feels like", "体感")} ${weather.apparent_temperature_c?.toFixed(1) ?? "–"}°</p><small>${escapeHtml(weather.location_label)} · ${tr(locale, "humidity", "湿度")} ${weather.relative_humidity_percent ?? "–"}%</small><em>${escapeHtml(weather.attribution)}</em>` : `<p class="daily-empty">${escapeHtml(weather?.message ?? tr(locale, "Configure weather in the private Profile; no network request is being made.", "在私有 Profile 中配置天气；当前没有网络请求。"))}</p>`}
      <button type="button" class="settings-trigger" data-weather-open>${weather?.configured ? tr(locale, "CHANGE LOCATION", "修改位置") : tr(locale, "SET UP WEATHER", "设置天气")}</button>
      <dialog id="weather-settings-dialog" class="settings-dialog weather-settings" aria-labelledby="weather-settings-title">
        <form id="weather-form">
          <header><strong id="weather-settings-title">${tr(locale, "WEATHER & LOCATION", "天气与位置")}</strong><button type="button" class="dialog-close" data-settings-close aria-label="${tr(locale, "Close weather settings", "关闭天气设置")}">×</button></header>
          <p>${tr(locale, "Enter a city, or explicitly request browser location. IP location is never used.", "输入城市即可，或主动请求浏览器定位；Restork 永不使用 IP 定位。")}</p>
          <label for="weather-query">${tr(locale, "City or region", "城市或地区")}</label><input id="weather-query" name="query" minlength="2" maxlength="120" required autocomplete="address-level2" placeholder="${tr(locale, "Guangzhou, China", "广州")}">
          <div class="weather-actions"><button type="submit">${tr(locale, "SEARCH & ENABLE", "搜索并启用")}</button><button type="button" class="quiet-button" data-weather-locate>${tr(locale, "USE CURRENT LOCATION", "使用当前位置")}</button>${weather?.configured ? `<button type="button" class="quiet-button" data-weather-disable>${tr(locale, "DISABLE", "停用")}</button>` : ""}</div>
          <small>${tr(locale, "Location permission is requested only after you press the button. Saved coordinates remain in the private Core Profile.", "仅在点击按钮后请求定位权限；保存的坐标只留在 Core 私有 Profile。")}</small>
        </form>
      </dialog>
    </article>
    <article class="daily-card calendar-card"><header><h2>${tr(locale, "Calendar", "日历")}</h2><span>${escapeHtml(calendar?.configured ? calendar.status : systemDaily ? "system" : "local")}</span></header>
      <ol>${calendar?.events.slice(0, 3).map((event) => `<li><time>${formatDate(event.starts_at, locale)}</time><b>${escapeHtml(event.title)}</b>${event.redacted ? `<small>${tr(locale, "PRIVATE · REDACTED", "私有 · 已脱敏")}</small>` : ""}</li>`).join("") || `<li class="daily-empty"><time>${escapeHtml(systemDaily?.local_date ?? new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", { dateStyle: "full" }).format(new Date()))}</time><b>${tr(locale, "Following this device's clock and time zone", "已跟随本设备时钟与时区")}</b><small>${tr(locale, "Event import is optional.", "事件导入是可选项。")}</small></li>`}</ol>
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
    <article class="daily-card music-card"><header><h2>${tr(locale, "Daily track", "每日一曲")}</h2><span>${escapeHtml(music?.status ?? "offline")}</span></header>
      ${recommendation ? `<div class="music-layout"><div class="disc" data-music-disc><div class="disc-label"><span>RESTORK</span><img id="music-cover" alt="${escapeHtml(tr(locale, `${recommendation.title} cover`, `${recommendation.title} 封面`))}" hidden></div></div><div class="music-copy"><strong>${escapeHtml(recommendation.title)}</strong><p>${escapeHtml([recommendation.artist, recommendation.album].filter(Boolean).join(" · ") || tr(locale, "Private playlist", "私有歌单"))}</p><small>${escapeHtml(recommendation.analysis)}</small><button type="button" data-music-toggle aria-pressed="false">${tr(locale, "ROTATE CD", "转动唱片")}</button></div></div>` : `<p class="daily-empty">${escapeHtml(music?.message ?? tr(locale, "Import a private JSON/CSV playlist to create daily recommendations.", "导入私有 JSON/CSV 歌单后生成每日推荐。"))}</p>`}
      <button type="button" class="settings-trigger" data-music-open>${music?.configured ? tr(locale, "REPLACE PLAYLIST", "更换歌单") : tr(locale, "IMPORT PLAYLIST", "导入歌单")}</button>
      <dialog id="music-settings-dialog" class="settings-dialog music-settings" aria-labelledby="music-settings-title">
        <form id="music-form">
          <header><strong id="music-settings-title">${tr(locale, "PRIVATE PLAYLIST", "私有歌单")}</strong><button type="button" class="dialog-close" data-settings-close aria-label="${tr(locale, "Close playlist settings", "关闭歌单设置")}">×</button></header>
          <p>${tr(locale, "Import JSON or CSV. The file stays in Core storage and is never uploaded by the Dashboard.", "导入 JSON 或 CSV；文件只进入 Core 私有存储，Dashboard 不会把它上传到第三方。")}</p>
          <label for="music-file">${tr(locale, "Playlist file", "歌单文件")}<input id="music-file" name="playlist" type="file" accept=".json,.csv,application/json,text/csv" required></label>
          <div class="music-actions"><button type="submit">${tr(locale, "IMPORT & ENABLE", "导入并启用")}</button>${music?.configured ? `<button type="button" class="quiet-button" data-music-disable>${tr(locale, "DISABLE & DELETE", "停用并删除")}</button>` : ""}</div>
          <small>${tr(locale, "Required field: title. Optional: item_id, artist, album, tags separated by |, and analysis. Maximum 2 MB.", "必填字段：title；可选字段：item_id、artist、album、用 | 分隔的 tags，以及 analysis。最大 2 MB。")}</small>
        </form>
      </dialog>
    </article>
  </section>`;
}

function radarItem(item: RadarItem, locale: Locale): string {
  return `<article class="radar-item"><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a><small>${escapeHtml(item.source)} · ${escapeHtml(item.state)}</small><div><button type="button" data-radar-id="${escapeHtml(item.item_id)}" data-radar-action="research">${tr(locale, "research", "研究")}</button><button type="button" data-radar-id="${escapeHtml(item.item_id)}" data-radar-action="read_later">${tr(locale, "read later", "稍后阅读")}</button><button type="button" data-radar-id="${escapeHtml(item.item_id)}" data-radar-action="make_task">${tr(locale, "make task", "建任务")}</button><button type="button" data-radar-id="${escapeHtml(item.item_id)}" data-radar-action="dismiss">${tr(locale, "dismiss", "忽略")}</button></div></article>`;
}

function radarSummary(item: RadarItem): string {
  return `<p class="radar-row"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.source)} · ${escapeHtml(item.lane)}</small></p>`;
}

function memoryRow(record: MemoryRecord, locale: Locale): string {
  return `<article><b>${escapeHtml(record.layer)} · ${escapeHtml(record.kind)}</b><p>${escapeHtml(record.summary)}</p><small>${escapeHtml(record.retention_class)} · ${escapeHtml(record.provenance)} · ${formatDate(record.updated_at, locale)}</small></article>`;
}

function paginationControl(
  kind: string,
  page: PageInfo | undefined,
  locale: Locale,
  label = tr(locale, "LOAD MORE", "加载更多"),
): string {
  if (!page?.has_more || !page.next_cursor) return "";
  return `<div class="pagination"><button type="button" data-page-kind="${escapeHtml(kind)}" data-page-cursor="${escapeHtml(page.next_cursor)}">${escapeHtml(label)}</button><small>${tr(locale, "A bounded page is loaded from Core.", "由 Core 按页加载，不会一次读取全部列表。")}</small></div>`;
}

function eventRow(event: RunEvent): string {
  return `<li><b>${escapeHtml(event.type)}</b><span>#${event.id}</span><code>${escapeHtml(JSON.stringify(event.data))}</code></li>`;
}

function navButton(view: string, icon: string, label: string, active: boolean, count?: number): string {
  return `<button class="nav-item ${active ? "is-active" : ""}" type="button" data-view="${view}"><b class="icon">${icon}</b>${label}${count ? `<em>${count}</em>` : ""}</button>`;
}

function modeButton(mode: string, icon: string, description: string): string {
  return `<button class="mode" type="button" data-mode="${mode}"><b class="icon ${mode}">${icon}</b><span><strong>${mode}</strong><small>${description}</small></span></button>`;
}

function metric(kind: string, label: string, value: string, note: string): string {
  return `<article class="metric ${kind}"><small>${label}</small><strong>${value}</strong><span>${escapeHtml(note)}</span></article>`;
}

function emptyCard(title: string, copy: string): string {
  return `<article class="paper-card"><header><h2>${escapeHtml(title)}</h2></header><p class="empty">${escapeHtml(copy)}</p></article>`;
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

function localeSwitch(locale: Locale): string {
  const target = alternateLocale(locale);
  const label = target === "zh-CN" ? "中文" : "EN";
  const accessible = tr(locale, "Switch to Chinese", "切换到英文");
  return `<button class="locale-switch" type="button" data-locale-switch="${target}" lang="${target}" aria-label="${accessible}">${label}</button>`;
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}
