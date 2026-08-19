import { tr } from "../i18n";
import type { Locale } from "../i18n";
import type { DashboardApi, RunEvent } from "../api/types";
import { assistantStreamMarkup } from "../ui/render";
import { offerRunSummaryAfterCompletion } from "./start";

/**
 * 开始页运行反馈三件套：取消按钮/输出区复位、提交忙碌态、事件流绘制。
 * 从 main.ts 抽出，遵守文件行数预算并让学习/工作模式的展示策略有独立归属。
 */
export function prepareStartRunFeedback(surface: ParentNode, runId: string): void {
  const cancel = surface.querySelector<HTMLButtonElement>("[data-start-cancel]");
  const output = surface.querySelector<HTMLElement>("[data-start-output]");
  const text = surface.querySelector<HTMLElement>("[data-start-output-text]");
  if (cancel) {
    cancel.hidden = false;
    cancel.disabled = false;
    cancel.dataset.runId = runId;
  }
  if (output) output.hidden = true;
  if (text) text.replaceChildren();
}

export function setStartRunBusy(surface: ParentNode, busy: boolean): void {
  const form = surface instanceof HTMLFormElement
    ? surface
    : surface.querySelector<HTMLFormElement>("#start-run-form");
  if (!form) return;
  form.dataset.runBusy = String(busy);
  form.setAttribute("aria-busy", String(busy));
  const submit = form.querySelector<HTMLButtonElement>("[data-start-submit]");
  if (!submit) return;
  const disabled = busy || form.dataset.modeBlocked === "true";
  submit.disabled = disabled;
  submit.setAttribute("aria-disabled", String(disabled));
}

export function paintStartRunEvent(
  surface: ParentNode,
  event: RunEvent,
  locale: Locale,
  api?: DashboardApi,
  runId?: string,
  mode?: string,
): void {
  const status = surface.querySelector<HTMLElement>("[data-run-status]");
  const cancel = surface.querySelector<HTMLButtonElement>("[data-start-cancel]");
  const output = surface.querySelector<HTMLElement>("[data-start-output]");
  const text = surface.querySelector<HTMLElement>("[data-start-output-text]");
  // 学习模式的诊断输出是结构化 JSON，原始 token 流不进入界面；
  // 进度由等待卡呈现，问题由诊断表单呈现
  const isStructuredStudy = mode === "study";
  if (event.type === "assistant.delta" && typeof event.data.content === "string" && text && !isStructuredStudy) {
    if (output) output.hidden = false;
    text.append(document.createTextNode(event.data.content));
  }
  if (event.type === "run.completed") {
    if (status) status.textContent = tr(locale, "Task completed.", "任务已完成。");
    if (cancel) cancel.hidden = true;
    if (isStructuredStudy) {
      if (output) output.hidden = true;
      if (text) text.replaceChildren();
    } else if (text?.textContent) {
      const upgraded = assistantStreamMarkup(text.textContent, locale);
      if (!upgraded.startsWith("<pre")) text.outerHTML = upgraded;
    }
    setStartRunBusy(surface, false);
    const completedId = runId ?? cancel?.dataset.runId;
    if (completedId && api?.loadRunSummary) {
      void offerRunSummaryAfterCompletion(surface, locale, () => api.loadRunSummary!(completedId));
    }
  } else if (event.type === "run.failed") {
    if (status) status.textContent = tr(
      locale,
      "Task failed. Open Runs for details.",
      "任务未完成，可到「运行」查看原因。",
    );
    if (cancel) cancel.hidden = true;
    setStartRunBusy(surface, false);
  } else if (event.type === "run.cancelled") {
    if (status) status.textContent = tr(locale, "Task stopped.", "任务已停止。");
    if (cancel) cancel.hidden = true;
    setStartRunBusy(surface, false);
  }
}
