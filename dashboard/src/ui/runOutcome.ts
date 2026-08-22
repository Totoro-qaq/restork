import type { RunEvent, RunListEntry } from "../api/types";
import type { Locale } from "../i18n";
import { tr } from "../i18n";
import { canRetryRun } from "../runState";

export function providerFailureLabel(kind: string, locale: Locale): string | null {
  const labels: Record<string, [string, string]> = {
    rate_limited: ["The model service is busy. Try again shortly.", "模型服务请求较多，请稍后重试。"],
    timeout: ["The model response timed out.", "这次模型响应超时。"],
    provider_unavailable: ["The model service could not be reached.", "这次未能连接到模型服务。"],
    model_unavailable: ["This model is not currently available from the provider.", "当前模型暂时不可用，或服务端不接受该模型名称。"],
    invalid_response: ["Restork could not read the model response.", "模型返回了 Restork 暂时无法读取的响应。"],
    incomplete: ["The model response ended before it was complete.", "模型输出在完成前中断。"],
    structured_output_invalid: ["The model returned an unreadable structured result.", "模型返回的结构化结果无法读取。"],
    web_search_not_executed: ["The requested web search was not executed.", "模型没有执行所需的联网搜索。"],
    sources_missing: ["The model response did not include the required sources.", "模型回答缺少任务要求的来源。"],
  };
  const label = labels[kind];
  return label ? tr(locale, label[0], label[1]) : null;
}

function stopReasonLabel(reason: string | null, locale: Locale, events: RunEvent[]): string {
  const providerFailure = [...events].reverse().find((event) => event.type === "provider.failed");
  const kind = providerFailure && typeof providerFailure.data.kind === "string"
    ? providerFailure.data.kind
    : "";
  const specific = kind ? providerFailureLabel(kind, locale) : null;
  if (specific) return specific;
  const labels: Record<string, [string, string]> = {
    provider_unavailable: ["The model call did not complete.", "这次模型调用没有完成。"],
    provider_authentication: ["The model needs valid account credentials.", "模型账号需要重新验证。"],
    provider_configuration: ["The model configuration needs attention.", "模型配置需要处理。"],
    runtime_error: ["The local runtime stopped unexpectedly.", "本地运行环境意外停止。"],
    cancelled: ["The task was stopped by the user.", "任务已由用户停止。"],
  };
  const label = reason ? labels[reason] : undefined;
  return label
    ? tr(locale, label[0], label[1])
    : tr(locale, "This task is no longer running.", "这项任务已不再运行。");
}

export function runOutcomeMarkup(run: RunListEntry, events: RunEvent[], locale: Locale): string {
  if (!canRetryRun(run.summary.state)) return "";
  return `<section class="run-outcome is-retryable" role="status"><div><strong>${tr(
    locale,
    "Task paused — ready to retry",
    "任务已暂停，可以重试",
  )}</strong><p>${escapeHtml(stopReasonLabel(run.summary.stop_reason, locale, events))} ${tr(
    locale,
    "The completed work is kept locally.",
    "已经完成的过程会保留在本机。",
  )}</p></div><button type="button" data-run-retry data-run-id="${escapeHtml(run.summary.run_id)}">${tr(
    locale,
    "Retry task",
    "重新尝试",
  )}</button></section>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
