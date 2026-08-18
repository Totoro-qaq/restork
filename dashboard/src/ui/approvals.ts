import type { ApprovalRequest } from "../api/types";
import type { Locale } from "../i18n";
import { tr } from "../i18n";
import { escapeMarkup } from "./dom";

function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function decisionLabel(decision: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    pending: ["Waiting for confirmation", "等待确认"],
    approved: ["Confirmed", "已确认"],
    rejected: ["Not approved", "未批准"],
    expired: ["Expired", "已过期"],
  };
  const [en, zh] = labels[decision] ?? [decision, decision];
  return tr(locale, en, zh);
}

export function approvalSummary(approval: ApprovalRequest, locale: Locale): string {
  const summary = approval.human_summary.trim();
  if (locale !== "zh-CN" || /[\u3400-\u9fff]/u.test(summary)) return summary;

  const taskChange = summary.match(/^Apply the reviewed Markdown task change to (.+)\?$/u);
  if (taskChange) return `将刚才预览的 Markdown 任务改动写入「${taskChange[1]}」？`;

  const handoff = summary.match(/^Export reviewed Work handoff (.+) to private artifacts\?$/u);
  if (handoff) return `将工作交接稿「${handoff[1]}」导出到本地文件？`;

  const toolCall = summary.match(/^Allow `([^`]+)` with the reviewed normalized arguments\?$/u);
  if (toolCall) return `允许工具「${toolCall[1]}」使用刚才确认的参数运行？`;

  const sourceBackedNote = summary.match(/^Append a source-backed (?:evidence card|note) to (.+)$/u);
  if (sourceBackedNote) return `将带来源的内容写入「${sourceBackedNote[1]}」？`;

  if (/^Export reviewed (?:synthetic )?(?:Work )?handoff(?: to private artifacts)?$/u.test(summary)) {
    return "导出刚才确认的工作交接稿？";
  }
  return summary;
}

function approvalActions(approval: ApprovalRequest, locale: Locale): string {
  const id = escapeMarkup(approval.approval_id);
  const actionKind = escapeMarkup(approval.action_kind);
  if (approval.decision === "pending") {
    return `<div class="approval-actions">
      <button class="btn-primary approval-confirm-action" type="button" data-approval-id="${id}"
        data-action-kind="${actionKind}" data-decision="approve">${tr(locale, "Confirm", "确认")}</button>
      <button class="btn-secondary approval-reject-action" type="button" data-approval-id="${id}"
        data-action-kind="${actionKind}" data-decision="reject">${tr(locale, "Do not apply", "不执行")}</button>
    </div>`;
  }
  const taskReady = approval.decision === "approved"
    && (approval.action_kind === "task_write" || approval.action_kind === "vault_write");
  if (!taskReady) return "";
  return `<div class="approval-actions"><button class="btn-primary approval-apply-action" type="button"
    data-task-apply="${id}" data-action-kind="${actionKind}">
    ${tr(locale, "Apply write", "应用写入")}</button></div>`;
}

/** First layer answers what changes, where it lands, and when consent expires. */
export function approvalCardMarkup(
  approval: ApprovalRequest,
  locale: Locale,
  dashboardCard = false,
): string {
  const mark = approval.decision === "approved" ? "✓" : "!";
  const body = `<div class="approval-mark is-${escapeMarkup(approval.decision)}" data-approval-mark aria-hidden="true">${mark}</div>
    <p class="run-title approval-summary">${escapeMarkup(approvalSummary(approval, locale))}</p>
    <dl class="approval-impact">
      <div><dt>${tr(locale, "Destination", "写入位置")}</dt><dd>${escapeMarkup(approval.canonical_scope)}</dd></div>
      <div><dt>${tr(locale, "Expires", "有效期至")}</dt><dd><time datetime="${escapeMarkup(approval.expires_at)}">${escapeMarkup(formatDate(approval.expires_at, locale))}</time></dd></div>
    </dl>
    <details class="approval-technical"><summary>${tr(locale, "Technical details", "技术详情")}</summary>
      <dl class="metadata compact">
        <div><dt>${tr(locale, "Action", "动作类型")}</dt><dd>${escapeMarkup(approval.action_kind)}</dd></div>
        <div><dt>${tr(locale, "Risk", "风险类型")}</dt><dd>${escapeMarkup(approval.risk_class)}</dd></div>
        <div><dt>${tr(locale, "Rule version", "规则版本")}</dt><dd>${escapeMarkup(approval.policy_version)}</dd></div>
        <div><dt>${tr(locale, "Content fingerprint", "内容指纹")}</dt><dd><code>${escapeMarkup(approval.action_digest.slice(0, 16))}…</code></dd></div>
      </dl>
    </details>
    ${approvalActions(approval, locale)}`;
  return `<article class="paper-card approval-card approval-scene${dashboardCard ? " dashboard-card" : ""}"><header>
    <h2>${tr(locale, "Review before change", "更改前确认")}</h2>
    <span class="ribbon approval">${escapeMarkup(decisionLabel(approval.decision, locale))}</span></header>
    ${dashboardCard ? `<div class="dashboard-card-body">${body}</div>` : body}
  </article>`;
}
