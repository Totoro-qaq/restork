import type { DashboardSnapshot, Mode, PendingRunSummary, RunListEntry } from "../api/types";
import type { Locale } from "../i18n";
import { tr } from "../i18n";
import { escapeMarkup } from "./dom";

const MODE_HINTS: Record<Mode, { en: string; zh: string }> = {
  research: {
    en: "Research: sources listed; citations kept in the conclusion.",
    zh: "查资料：附来源清单，结论保留引用。",
  },
  study: {
    en: "Study: draws on your notes; every write is confirmed before it lands.",
    zh: "学知识：会引用你的笔记，写入前逐条确认。",
  },
  work: {
    en: "Work: plan first, then act; every step leaves a local trail.",
    zh: "推进工作：先给计划再动手，每一步在本机留痕。",
  },
};

export function modeHint(mode: Mode, locale: Locale): string {
  const copy = MODE_HINTS[mode];
  return tr(locale, copy.en, copy.zh);
}

export function startPlaceholder(locale: Locale): string {
  return tr(locale, "One sentence.", "用一句话说清。");
}

export function startWorkspaceMarkup(snapshot: DashboardSnapshot, locale: Locale): string {
  const active = snapshot.runs.filter((entry) => !["completed", "failed", "cancelled"].includes(entry.summary.state));
  const pending = snapshot.approvals.filter((approval) => approval.decision === "pending");
  const nextExpiry = pending
    .map((approval) => approval.expires_at)
    .filter(Boolean)
    .sort()[0];
  const vaultReady = snapshot.taskBoard.vault_configured ?? snapshot.taskBoard.configured;
  const providerOptions = startProviderOptions(snapshot);
  const modelReady = providerOptions.length > 0;
  const suggestion = snapshot.pendingRunSummaries?.[0];
  const resumeRun = active[0] ?? null;
  // While a task is still running, the start page points at that run; the
  // run-summary prompt only appears once nothing else is in flight.
  const reviewSuggestion = resumeRun ? undefined : suggestion;

  return `<section class="start-workspace" data-run-surface aria-labelledby="start-title">
    <div class="start-intro">
      ${startHeading(reviewSuggestion, resumeRun, locale)}
    </div>

    <form id="start-run-form" class="start-run-form composer" data-provider-ready="${String(modelReady)}">
      <input type="hidden" name="mode" value="research" data-start-mode-value>
      <label class="sr-only" for="start-goal">${tr(locale, "Task", "任务")}</label>
      <textarea id="start-goal" name="goal" required maxlength="8000" rows="1"
        autocomplete="off" placeholder="${escapeMarkup(startPlaceholder(locale))}"></textarea>
      <div class="composer-foot">
        <div class="start-mode-row" role="radiogroup" aria-label="${tr(locale, "Task type", "任务类型")}">
          ${startModeButton("research", tr(locale, "Research", "查资料"), true, locale)}
          ${startModeButton("study", tr(locale, "Study", "学知识"), false, locale)}
          ${startModeButton("work", tr(locale, "Work", "推进工作"), false, locale)}
        </div>
        <div class="foot-right">
          ${providerOptions.length ? `<label class="model-pick">${tr(locale, "Model", "模型")}
            <select name="provider_profile_id" required aria-label="${tr(locale, "Model", "模型")}">
              ${providerOptions.map((provider) => `<option value="${escapeMarkup(provider.id)}">${escapeMarkup(provider.label)}</option>`).join("")}
            </select>
          </label>` : ""}
          <input type="hidden" name="context_data_class" value="public">
          <button type="submit" class="btn-primary" data-start-submit
            data-connect-label="${escapeMarkup(tr(locale, "Connect a model first", "先连接模型"))}">${tr(locale, "Start task", "开始任务")}</button>
        </div>
      </div>
      <div class="skill-suggest-row" data-skill-suggest data-empty="true" aria-live="polite"></div>
      <p class="form-hint start-inline-fix" data-start-provider-hint ${modelReady ? "hidden" : ""}><span>${tr(
        locale,
        "Connect a model first. Your task text will stay here.",
        "请先连接模型；这里的任务内容会保留。",
      )}</span><button type="button" data-start-open-settings>${tr(locale, "Open Settings", "打开设置")}</button></p>

      <div class="start-progressive-fields" data-start-study-fields hidden>
        <label for="start-study-note">${tr(locale, "Optional note to begin with", "可选：从哪篇笔记开始")}</label>
        <input id="start-study-note" name="target_note" maxlength="1024" placeholder="Study/Topic.md">
        <p class="form-hint start-inline-fix" data-start-study-hint ${vaultReady ? "hidden" : ""}><span>${tr(
          locale,
          "Choose a knowledge library before starting this task.",
          "开始这项任务前，请先选择知识库。",
        )}</span><button type="button" data-start-open-vault>${tr(locale, "Choose folder", "选择文件夹")}</button></p>
      </div>

      <fieldset class="start-progressive-fields" data-start-work-fields hidden>
        <legend>${tr(locale, "Work context", "工作范围")}</legend>
        <input type="hidden" name="workspace_grant_id">
        <div class="start-workspace-picker" data-start-workspace-native hidden>
          <button type="button" data-start-choose-workspace>${tr(locale, "Choose project folder", "选择项目文件夹")}</button>
          <span data-start-workspace-label data-empty-label="${tr(locale, "No folder selected", "尚未选择文件夹")}">${tr(locale, "No folder selected", "尚未选择文件夹")}</span>
        </div>
        <div class="start-workspace-grant" data-start-workspace-web>
          <p>${tr(
            locale,
            "A browser cannot hold a folder grant — that protects the directory on this device. Use the desktop app to choose one, or continue with a relative path.",
            "浏览器版拿不到文件夹授权（这是保护你的目录）。用桌面版选择，或先填相对路径继续。",
          )}</p>
          <p class="start-inline-fix">
            <a class="btn-secondary" data-start-download-desktop href="https://github.com/Totoro-qaq/restork/releases">${tr(locale, "Download desktop app", "下载桌面版")}</a>
            <button type="button" class="quiet-button" data-start-workspace-readonly>${tr(locale, "Continue read-only", "继续只读")}</button>
          </p>
          <details class="source-build-fallback">
            <summary>${tr(locale, "Source-build fallback: absolute path", "源码运行备用：填写绝对路径")}</summary>
            <label for="start-work-root">${tr(locale, "Project folder", "项目目录")}
              <input id="start-work-root" name="workspace_root" maxlength="4096" autocomplete="off" spellcheck="false">
            </label>
          </details>
        </div>
        <p class="form-hint" data-start-workspace-status data-error-message="${tr(
          locale,
          "The folder picker did not finish. Try again.",
          "文件夹选择没有完成，请重试。",
        )}" role="status"></p>
        <label for="start-work-targets">${tr(locale, "Files to focus on (optional), one per line", "重点文件（可选），每行一个")}</label>
        <textarea id="start-work-targets" name="target_files" maxlength="16000" rows="3" spellcheck="false"></textarea>
        <details>
          <summary>${tr(locale, "More context", "更多说明")}</summary>
          <label for="start-work-context">${tr(locale, "Reference files", "参考文件")}</label>
          <textarea id="start-work-context" name="context_files" maxlength="30000" rows="2"></textarea>
          <label for="start-work-constraints">${tr(locale, "Constraints", "约束")}</label>
          <textarea id="start-work-constraints" name="constraints" maxlength="30000" rows="2"></textarea>
          <textarea name="non_goals" hidden></textarea>
          <textarea name="verification_commands" hidden></textarea>
        </details>
      </fieldset>

      <div class="start-run-feedback">
        <p class="start-run-status" data-run-status role="status"></p>
        <button type="button" data-start-cancel hidden>${tr(locale, "Stop task", "停止任务")}</button>
      </div>
    </form>
    <p class="mode-hint" data-mode-hint>${escapeMarkup(modeHint("research", locale))}</p>

    <div data-run-wait></div>
    <section class="start-run-output" data-start-output hidden aria-label="${tr(locale, "Task output", "任务输出")}">
      <pre data-start-output-text></pre>
    </section>
    ${modeWorkspaceMarkup("study")}
    ${modeWorkspaceMarkup("work")}
    ${runSummaryHostMarkup(reviewSuggestion, locale)}

    ${startExamples(locale)}

    ${startStatusRow(vaultReady, active.length, pending.length, nextExpiry, locale)}
  </section>`;
}

function clipTopic(text: string, max = 18): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function startHeading(
  suggestion: PendingRunSummary | undefined,
  resumeRun: RunListEntry | null,
  locale: Locale,
): string {
  const reviewTail = tr(locale, "Pick it back up?", "要接着写吗？");
  const reviewLink = tr(locale, "Open that run", "打开那次运行");
  if (suggestion) {
    const topic = clipTopic(suggestion.summary);
    const title = tr(locale, `Last time «${topic}» still needs review.`, `上次的《${topic}》还没复盘。`);
    return `<h2 id="start-title" class="start-context" data-start-title-static>${escapeMarkup(title)}<span class="quiet">${escapeMarkup(reviewTail)}</span></h2>
      <p class="start-context-sub"><button type="button" class="textlink" data-start-resume-run>${escapeMarkup(reviewLink)}</button></p>`;
  }
  if (resumeRun) {
    const goal = resumeRun.task?.goal ?? "";
    const topic = clipTopic(goal || resumeRun.summary.run_id);
    const title = tr(locale, `«${topic}» is still running.`, `《${topic}》还在进行中。`);
    const tail = tr(locale, "Check on it?", "要去看看吗？");
    return `<h2 id="start-title" class="start-context" data-start-title-static>${escapeMarkup(title)}<span class="quiet">${escapeMarkup(tail)}</span></h2>
      <p class="start-context-sub"><button type="button" class="textlink" data-start-resume-run>${escapeMarkup(reviewLink)}</button></p>`;
  }
  return `<h2 id="start-title">${escapeMarkup(tr(locale, "What do you want to do now?", "现在想做什么？"))}</h2>`;
}

export function fillRunSummaryHost(
  host: HTMLElement,
  suggestion: PendingRunSummary | null,
  locale: Locale,
): void {
  if (!suggestion) {
    host.hidden = true;
    host.removeAttribute("data-run-id");
    host.replaceChildren();
    return;
  }
  host.hidden = false;
  host.dataset.runId = suggestion.run_id;
  host.setAttribute("aria-live", "polite");
  host.setAttribute("aria-label", tr(locale, "Optional run summary", "可选运行摘要"));
  host.innerHTML = runSummaryCardInner(suggestion, locale);
}

function startProviderOptions(snapshot: DashboardSnapshot): Array<{ id: string; label: string }> {
  const records = snapshot.workspaceV2?.providers ?? [];
  if (records.length) {
    return records.map(({ provider }) => ({
      id: provider.profile_id,
      label: `${provider.display_name} · ${provider.model}`,
    }));
  }
  if (snapshot.provider?.config_present) {
    return [{
      id: snapshot.provider.provider,
      label: snapshot.provider.model || snapshot.provider.provider,
    }];
  }
  return [];
}

function startStatusRow(
  vaultReady: boolean,
  activeCount: number,
  pendingCount: number,
  nextExpiry: string | undefined,
  locale: Locale,
): string {
  const items: string[] = [];
  if (!vaultReady) {
    items.push(statusButton(
      "vault",
      tr(locale, "Choose a knowledge library", "选择知识库"),
      tr(locale, "Open knowledge library", "打开知识库"),
    ));
  }
  if (activeCount > 0) {
    items.push(statusButton(
      "runs",
      tr(locale, `${activeCount} active`, `${activeCount} 个进行中`),
      tr(locale, "Open runs", "打开运行"),
    ));
  }
  if (pendingCount > 0) {
    items.push(statusButton(
      "approvals",
      approvalStatusLabel(pendingCount, nextExpiry, locale),
      tr(locale, "Open approvals", "打开审批"),
      true,
    ));
  }
  if (!items.length) return "";
  return `<div class="start-status-row" aria-label="${tr(locale, "Workspace status", "工作台状态")}">${items.join("")}</div>`;
}

function approvalStatusLabel(count: number, expiresAt: string | undefined, locale: Locale): string {
  const base = tr(locale, `${count} awaiting confirmation`, `${count} 个待确认写入`);
  if (!expiresAt) return base;
  const deadline = new Date(expiresAt);
  if (Number.isNaN(deadline.valueOf())) return base;
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(deadline);
  return tr(locale, `${base} · next expires ${time}`, `${base} · ${time} 到期`);
}

export function modeWorkspaceMarkup(kind: "study" | "work", id?: string): string {
  const idAttr = id ? ` id="${id}"` : "";
  return `<div${idAttr} class="${kind}-workspace" data-${kind}-workspace><p class="sr-only" data-live-note role="status" aria-live="polite"></p><div data-workspace-result></div></div>`;
}

function startModeButton(mode: Mode, label: string, active: boolean, locale: Locale): string {
  return `<button type="button" role="radio" data-start-mode="${mode}"
    data-placeholder="${escapeMarkup(startPlaceholder(locale))}"
    data-hint="${escapeMarkup(modeHint(mode, locale))}"
    aria-checked="${String(active)}" class="${active ? "is-active" : ""}" tabindex="${active ? "0" : "-1"}">${escapeMarkup(label)}</button>`;
}

function startExamples(locale: Locale): string {
  const examples: Array<[Mode, string, string]> = [
    ["research", "Compare how two papers explain the same claim and keep the citations.", "对比两篇论文对同一结论的说法，并保留引用"],
    ["study", "Build a practice set for distributed consistency from my notes.", "用我的笔记出一套分布式一致性练习"],
    ["work", "Draft this week's runs into a weekly report.", "把这周的运行记录起草成一份周报"],
  ];
  return `<div class="start-examples" data-start-examples>
    ${examples.map(([mode, en, zh]) => {
      const goal = escapeMarkup(tr(locale, en, zh));
      return `<button type="button" data-start-example="${mode}" data-example-goal="${goal}">${goal}</button>`;
    }).join("")}
  </div>`;
}

function statusButton(view: string, label: string, ariaLabel: string, urgent = false): string {
  const tone = view === "runs" ? "tone-live" : "tone-attn";
  return `<button type="button" data-start-status-view="${view}" class="${tone} ${urgent ? "is-urgent" : ""}"
    aria-label="${escapeMarkup(ariaLabel)}"><i aria-hidden="true"></i>${escapeMarkup(label)}</button>`;
}

function runSummaryHostMarkup(suggestion: PendingRunSummary | undefined, locale: Locale): string {
  if (!suggestion) {
    return `<aside class="start-run-summary" data-start-run-summary hidden></aside>`;
  }
  return `<aside class="start-run-summary" data-start-run-summary data-run-id="${escapeMarkup(suggestion.run_id)}"
    aria-live="polite" aria-label="${tr(locale, "Optional run summary", "可选运行摘要")}">${runSummaryCardInner(suggestion, locale)}</aside>`;
}

function runSummaryCardInner(suggestion: PendingRunSummary, locale: Locale): string {
  return `<h3>${tr(locale, "Save this conclusion as a run summary?", "要把这次结论记成一条运行摘要吗？")}</h3>
    <blockquote><p>${escapeMarkup(suggestion.summary)}</p></blockquote>
    <p class="fine">${tr(
      locale,
      "Not saved unless you choose. Closing discards it now; ignoring it expires in 24 hours. Never writes your name or habits.",
      "默认不记。点「不用了」立即丢弃；不操作则 24 小时后过期。不会写入称呼或习惯。",
    )}</p>
    <p class="start-run-summary-status" data-start-summary-status role="status"></p>
    <div class="start-run-summary-actions">
      <button type="button" data-start-summary-dismiss>${tr(locale, "Don't save", "不用了")}</button>
      <button type="button" data-start-summary-accept>${tr(locale, "Save summary", "记下这条")}</button>
    </div>`;
}
