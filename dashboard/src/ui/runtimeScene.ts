import type { RunEvent } from "../api/types";
import type { Locale } from "../i18n";
import { tr } from "../i18n";
import { escapeMarkup } from "./dom";

export type AgentWaitStage =
  | "prepare"
  | "sources"
  | "model"
  | "verify"
  | "retry"
  | "complete"
  | "blocked"
  | "error";

export interface AgentWaitNextStep {
  action: "retry" | "settings" | "vault";
  label: string;
}

export interface RuntimeActivity {
  source?: string;
  tool?: string;
}

export interface RuntimeSceneDetail {
  reason?: string;
  next?: AgentWaitNextStep;
  activity?: RuntimeActivity;
  cancellable?: boolean;
}

const ACTIVE_STAGES = new Set<AgentWaitStage>([
  "prepare",
  "sources",
  "model",
  "verify",
  "retry",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(data: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = text(data[key]);
    if (value) return value;
  }
  return "";
}

function clipped(value: string, max = 72): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Keep the last concrete source/tool names seen in the event stream. The
 * runtime scene never invents a source or tool when Core did not name one.
 */
export function runtimeActivityForEvent(
  current: RuntimeActivity,
  event: RunEvent,
): RuntimeActivity {
  const source = event.type.startsWith("research.source_")
    ? firstText(event.data, ["source", "source_name", "provider", "url"])
    : "";
  const tool = event.type.startsWith("tool.")
    ? firstText(event.data, ["tool", "tool_name"])
    : "";
  return {
    ...(current.source ? { source: current.source } : {}),
    ...(current.tool ? { tool: current.tool } : {}),
    ...(source ? { source: clipped(source) } : {}),
    ...(tool ? { tool: clipped(tool) } : {}),
  };
}

function sourceCopy(stage: AgentWaitStage, activity: RuntimeActivity, locale: Locale): string {
  if (activity.source) return activity.source;
  if (stage === "prepare") return tr(locale, "Not opened yet", "尚未开始读取");
  if (stage === "sources") return tr(locale, "Reading the selected sources", "正在读取已选资料");
  return tr(locale, "Selected context for this task", "这项任务选中的上下文");
}

function toolCopy(stage: AgentWaitStage, activity: RuntimeActivity, locale: Locale): string {
  if (activity.tool) return activity.tool;
  if (stage === "sources") return tr(locale, "Waiting for tool activity", "等待工具返回");
  return tr(locale, "No tool reported yet", "尚未报告工具调用");
}

export function agentWaitMarkup(
  stage: AgentWaitStage,
  locale: Locale = "en",
  detail?: RuntimeSceneDetail,
): string {
  const current = stage === "retry" ? 2 : Math.min(
    ["prepare", "sources", "model", "verify", "complete"].indexOf(stage),
    4,
  );
  const labels = [
    tr(locale, "Selected context", "已选上下文"),
    tr(locale, "Sources & tools", "来源与工具"),
    tr(locale, "Drafting", "整理内容"),
    tr(locale, "Final check", "最后核对"),
  ];
  const status = {
    prepare: tr(locale, "Preparing the notes, files and messages selected for this task…", "正在准备这项任务选中的笔记、文件和消息…"),
    sources: tr(locale, "Reading the sources and tool results you allowed…", "正在读取你允许使用的资料与工具结果…"),
    model: tr(locale, "The selected model is drafting the result…", "所选模型正在整理结果…"),
    verify: tr(locale, "Checking sources, format and permissions…", "正在核对来源、格式与权限…"),
    retry: tr(locale, "The last attempt did not finish. Trying again…", "上一次没有完成，正在重试…"),
    complete: tr(locale, "Done. The result is ready to review.", "完成了，结果可以查看。"),
    blocked: tr(locale, "The task did not start.", "任务未能启动。"),
    error: tr(locale, "The task stopped before completion.", "任务没有完成。"),
  }[stage];
  const busy = ACTIVE_STAGES.has(stage);
  const activity = detail?.activity ?? {};
  const reason = detail?.reason && !busy
    ? `<p class="agent-wait-reason">${escapeMarkup(detail.reason)}</p>`
    : "";
  const next = detail?.next && !busy
    ? `<p class="start-inline-fix"><button type="button" class="btn-secondary" data-wait-next="${detail.next.action}">${escapeMarkup(detail.next.label)}</button></p>`
    : "";
  const facts = busy ? `<dl class="runtime-facts">
      <div><dt>${tr(locale, "Stage", "当前阶段")}</dt><dd>${escapeMarkup(status)}</dd></div>
      <div><dt>${tr(locale, "Sources", "资料")}</dt><dd>${escapeMarkup(sourceCopy(stage, activity, locale))}</dd></div>
      <div><dt>${tr(locale, "Tool", "工具")}</dt><dd>${escapeMarkup(toolCopy(stage, activity, locale))}</dd></div>
      <div><dt>${tr(locale, "Elapsed", "已用时间")}</dt><dd><time data-runtime-elapsed>0:00</time></dd></div>
    </dl>` : "";
  const stop = busy && detail?.cancellable
    ? `<button type="button" class="btn-secondary runtime-stop" data-runtime-stop>${tr(locale, "Stop task", "停止任务")}</button>`
    : "";
  const sceneLabel = busy
    ? tr(locale, "Task in progress", "任务进行中")
    : tr(locale, "Task update", "任务状态");
  const steps = labels.map((label, index) => {
    const className = index < current || stage === "complete"
      ? "is-done"
      : index === current && stage !== "error" ? "is-current" : "";
    return `<li class="${className}">${escapeMarkup(label)}</li>`;
  }).join("");
  return `<section class="agent-wait runtime-scene is-${stage}" data-runtime-scene data-runtime-active="${String(busy)}"
      aria-busy="${String(busy)}">
    <header class="runtime-scene-header"><div><small>${sceneLabel}</small><strong role="status" aria-live="polite">${escapeMarkup(status)}</strong></div>${stop}</header>
    ${facts}
    <div class="agent-wait-copy">
      ${reason}
      <ol>${steps}</ol>
      <p>${tr(locale, "Progress is shown here without exposing the model's private reasoning.", "这里显示任务进度，不展示模型的私有推理内容。")}</p>
      ${next}
    </div>
  </section>`;
}
