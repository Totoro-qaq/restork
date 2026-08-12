import type { DashboardSnapshot, Mode } from "../api/types";
import type { Locale } from "../i18n";
import { tr } from "../i18n";
import { escapeMarkup } from "./dom";

const MODE_COPY: Record<Mode, { en: string; zh: string }> = {
  research: { en: "What do you want to research?", zh: "想研究什么？" },
  study: { en: "What do you want to learn?", zh: "想学什么？" },
  work: { en: "What work do you want to move forward?", zh: "想推进什么工作？" },
};

export function startPlaceholder(mode: Mode, locale: Locale): string {
  const copy = MODE_COPY[mode];
  return tr(locale, copy.en, copy.zh);
}

export function startWorkspaceMarkup(snapshot: DashboardSnapshot, locale: Locale, greeting: string): string {
  const active = snapshot.runs.filter((entry) => !["completed", "failed", "cancelled"].includes(entry.summary.state));
  const pending = snapshot.approvals.filter((approval) => approval.decision === "pending");
  const nextExpiry = pending
    .map((approval) => approval.expires_at)
    .filter(Boolean)
    .sort()[0];
  const vaultReady = snapshot.taskBoard.vault_configured ?? snapshot.taskBoard.configured;
  const providerRecords = snapshot.workspaceV2?.providers ?? [];
  const providerOptions = providerRecords.length
    ? providerRecords.map(({ provider }) => ({
        id: provider.profile_id,
        label: `${provider.display_name} · ${provider.model}`,
      }))
    : [{ id: "deepseek", label: snapshot.provider?.model ?? "DeepSeek" }];
  const modelReady = providerRecords.length > 0 || snapshot.provider?.config_present === true;
  const showExamples = snapshot.firstRun?.has_completed_run !== true;

  return `<section class="start-workspace" data-run-surface aria-labelledby="start-title">
    <div class="start-intro">
      <h2 id="start-title">${escapeMarkup(greeting)}</h2>
    </div>

    <div class="start-mode-row" role="group" aria-label="${tr(locale, "Task type", "任务类型")}">
      ${startModeButton("research", tr(locale, "Research", "研究"), true, locale)}
      ${startModeButton("study", tr(locale, "Study", "学习"), false, locale)}
      ${startModeButton("work", tr(locale, "Work", "工作"), false, locale)}
    </div>

    <form id="start-run-form" class="start-run-form" data-provider-ready="${String(modelReady)}">
      <input type="hidden" name="mode" value="research" data-start-mode-value>
      <div class="start-compose-row">
        <label class="sr-only" for="start-goal">${tr(locale, "Task", "任务")}</label>
        <textarea id="start-goal" name="goal" required maxlength="8000" rows="1"
          autocomplete="off" placeholder="${escapeMarkup(startPlaceholder("research", locale))}"></textarea>
        <button type="submit" data-start-submit>${tr(locale, "START TASK", "开始任务")}</button>
      </div>
      <div class="start-inline-options">
        <label>${tr(locale, "Model", "模型")}
          <select name="provider_profile_id" required>
            ${providerOptions.map((provider) => `<option value="${escapeMarkup(provider.id)}">${escapeMarkup(provider.label)}</option>`).join("")}
          </select>
        </label>
        <input type="hidden" name="context_data_class" value="public">
      </div>
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
        <p class="form-hint" data-start-workspace-status data-error-message="${tr(
          locale,
          "The folder picker did not finish. Try again.",
          "文件夹选择没有完成，请重试。",
        )}" role="status"></p>
        <label for="start-work-root" data-start-workspace-web>${tr(locale, "Project folder", "项目目录")}
          <input id="start-work-root" name="workspace_root" maxlength="4096" autocomplete="off" spellcheck="false">
        </label>
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

    <div data-run-wait></div>
    <section class="start-run-output" data-start-output hidden aria-label="${tr(locale, "Task output", "任务输出")}">
      <pre data-start-output-text></pre>
    </section>
    <div class="study-workspace" data-study-workspace aria-live="polite"></div>
    <div class="work-workspace" data-work-workspace aria-live="polite"></div>

    ${showExamples ? startExamples(locale) : startExamplesCompact(locale)}

    <div class="start-status-row" aria-label="${tr(locale, "Workspace status", "工作台状态")}">
      ${statusButton("settings", modelReady ? providerOptions[0]?.label ?? "" : tr(locale, "Choose a model", "选择模型"), locale)}
      ${statusButton("vault", vaultReady ? tr(locale, "Knowledge ready", "知识库已连接") : tr(locale, "Choose a knowledge library", "选择知识库"), locale)}
      ${statusButton("runs", tr(locale, `${active.length} active`, `${active.length} 个进行中`), locale)}
      ${statusButton("approvals", approvalStatusLabel(pending.length, nextExpiry, locale), locale, pending.length > 0)}
    </div>
  </section>`;
}

function approvalStatusLabel(count: number, expiresAt: string | undefined, locale: Locale): string {
  const base = tr(locale, `${count} awaiting review`, `${count} 个待审批`);
  if (!expiresAt || count === 0) return base;
  const deadline = new Date(expiresAt);
  if (Number.isNaN(deadline.valueOf())) return base;
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(deadline);
  return tr(locale, `${base} · next expires ${time}`, `${base} · 最近 ${time} 到期`);
}

function startModeButton(mode: Mode, label: string, active: boolean, locale: Locale): string {
  const icon = mode === "research" ? "R" : mode === "study" ? "S" : "W";
  const description = {
    research: tr(locale, "Research sources and keep citations", "查资料、核来源、留引用"),
    study: tr(locale, "Learning paths and active recall", "学习路径和主动回忆"),
    work: tr(locale, "Read-only plans and handoffs", "只读规划和交接包"),
  }[mode];
  return `<button type="button" data-start-mode="${mode}" data-placeholder="${escapeMarkup(startPlaceholder(mode, locale))}"
    aria-pressed="${String(active)}" class="${active ? "is-active" : ""}" tabindex="${active ? "0" : "-1"}">
      <b class="icon ${mode}" aria-hidden="true">${icon}</b>
      <span><strong>${escapeMarkup(label)}</strong><small>${escapeMarkup(description)}</small></span>
    </button>`;
}

function startExamplesCompact(locale: Locale): string {
  const examples: Array<[Mode, string, string]> = [
    ["research", "Compare how two papers explain the same claim and keep the citations.", "对比两篇论文对同一结论的说法，并保留引用"],
    ["study", "Build a practice set for distributed consistency from my notes.", "用我的笔记出一套分布式一致性练习"],
    ["work", "Draft this week's runs into a weekly report.", "把这周的运行记录起草成一份周报"],
  ];
  return `<details class="start-examples start-examples-compact" data-start-examples><summary>${tr(locale, "Examples", "示例")}</summary>
    ${examples.map(([mode, en, zh]) => {
      const goal = escapeMarkup(tr(locale, en, zh));
      return `<button type="button" data-start-example="${mode}" data-example-goal="${goal}">${goal}</button>`;
    }).join("")}
  </details>`;
}

function startExamples(locale: Locale): string {
  const examples: Array<[Mode, string, string]> = [
    ["research", "Compare how two papers explain the same claim and keep the citations.", "对比两篇论文对同一结论的说法，并保留引用"],
    ["study", "Build a practice set for distributed consistency from my notes.", "用我的笔记出一套分布式一致性练习"],
    ["work", "Draft this week's runs into a weekly report.", "把这周的运行记录起草成一份周报"],
  ];
  return `<div class="start-examples" data-start-examples><small>${tr(locale, "TRY ONE", "可以试试")}</small>
    ${examples.map(([mode, en, zh]) => {
      const goal = escapeMarkup(tr(locale, en, zh));
      return `<button type="button" data-start-example="${mode}" data-example-goal="${goal}">${goal}</button>`;
    }).join("")}
  </div>`;
}

function statusButton(view: string, label: string, locale: Locale, urgent = false): string {
  return `<button type="button" data-start-status-view="${view}" class="${urgent ? "is-urgent" : ""}"
    aria-label="${escapeMarkup(tr(locale, `Open ${view}`, `打开${label}`))}">${escapeMarkup(label)}</button>`;
}
