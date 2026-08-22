import { tr } from "../i18n";
import type { Locale } from "../i18n";
import type { DashboardApi, RunEvent } from "../api/types";
import { assistantStreamMarkup } from "../ui/render";
import { safeMarkdownPreview } from "../ui/markdown";
import { offerRunSummaryAfterCompletion } from "./start";

/**
 * 开始页运行反馈三件套：取消按钮/输出区复位、提交忙碌态、事件流绘制。
 * 从 main.ts 抽出，遵守文件行数预算并让学习/工作模式的展示策略有独立归属。
 *
 * 输出区规则：
 * - 散文回答实时以 Markdown 渲染（不再显示原始 # 号）
 * - 结构化负载（JSON / 代码块包裹的 JSON）是内部协议，原始 token 流不进入界面；
 *   完成时通过 assistantStreamMarkup 升级成卡片，未识别的保持隐藏
 */

// 原始输出缓冲：渲染后的 DOM 无法还原 markdown 源，结构化判定与完成升级都用它
const rawOutputBuffers = new WeakMap<HTMLElement, string>();

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
  const body = surface.querySelector<HTMLElement>("[data-start-output-body]");
  if (body) body.scrollTop = 0;
  if (text) {
    text.replaceChildren();
    rawOutputBuffers.delete(text);
    delete text.dataset.structured;
    delete text.dataset.structuredChecked;
  }
}

/** 用户没有主动上滑时，流式输出保持贴底，避免只能看到开头。 */
function isPinnedToBottom(body: HTMLElement): boolean {
  return body.scrollHeight - body.scrollTop - body.clientHeight <= 32;
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
  const body = surface.querySelector<HTMLElement>("[data-start-output-body]");
  const text = surface.querySelector<HTMLElement>("[data-start-output-text]");
  const isStructuredStudy = mode === "study";
  if (event.type === "assistant.delta" && typeof event.data.content === "string" && text && body) {
    const chunk = event.data.content;
    if (!text.dataset.structuredChecked) {
      text.dataset.structuredChecked = "1";
      const lead = chunk.trimStart();
      if (lead.startsWith("{") || lead.startsWith("```")) text.dataset.structured = "1";
    }
    const raw = (rawOutputBuffers.get(text) ?? "") + chunk;
    rawOutputBuffers.set(text, raw);
    if (!isStructuredStudy && text.dataset.structured !== "1") {
      const pinned = isPinnedToBottom(body);
      text.innerHTML = safeMarkdownPreview(raw);
      if (output) output.hidden = false;
      if (pinned) body.scrollTop = body.scrollHeight;
    }
  }
  if (event.type === "run.completed") {
    if (status) status.textContent = tr(locale, "Task completed.", "任务已完成。");
    if (cancel) cancel.hidden = true;
    const raw = text ? (rawOutputBuffers.get(text) ?? "") : "";
    const structured = text?.dataset.structured === "1";
    if (raw && text && body) {
      const hide = (): void => {
        if (output) output.hidden = true;
        text.replaceChildren();
        rawOutputBuffers.delete(text);
      };
      if (isStructuredStudy) {
        // 学习模式的结果由诊断表单呈现，输出区一律不展示
        hide();
      } else {
        const upgraded = assistantStreamMarkup(raw, locale);
        if (upgraded.startsWith("<pre") && structured) {
          // 未识别的结构化负载不展示原文；结果由模式专属界面（计划卡等）呈现
          hide();
        } else {
          // 升级后的卡片写进渲染容器内部，容器本身留在滚动区里，
          // 否则下一次运行就找不到 [data-start-output-text] 了。
          text.innerHTML = upgraded;
          if (output) output.hidden = false;
          body.scrollTop = 0;
        }
      }
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
  } else if (event.type === "run.stopped") {
    const retryable = event.data.state === "retryable";
    if (status) status.textContent = retryable
      ? tr(locale, "Task paused. You can retry it from Runs.", "任务已暂停，可到「运行」中重新尝试。")
      : tr(locale, "Task stopped. Open Runs for details.", "任务已停止，可到「运行」查看原因。");
    if (cancel) cancel.hidden = true;
    setStartRunBusy(surface, false);
  }
}
