import type {
  ApprovalRequest,
  DashboardSnapshot,
  MemoryRecord,
  RadarItem,
  RunEvent,
  RunListEntry,
} from "../api/types";

export function pairingMarkup(): string {
  return `
    <div class="aurora" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <section class="pairing" aria-labelledby="pairing-title">
      <p class="eyebrow">Restork · LOCAL-FIRST AGENT · LOOPBACK ONLY</p>
      <h1 id="pairing-title">RES<span>TORK</span></h1>
      <p class="pairing-copy">一个 Core，连接 <b>Research</b>、<b>Study</b> 与 <b>Work</b>。<br>
      One governed Core for research, study, and work.</p>
      <form id="pair-form" class="pair-form">
        <label for="pair-code">输入终端显示的一次性 Web 配对码</label>
        <div><input id="pair-code" name="code" required autocomplete="off" spellcheck="false"><button type="submit">PAIR</button></div>
      </form>
      <p id="pair-status" class="status" role="status">Token 仅保存在当前页面内存中。</p>
    </section>`;
}

export function workspaceMarkup(snapshot: DashboardSnapshot): string {
  const active = snapshot.runs.filter((entry) => !isTerminal(entry.summary.state));
  const pending = snapshot.approvals.filter((approval) => approval.decision === "pending");
  const incomplete = snapshot.taskBoard.tasks.filter((task) => !task.completed);
  const memories = snapshot.memory?.records.filter((record) => record.summary) ?? [];
  return `
    <div class="aurora" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <section class="dashboard" aria-label="Restork 本地工作台">
      <aside class="sidebar">
        <div class="brand"><strong>RES<span>TORK</span></strong><small>LOCAL-FIRST AGENT</small></div>
        <nav aria-label="主导航">
          ${navButton("overview", "R", "仪表盘", true)}
          ${navButton("runs", "›", "运行", false, active.length)}
          ${navButton("approvals", "✓", "审批", false, pending.length)}
          ${navButton("tasks", "□", "任务", false, incomplete.length)}
          ${navButton("radar", "◇", "雷达", false, snapshot.radar.items.length)}
          ${navButton("memory", "M", "记忆", false, memories.length)}
        </nav>
        <p class="sidebar-label">新建运行</p>
        ${modeButton("research", "R", "来源核查和证据卡片")}
        ${modeButton("study", "S", "学习路径和主动回忆")}
        ${modeButton("work", "W", "只读规划和交接包")}
        <p class="session">127.0.0.1 · LOCAL<br><b>CORE PAIRED</b></p>
      </aside>
      <main class="workspace">
        <header class="topline">
          <p>&gt; <span id="greeting">今天想研究、学习，还是完成一项工作？</span><span class="caret" aria-hidden="true"></span></p>
          <button class="quiet-button" id="refresh" type="button">REFRESH</button>
        </header>
        <p id="global-status" class="sr-only" role="status"></p>
        <section id="action-panel" class="action-panel" hidden>
          <form id="run-form">
            <input type="hidden" name="mode" id="run-mode" value="research">
            <label for="run-goal">目标 / Goal</label>
            <div><input id="run-goal" name="goal" required maxlength="1000"><button type="submit">START</button></div>
          </form>
          <p id="action-status" class="status" role="status"></p>
        </section>
        <section class="metrics" aria-label="运行概览">
          ${metric("research", "进行中运行", String(active.length), modeCounts(active))}
          ${metric("approval", "待审批", String(pending.length), "单次能力 · 到期失效")}
          ${metric("work", "Markdown 任务", String(incomplete.length), snapshot.taskBoard.configured ? "Markdown 为准" : "尚未配置 Vault")}
          ${metric("study", "记忆记录", String(memories.length), "四层 · 本地可控")}
        </section>
        ${dailyContext(snapshot)}
        <section class="view is-visible" data-view-panel="overview">${overview(snapshot)}</section>
        <section class="view" data-view-panel="runs" hidden>${runsView(snapshot.runs)}</section>
        <section class="view" data-view-panel="approvals" hidden>${approvalsView(snapshot.approvals)}</section>
        <section class="view" data-view-panel="tasks" hidden>${tasksView(snapshot)}</section>
        <section class="view" data-view-panel="radar" hidden>${radarView(snapshot)}</section>
        <section class="view" data-view-panel="memory" hidden>${memoryView(snapshot)}</section>
      </main>
    </section>`;
}

export function runEventsMarkup(run: RunListEntry, events: RunEvent[]): string {
  const summary = run.summary;
  return `
    <article class="paper-card detail-card">
      <header><h2>${escapeHtml(run.task?.goal ?? summary.task_id)}</h2><span class="ribbon ${escapeHtml(summary.mode)}">${escapeHtml(summary.mode)}</span></header>
      <dl class="metadata">
        <div><dt>RUN</dt><dd>${escapeHtml(summary.run_id)}</dd></div>
        <div><dt>STATE</dt><dd>${escapeHtml(summary.state)}</dd></div>
        <div><dt>UPDATED</dt><dd>${formatDate(summary.updated_at)}</dd></div>
        <div><dt>TOKENS</dt><dd>${String(run.budget?.usage.tokens ?? 0)}</dd></div>
      </dl>
      <ol class="event-list">${events.length ? events.map(eventRow).join("") : "<li>暂无新事件 / No new events.</li>"}</ol>
    </article>`;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected local error";
}

function overview(snapshot: DashboardSnapshot): string {
  const run = snapshot.runs[0];
  const approval = snapshot.approvals.find((item) => item.decision === "pending");
  const tasks = snapshot.taskBoard.tasks.filter((task) => !task.completed).slice(0, 3);
  return `<div class="board">
    ${run ? runCard(run) : emptyCard("运行", "还没有运行。选择 Research、Study 或 Work 开始。")}
    ${approval ? approvalCard(approval) : emptyCard("审批", "没有待审批动作。")}
    <article class="paper-card"><header><h2>Markdown 任务</h2><span class="ribbon work">CORE AUTHORITY</span></header>
      ${tasks.length ? tasks.map((task) => `<p class="task-row"><b>${escapeHtml(task.fields.priority ?? "P–")}</b>${escapeHtml(cleanTaskText(task.text))}<small>${escapeHtml(task.relative_path)} · L${task.line_number}</small></p>`).join("") : `<p class="empty">${snapshot.taskBoard.configured ? "没有未完成任务。" : "配置 Vault 后显示 Markdown 任务。"}</p>`}
    </article>
    <article class="paper-card radar-summary"><header><h2>今日雷达</h2><span class="ribbon radar">VIA CORE</span></header>
      ${snapshot.radar.items.slice(0, 4).map(radarSummary).join("") || `<p class="empty">${snapshot.radar.configured ? "暂时没有 Radar 项。" : "Radar 尚未配置来源。"}</p>`}
    </article>
  </div>`;
}

function runsView(runs: RunListEntry[]): string {
  return `<article class="paper-card full-card"><header><h2>运行 / Runs</h2><span class="ribbon research">CORE STATE</span></header>
    <div class="split-view"><div class="item-list">${runs.map((run) => `<button type="button" class="list-item" data-run-id="${escapeHtml(run.summary.run_id)}"><b>${escapeHtml(run.summary.mode.toUpperCase())}</b><span>${escapeHtml(run.task?.goal ?? run.summary.task_id)}</span><small>${escapeHtml(run.summary.state)} · ${formatDate(run.summary.updated_at)}</small></button>`).join("") || "<p class=\"empty\">没有运行。</p>"}</div><div id="run-detail" class="detail-placeholder">选择一个运行查看事件。</div></div>
  </article>`;
}

function approvalsView(approvals: ApprovalRequest[]): string {
  return `<div class="stack">${approvals.map(approvalCard).join("") || emptyCard("审批", "没有审批记录。")}</div>`;
}

function tasksView(snapshot: DashboardSnapshot): string {
  if (!snapshot.taskBoard.configured) return emptyCard("Markdown 任务", "使用 --vault-dir 配置私有 Vault。浏览器不会持有 Vault 路径之外的权限。");
  return `<article class="paper-card full-card"><header><h2>Markdown 任务</h2><span class="ribbon work">MARKDOWN TRUTH</span></header>
    <form id="quick-task-form" class="quick-task-form"><label for="quick-task">快速捕获 / Quick capture</label><div><input id="quick-task" name="text" required maxlength="500" placeholder="一行 Markdown 任务"><select name="priority" aria-label="优先级"><option value="">P–</option><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select><button type="submit">PREVIEW</button></div></form>
    <div class="task-list">${snapshot.taskBoard.tasks.map((task) => `<label class="task-row ${task.completed ? "is-complete" : ""}"><input type="checkbox" data-task-id="${escapeHtml(task.task_id)}" ${task.completed ? "checked" : ""}><span>${escapeHtml(cleanTaskText(task.text))}<small>${escapeHtml(task.relative_path)} · L${task.line_number} · ${escapeHtml(task.fields.due ?? "no due date")}</small></span></label>`).join("") || "<p class=\"empty\">没有任务。</p>"}</div>
    <p class="fine">勾选与捕获只生成精确 diff；Markdown 仅在审批后由 Core 原子写入。</p>
  </article>`;
}

function radarView(snapshot: DashboardSnapshot): string {
  const lanes: Array<[RadarItem["lane"], string]> = [["my_stars", "My Stars"], ["trending", "Trending"], ["hn", "HN"], ["papers", "Papers"]];
  return `<article class="paper-card full-card"><header><h2>Radar</h2><span class="ribbon radar">CORE CONNECTORS</span></header>
    ${snapshot.radar.configured ? `<div class="lanes">${lanes.map(([lane, label]) => `<section><h3>${label}</h3>${snapshot.radar.items.filter((item) => item.lane === lane).map(radarItem).join("") || "<p class=\"empty\">Empty</p>"}</section>`).join("")}</div>` : "<p class=\"empty\">Radar 来源尚未配置；浏览器不会自行联网。</p>"}
  </article>`;
}

function memoryView(snapshot: DashboardSnapshot): string {
  if (!snapshot.memory) return emptyCard("四层记忆", "Memory service 尚未配置。");
  const records = snapshot.memory.records.filter((record) => record.summary);
  return `<article class="paper-card full-card"><header><h2>四层记忆 / Memory</h2><span class="ribbon study">LOCAL</span></header>
    <div class="memory-layers">${snapshot.memory.architecture.map((layer) => `<section><b>${escapeHtml(layer.toUpperCase())}</b><strong>${snapshot.memory?.counts[layer] ?? 0}</strong></section>`).join("")}</div>
    <div class="memory-list">${records.map(memoryRow).join("") || "<p class=\"empty\">尚未保存用户批准的记忆。</p>"}</div>
    <p class="fine">TTL/LRU 只清理临时和可重建数据，不会清理 Markdown、Profile、审批或审计记录。</p>
  </article>`;
}

function runCard(run: RunListEntry): string {
  const usage = run.budget?.usage;
  const budget = run.budget?.budget;
  const tokenRatio = usage && budget?.max_tokens ? Math.min(100, (usage.tokens / budget.max_tokens) * 100) : 0;
  return `<article class="paper-card run-card"><header><h2>最近运行</h2><span class="ribbon ${escapeHtml(run.summary.mode)}">${escapeHtml(run.summary.mode)}</span></header>
    <p class="run-title">${escapeHtml(run.task?.goal ?? run.summary.task_id)}</p>
    <progress class="progress-native" aria-label="Token budget ${tokenRatio.toFixed(0)}%" max="100" value="${tokenRatio.toFixed(1)}">${tokenRatio.toFixed(0)}%</progress>
    <p class="fine">${escapeHtml(run.summary.state)} · ${usage?.tokens ?? 0} tokens · ${formatDate(run.summary.updated_at)}</p>
  </article>`;
}

function approvalCard(approval: ApprovalRequest): string {
  const pending = approval.decision === "pending";
  const taskReady = approval.decision === "approved" && approval.action_kind === "task_write";
  return `<article class="paper-card approval-card"><header><h2>审批请求</h2><span class="ribbon approval">${escapeHtml(approval.decision)}</span></header>
    <p class="run-title">${escapeHtml(approval.human_summary)}</p>
    <dl class="metadata compact"><div><dt>TARGET</dt><dd>${escapeHtml(approval.canonical_scope)}</dd></div><div><dt>POLICY</dt><dd>${escapeHtml(approval.policy_version)}</dd></div><div><dt>DIGEST</dt><dd>${escapeHtml(approval.action_digest.slice(0, 16))}…</dd></div><div><dt>EXPIRES</dt><dd>${formatDate(approval.expires_at)}</dd></div></dl>
    ${pending ? `<div class="stamps"><button class="stamp approve" type="button" data-approval-id="${escapeHtml(approval.approval_id)}" data-action-kind="${escapeHtml(approval.action_kind)}" data-decision="approve">APPROVE</button><button class="stamp reject" type="button" data-approval-id="${escapeHtml(approval.approval_id)}" data-action-kind="${escapeHtml(approval.action_kind)}" data-decision="reject">REJECT</button></div>` : ""}
    ${taskReady ? `<div class="stamps"><button class="stamp approve" type="button" data-task-apply="${escapeHtml(approval.approval_id)}">APPLY TASK</button></div>` : ""}
  </article>`;
}

function dailyContext(snapshot: DashboardSnapshot): string {
  const daily = snapshot.daily;
  const weather = daily?.weather;
  const calendar = daily?.calendar;
  const music = daily?.music;
  const recommendation = music?.recommendation;
  return `<section class="daily-context" aria-label="每日上下文">
    <article class="daily-card clock-card">
      <header><h2>本地时间</h2><span>LOCAL</span></header>
      <svg class="roman-clock" viewBox="0 0 100 100" role="img" aria-labelledby="clock-title clock-description">
        <title id="clock-title">Roman numeral local clock</title><desc id="clock-description">An analog clock marked I through XII.</desc>
        <circle cx="50" cy="50" r="45"></circle><circle class="clock-rule" cx="50" cy="50" r="39"></circle>
        <g class="clock-numerals"><text x="50" y="14">XII</text><text x="70" y="19">I</text><text x="84" y="33">II</text><text x="89" y="53">III</text><text x="84" y="73">IV</text><text x="70" y="87">V</text><text x="50" y="92">VI</text><text x="30" y="87">VII</text><text x="16" y="73">VIII</text><text x="11" y="53">IX</text><text x="16" y="33">X</text><text x="30" y="19">XI</text></g>
        <line data-clock-hour class="clock-hand hour-hand" x1="50" y1="53" x2="50" y2="29"></line><line data-clock-minute class="clock-hand minute-hand" x1="50" y1="54" x2="50" y2="19"></line><line data-clock-second class="clock-hand second-hand" x1="50" y1="57" x2="50" y2="16"></line><circle class="clock-pin" cx="50" cy="50" r="2.5"></circle>
      </svg><time id="clock-text">读取本地时间…</time>
    </article>
    <article class="daily-card weather-card"><header><h2>天气</h2><span>${escapeHtml(weather?.status ?? "offline")}</span></header>
      ${weather?.configured && weather.temperature_c !== null ? `<strong class="weather-temperature">${weather.temperature_c.toFixed(1)}°</strong><p>${escapeHtml(weather.condition)} · 体感 ${weather.apparent_temperature_c?.toFixed(1) ?? "–"}°</p><small>${escapeHtml(weather.location_label)} · 湿度 ${weather.relative_humidity_percent ?? "–"}%</small><em>${escapeHtml(weather.attribution)}</em>` : `<p class="daily-empty">${escapeHtml(weather?.message ?? "在私有 Profile 中配置天气；当前没有网络请求。")}</p>`}
    </article>
    <article class="daily-card calendar-card"><header><h2>日历</h2><span>${escapeHtml(calendar?.status ?? "offline")}</span></header>
      <ol>${calendar?.events.slice(0, 3).map((event) => `<li><time>${formatDate(event.starts_at)}</time><b>${escapeHtml(event.title)}</b>${event.redacted ? "<small>PRIVATE · REDACTED</small>" : ""}</li>`).join("") || `<li class="daily-empty">${escapeHtml(calendar?.message ?? "选择本地只读 ICS 文件。")}</li>`}</ol>
    </article>
    <article class="daily-card music-card"><header><h2>每日一曲</h2><span>${escapeHtml(music?.status ?? "offline")}</span></header>
      ${recommendation ? `<div class="music-layout"><div class="disc" data-music-disc><div class="disc-label"><span>RESTORK</span><img id="music-cover" alt="${escapeHtml(`${recommendation.title} cover`)}" hidden></div></div><div class="music-copy"><strong>${escapeHtml(recommendation.title)}</strong><p>${escapeHtml([recommendation.artist, recommendation.album].filter(Boolean).join(" · ") || "Private playlist")}</p><small>${escapeHtml(recommendation.analysis)}</small><button type="button" data-music-toggle aria-pressed="false">ROTATE CD</button></div></div>` : `<p class="daily-empty">${escapeHtml(music?.message ?? "导入私有 JSON/CSV 歌单后生成每日推荐。")}</p>`}
    </article>
  </section>`;
}

function radarItem(item: RadarItem): string {
  return `<article class="radar-item"><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a><small>${escapeHtml(item.source)} · ${escapeHtml(item.state)}</small><div><button type="button" data-radar-id="${escapeHtml(item.item_id)}" data-radar-action="research">research</button><button type="button" data-radar-id="${escapeHtml(item.item_id)}" data-radar-action="read_later">稍后</button><button type="button" data-radar-id="${escapeHtml(item.item_id)}" data-radar-action="make_task">建任务</button><button type="button" data-radar-id="${escapeHtml(item.item_id)}" data-radar-action="dismiss">忽略</button></div></article>`;
}

function radarSummary(item: RadarItem): string {
  return `<p class="radar-row"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.source)} · ${escapeHtml(item.lane)}</small></p>`;
}

function memoryRow(record: MemoryRecord): string {
  return `<article><b>${escapeHtml(record.layer)} · ${escapeHtml(record.kind)}</b><p>${escapeHtml(record.summary)}</p><small>${escapeHtml(record.retention_class)} · ${escapeHtml(record.provenance)} · ${formatDate(record.updated_at)}</small></article>`;
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

function modeCounts(runs: RunListEntry[]): string {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.summary.mode, (counts.get(run.summary.mode) ?? 0) + 1);
  return [...counts].map(([mode, count]) => `${mode} ×${count}`).join(" · ") || "等待新任务";
}

function cleanTaskText(value: string): string {
  return value.replace(/\s+#todo\b/, "").replace(/\s+\[[a-z]+:: [^\]]+\]/g, "").replace(/\s+\^restork-[a-z0-9]+$/, "").trim();
}

function isTerminal(state: string): boolean {
  return ["completed", "failed", "cancelled"].includes(state);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}
