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

function isLegacyResearchPath(value: string): boolean {
  return /^Restork Research - run-[a-z0-9]+\.md$/iu.test(value.trim());
}

function approvalDestination(approval: ApprovalRequest, locale: Locale): string {
  if (isLegacyResearchPath(approval.canonical_scope)) {
    return tr(locale, "Vault / Research note", "知识库 / 研究笔记");
  }
  return approval.canonical_scope;
}

function actionLabel(actionKind: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    vault_write: ["Save a note to the vault", "保存知识库笔记"],
    task_write: ["Update a vault task", "更新知识库任务"],
    handoff_export: ["Export a reviewed handoff", "导出已确认的交接稿"],
  };
  const [en, zh] = labels[actionKind] ?? ["Apply the reviewed change", "执行已确认的更改"];
  return tr(locale, en, zh);
}

function impactLabel(riskClass: string, locale: Locale): string {
  const labels: Record<string, [string, string]> = {
    local_file_write: [
      "Creates or updates one Markdown file in the local vault",
      "将在本地知识库中创建或更新一个 Markdown 文件",
    ],
    local_write: [
      "Creates or updates local data",
      "将在本地创建或更新数据",
    ],
    external_effect: [
      "Runs an action that can change data outside this task",
      "将执行可能改变任务外部数据的操作",
    ],
  };
  const [en, zh] = labels[riskClass] ?? [
    "Applies the change shown in the preview",
    "将应用刚才预览的更改",
  ];
  return tr(locale, en, zh);
}

export function approvalSummary(approval: ApprovalRequest, locale: Locale): string {
  const summary = approval.human_summary.trim();
  const taskChange = summary.match(/^Apply the reviewed Markdown task change to (.+)\?$/u);
  if (taskChange && isLegacyResearchPath(taskChange[1])) {
    return tr(
      locale,
      "Save the research note you just reviewed to the vault?",
      "将刚才预览的研究笔记存入知识库？",
    );
  }
  if (locale !== "zh-CN" || /[\u3400-\u9fff]/u.test(summary)) return summary;

  if (taskChange) {
    return `将刚才预览的 Markdown 任务改动写入「${taskChange[1]}」？`;
  }

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
  const body = `<p class="run-title approval-summary">${escapeMarkup(approvalSummary(approval, locale))}</p>
    <dl class="approval-impact">
      <div><dt>${tr(locale, "Destination", "写入位置")}</dt><dd>${escapeMarkup(approvalDestination(approval, locale))}</dd></div>
      <div><dt>${tr(locale, "Expires", "有效期至")}</dt><dd><time datetime="${escapeMarkup(approval.expires_at)}">${escapeMarkup(formatDate(approval.expires_at, locale))}</time></dd></div>
    </dl>
    <details class="approval-technical"><summary>${tr(locale, "Safety details", "安全说明")}</summary>
      <dl class="metadata compact">
        <div><dt>${tr(locale, "Action", "操作")}</dt><dd>${escapeMarkup(actionLabel(approval.action_kind, locale))}</dd></div>
        <div><dt>${tr(locale, "Impact", "影响")}</dt><dd>${escapeMarkup(impactLabel(approval.risk_class, locale))}</dd></div>
        <div><dt>${tr(locale, "Preview integrity", "预览一致性")}</dt><dd>${tr(locale, "Locked to the content you just reviewed", "已锁定为你刚才预览的内容")}</dd></div>
      </dl>
    </details>
    ${approvalActions(approval, locale)}`;
  const heading = approval.action_kind === "vault_write"
    ? tr(locale, "Save to vault", "保存到知识库")
    : tr(locale, "Review before change", "更改前确认");
  return `<article class="paper-card approval-card approval-scene${dashboardCard ? " dashboard-card" : ""}"><header>
    <h2>${heading}</h2>
    <span class="ribbon approval">${escapeMarkup(decisionLabel(approval.decision, locale))}</span></header>
    ${dashboardCard ? `<div class="dashboard-card-body">${body}</div>` : body}
  </article>`;
}
