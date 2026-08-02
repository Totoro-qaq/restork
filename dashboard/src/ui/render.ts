import type {
  ApprovalRequest,
  DashboardSnapshot,
  MemoryRecord,
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
        </nav>
        <p class="sidebar-label">${tr(locale, "New run", "新建运行")}</p>
        ${modeButton("research", "R", tr(locale, "Source checks and evidence cards", "来源核查和证据卡片"))}
        ${modeButton("study", "S", tr(locale, "Learning paths and active recall", "学习路径和主动回忆"))}
        ${modeButton("work", "W", tr(locale, "Read-only plans and handoffs", "只读规划和交接包"))}
        <p class="session">127.0.0.1 · LOCAL<br><b>CORE PAIRED</b></p>
      </aside>
      <main class="workspace">
        <header class="topline">
          <p>&gt; <span id="greeting">${tr(locale, "What will you research, study, or finish today?", "今天想研究、学习，还是完成一项工作？")}</span><span class="caret" aria-hidden="true"></span></p>
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
        ${dailyContext(snapshot, locale)}
        <section class="view is-visible" data-view-panel="overview">${overview(snapshot, locale)}</section>
        <section class="view" data-view-panel="runs" hidden>${runsView(snapshot.runs, locale)}</section>
        <section class="view" data-view-panel="approvals" hidden>${approvalsView(snapshot.approvals, locale)}</section>
        <section class="view" data-view-panel="tasks" hidden>${tasksView(snapshot, locale)}</section>
        <section class="view" data-view-panel="radar" hidden>${radarView(snapshot, locale)}</section>
        <section class="view" data-view-panel="memory" hidden>${memoryView(snapshot, locale)}</section>
      </main>
    </section>`;
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

export function runEventsMarkup(
  run: RunListEntry,
  events: RunEvent[],
  locale: Locale = "en",
): string {
  const summary = run.summary;
  return `
    <article class="paper-card detail-card">
      <header><h2>${escapeHtml(run.task?.goal ?? summary.task_id)}</h2><span class="ribbon ${escapeHtml(summary.mode)}">${escapeHtml(summary.mode)}</span></header>
      <dl class="metadata">
        <div><dt>RUN</dt><dd>${escapeHtml(summary.run_id)}</dd></div>
        <div><dt>STATE</dt><dd>${escapeHtml(summary.state)}</dd></div>
        <div><dt>${tr(locale, "UPDATED", "更新时间")}</dt><dd>${formatDate(summary.updated_at, locale)}</dd></div>
        <div><dt>TOKENS</dt><dd>${String(run.budget?.usage.tokens ?? 0)}</dd></div>
      </dl>
      <ol class="event-list">${events.length ? events.map(eventRow).join("") : `<li>${tr(locale, "No new events.", "暂无新事件。")}</li>`}</ol>
    </article>`;
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

function runsView(runs: RunListEntry[], locale: Locale): string {
  return `<article class="paper-card full-card"><header><h2>${tr(locale, "Runs", "运行")}</h2><span class="ribbon research">CORE STATE</span></header>
    <div class="split-view"><div class="item-list">${runs.map((run) => `<button type="button" class="list-item" data-run-id="${escapeHtml(run.summary.run_id)}"><b>${escapeHtml(run.summary.mode.toUpperCase())}</b><span>${escapeHtml(run.task?.goal ?? run.summary.task_id)}</span><small>${escapeHtml(run.summary.state)} · ${formatDate(run.summary.updated_at, locale)}</small></button>`).join("") || `<p class="empty">${tr(locale, "No runs.", "没有运行。")}</p>`}</div><div id="run-detail" class="detail-placeholder">${tr(locale, "Select a run to inspect its events.", "选择一个运行查看事件。")}</div></div>
  </article>`;
}

function approvalsView(approvals: ApprovalRequest[], locale: Locale): string {
  return `<div class="stack">${approvals.map((approval) => approvalCard(approval, locale)).join("") || emptyCard(tr(locale, "Approvals", "审批"), tr(locale, "No approval records.", "没有审批记录。"))}</div>`;
}

function tasksView(snapshot: DashboardSnapshot, locale: Locale): string {
  if (!snapshot.taskBoard.configured) return emptyCard(tr(locale, "Markdown tasks", "Markdown 任务"), tr(locale, "Configure a private Vault with --vault-dir. The browser receives no authority outside that Vault path.", "使用 --vault-dir 配置私有 Vault。浏览器不会持有 Vault 路径之外的权限。"));
  return `<article class="paper-card full-card"><header><h2>${tr(locale, "Markdown tasks", "Markdown 任务")}</h2><span class="ribbon work">MARKDOWN TRUTH</span></header>
    <form id="quick-task-form" class="quick-task-form"><label for="quick-task">${tr(locale, "Quick capture", "快速捕获")}</label><div><input id="quick-task" name="text" required maxlength="500" placeholder="${tr(locale, "One Markdown task", "一行 Markdown 任务")}"><select name="priority" aria-label="${tr(locale, "Priority", "优先级")}"><option value="">P–</option><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select><button type="submit">${tr(locale, "PREVIEW", "预览")}</button></div></form>
    <div class="task-list">${snapshot.taskBoard.tasks.map((task) => `<label class="task-row ${task.completed ? "is-complete" : ""}"><input type="checkbox" data-task-id="${escapeHtml(task.task_id)}" ${task.completed ? "checked" : ""}><span>${escapeHtml(cleanTaskText(task.text))}<small>${escapeHtml(task.relative_path)} · L${task.line_number} · ${escapeHtml(task.fields.due ?? tr(locale, "no due date", "无截止日期"))}</small></span></label>`).join("") || `<p class="empty">${tr(locale, "No tasks.", "没有任务。")}</p>`}</div>
    <p class="fine">${tr(locale, "Checking or capturing creates an exact diff only. Core writes Markdown atomically after approval.", "勾选与捕获只生成精确 diff；Markdown 仅在审批后由 Core 原子写入。")}</p>
  </article>`;
}

function radarView(snapshot: DashboardSnapshot, locale: Locale): string {
  const lanes: Array<[RadarItem["lane"], string]> = [["my_stars", "My Stars"], ["trending", "Trending"], ["hn", "HN"], ["papers", "Papers"]];
  return `<article class="paper-card full-card"><header><h2>Radar</h2><span class="ribbon radar">CORE CONNECTORS</span></header>
    <div id="research-result" class="research-result-host" role="status"></div>
    ${snapshot.radar.configured ? `<div class="lanes">${lanes.map(([lane, label]) => `<section><h3>${label}</h3>${snapshot.radar.items.filter((item) => item.lane === lane).map((item) => radarItem(item, locale)).join("") || `<p class="empty">${tr(locale, "Empty", "暂无内容")}</p>`}</section>`).join("")}</div>` : `<p class="empty">${tr(locale, "Radar sources are not configured; the browser never fetches them directly.", "Radar 来源尚未配置；浏览器不会自行联网。")}</p>`}
  </article>`;
}

function memoryView(snapshot: DashboardSnapshot, locale: Locale): string {
  if (!snapshot.memory) return emptyCard(tr(locale, "Four-layer memory", "四层记忆"), tr(locale, "The memory service is not configured.", "Memory service 尚未配置。"));
  const records = snapshot.memory.records.filter((record) => record.summary);
  return `<article class="paper-card full-card"><header><h2>${tr(locale, "Four-layer memory", "四层记忆")}</h2><span class="ribbon study">LOCAL</span></header>
    <div class="memory-layers">${snapshot.memory.architecture.map((layer) => `<section><b>${escapeHtml(layer.toUpperCase())}</b><strong>${snapshot.memory?.counts[layer] ?? 0}</strong></section>`).join("")}</div>
    <div class="memory-list">${records.map((record) => memoryRow(record, locale)).join("") || `<p class="empty">${tr(locale, "No user-approved memories have been saved.", "尚未保存用户批准的记忆。")}</p>`}</div>
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
  const weather = daily?.weather;
  const calendar = daily?.calendar;
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
      <details class="weather-settings"><summary>${weather?.configured ? tr(locale, "CHANGE LOCATION", "修改位置") : tr(locale, "SET UP WEATHER", "设置天气")}</summary>
        <form id="weather-form">
          <p>${tr(locale, "Manual entry only. Restork never requests browser or IP location.", "仅支持手动填写；Restork 不请求浏览器定位或 IP 定位。")}</p>
          <label for="weather-label">${tr(locale, "Display name", "显示名称")}</label><input id="weather-label" name="label" maxlength="120" required autocomplete="off" placeholder="${tr(locale, "Home", "家")}">
          <div class="weather-coordinates"><label for="weather-latitude">${tr(locale, "Latitude", "纬度")}<input id="weather-latitude" name="latitude" type="number" min="-90" max="90" step="any" required inputmode="decimal" autocomplete="off"></label><label for="weather-longitude">${tr(locale, "Longitude", "经度")}<input id="weather-longitude" name="longitude" type="number" min="-180" max="180" step="any" required inputmode="decimal" autocomplete="off"></label></div>
          <div class="weather-actions"><button type="submit">${tr(locale, "SAVE & ENABLE", "保存并启用")}</button>${weather?.configured ? `<button type="button" class="quiet-button" data-weather-disable>${tr(locale, "DISABLE", "停用")}</button>` : ""}</div>
          <small>${tr(locale, "Coordinates stay in the private Core Profile and are sent only to Open-Meteo when enabled.", "坐标保存在 Core 的私有 Profile 中，仅在启用后发送给 Open-Meteo。")}</small>
        </form>
      </details>
    </article>
    <article class="daily-card calendar-card"><header><h2>${tr(locale, "Calendar", "日历")}</h2><span>${escapeHtml(calendar?.status ?? "offline")}</span></header>
      <ol>${calendar?.events.slice(0, 3).map((event) => `<li><time>${formatDate(event.starts_at, locale)}</time><b>${escapeHtml(event.title)}</b>${event.redacted ? `<small>${tr(locale, "PRIVATE · REDACTED", "私有 · 已脱敏")}</small>` : ""}</li>`).join("") || `<li class="daily-empty">${escapeHtml(calendar?.message ?? tr(locale, "Select a local read-only ICS file.", "选择本地只读 ICS 文件。"))}</li>`}</ol>
    </article>
    <article class="daily-card music-card"><header><h2>${tr(locale, "Daily track", "每日一曲")}</h2><span>${escapeHtml(music?.status ?? "offline")}</span></header>
      ${recommendation ? `<div class="music-layout"><div class="disc" data-music-disc><div class="disc-label"><span>RESTORK</span><img id="music-cover" alt="${escapeHtml(tr(locale, `${recommendation.title} cover`, `${recommendation.title} 封面`))}" hidden></div></div><div class="music-copy"><strong>${escapeHtml(recommendation.title)}</strong><p>${escapeHtml([recommendation.artist, recommendation.album].filter(Boolean).join(" · ") || tr(locale, "Private playlist", "私有歌单"))}</p><small>${escapeHtml(recommendation.analysis)}</small><button type="button" data-music-toggle aria-pressed="false">${tr(locale, "ROTATE CD", "转动唱片")}</button></div></div>` : `<p class="daily-empty">${escapeHtml(music?.message ?? tr(locale, "Import a private JSON/CSV playlist to create daily recommendations.", "导入私有 JSON/CSV 歌单后生成每日推荐。"))}</p>`}
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
