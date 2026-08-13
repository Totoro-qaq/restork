import type { RunEvent } from "../api/types";
import type { Locale } from "../i18n";
import { tr } from "../i18n";

export interface TraceToolCall {
  name: string;
  ok: boolean;
  detail: string;
}

export interface TraceIteration {
  iteration: number;
  tokens: number | null;
  costMicros: number | null;
  plannedTools: string[];
  tools: TraceToolCall[];
  approvals: number;
  retries: number;
  compacted: boolean;
}

export interface RunTrace {
  iterations: TraceIteration[];
  totalTokens: number | null;
  totalCostMicros: number | null;
  totalTools: number;
  failedTools: number;
  approvals: number;
  retries: number;
  compactions: number;
  terminalType: string | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value != null ? (value as Record<string, unknown>) : {};
}

/** Count hint for common tool-result shapes ({items|results|notes|hits: []}). */
function resultCount(result: unknown): number | null {
  if (typeof result !== "object" || result == null) return null;
  for (const key of ["items", "results", "notes", "hits"]) {
    const list = (result as Record<string, unknown>)[key];
    if (Array.isArray(list)) return list.length;
  }
  return null;
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clipped(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const TERMINAL_TYPES = new Set(["run.completed", "run.stopped", "run.cancelled", "run.runtime_failed"]);

/**
 * Fold a run's event stream into an iteration-grouped trace. The durable loop
 * emits `model.started`/`model.completed` with an `iteration` counter; tool
 * outcomes, retries, approvals, and compactions are attached to the iteration
 * that was open when they arrived. Events are sorted defensively by sequence
 * id so paginated history prepends cannot scramble the grouping.
 */
export function buildRunTrace(events: RunEvent[]): RunTrace {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const buckets = new Map<number, TraceIteration>();
  const ensure = (iteration: number): TraceIteration => {
    let bucket = buckets.get(iteration);
    if (!bucket) {
      bucket = {
        iteration,
        tokens: null,
        costMicros: null,
        plannedTools: [],
        tools: [],
        approvals: 0,
        retries: 0,
        compacted: false,
      };
      buckets.set(iteration, bucket);
    }
    return bucket;
  };

  let current = 0;
  let totalTools = 0;
  let failedTools = 0;
  let approvals = 0;
  let retries = 0;
  let compactions = 0;
  let terminalType: string | null = null;
  let terminalTokens: number | null = null;

  for (const event of ordered) {
    const data = event.data ?? {};
    switch (event.type) {
      case "model.started": {
        current = num(data.iteration) ?? current + 1;
        ensure(current);
        break;
      }
      case "model.completed": {
        const iteration = num(data.iteration) ?? current;
        const bucket = ensure(iteration);
        bucket.tokens = num(data.total_tokens);
        bucket.costMicros = num(data.cost_usd_micros);
        bucket.plannedTools = Array.isArray(data.tool_calls)
          ? data.tool_calls.filter((name): name is string => typeof name === "string")
          : [];
        current = iteration;
        break;
      }
      case "tool.completed": {
        const bucket = ensure(current);
        const count = resultCount(recordOf(data.observation).result);
        bucket.tools.push({
          name: text(data.tool) || "tool",
          ok: true,
          detail: count == null ? "" : `${count}`,
        });
        totalTools += 1;
        break;
      }
      case "tool.failed": {
        const bucket = ensure(current);
        const failure = recordOf(recordOf(data.observation).error);
        const kind = text(failure.kind) || "error";
        const message = text(failure.message);
        bucket.tools.push({
          name: text(data.tool) || "tool",
          ok: false,
          detail: message ? `${kind} · ${clipped(message)}` : kind,
        });
        totalTools += 1;
        failedTools += 1;
        break;
      }
      case "approval.requested": {
        ensure(current).approvals += 1;
        approvals += 1;
        break;
      }
      case "retry.scheduled": {
        ensure(current).retries += 1;
        retries += 1;
        break;
      }
      case "context.compacted": {
        ensure(current).compacted = true;
        compactions += 1;
        break;
      }
      default: {
        if (TERMINAL_TYPES.has(event.type)) {
          terminalType = event.type;
          terminalTokens = num(data.total_tokens) ?? terminalTokens;
        }
        break;
      }
    }
  }

  const iterations = [...buckets.values()].sort((a, b) => a.iteration - b.iteration);
  const tokenSum = iterations.reduce((sum, bucket) => sum + (bucket.tokens ?? 0), 0);
  const costSum = iterations.reduce((sum, bucket) => sum + (bucket.costMicros ?? 0), 0);
  const hasCost = iterations.some((bucket) => bucket.costMicros != null);
  return {
    iterations,
    totalTokens: tokenSum > 0 ? tokenSum : terminalTokens,
    totalCostMicros: hasCost ? costSum : null,
    totalTools,
    failedTools,
    approvals,
    retries,
    compactions,
    terminalType,
  };
}

function chip(label: string): string {
  return `<span class="trace-chip">${label}</span>`;
}

function iterationTitle(bucket: TraceIteration, locale: Locale): string {
  const tokens = bucket.tokens == null ? "" : ` · ${bucket.tokens.toLocaleString()} tokens`;
  const cost =
    bucket.costMicros == null ? "" : ` · $${(bucket.costMicros / 1_000_000).toFixed(4)}`;
  const tools = bucket.tools.length
    ? ` · ${bucket.tools.map((tool) => `${tool.ok ? "✓" : "✗"} ${tool.name}`).join(", ")}`
    : "";
  return `${tr(locale, `Iteration ${bucket.iteration}`, `第 ${bucket.iteration} 轮`)}${tokens}${cost}${tools}`;
}

export function traceMarkup(trace: RunTrace, locale: Locale = "en"): string {
  if (trace.iterations.length === 0) return "";

  const chips: string[] = [
    chip(
      tr(
        locale,
        `${trace.iterations.length} iteration(s)`,
        `${trace.iterations.length} 轮迭代`,
      ),
    ),
  ];
  if (trace.totalTokens != null) chips.push(chip(`${trace.totalTokens.toLocaleString()} tokens`));
  if (trace.totalCostMicros != null) {
    chips.push(chip(`$${(trace.totalCostMicros / 1_000_000).toFixed(4)}`));
  }
  if (trace.totalTools > 0) {
    chips.push(
      chip(
        tr(
          locale,
          `tools ${trace.totalTools - trace.failedTools}/${trace.totalTools} ok`,
          `工具 ${trace.totalTools - trace.failedTools}/${trace.totalTools} 成功`,
        ),
      ),
    );
  }
  if (trace.failedTools > 0) {
    chips.push(chip(tr(locale, `${trace.failedTools} failed`, `${trace.failedTools} 失败`)));
  }
  if (trace.approvals > 0) {
    chips.push(chip(tr(locale, `${trace.approvals} approval(s)`, `${trace.approvals} 次审批`)));
  }
  if (trace.retries > 0) {
    chips.push(chip(tr(locale, `${trace.retries} retry(ies)`, `${trace.retries} 次重试`)));
  }
  if (trace.compactions > 0) {
    chips.push(chip(tr(locale, `${trace.compactions} compaction(s)`, `${trace.compactions} 次压缩`)));
  }

  const segments = trace.iterations
    .map((bucket) => {
      const classes = ["trace-seg"];
      if (bucket.tools.some((tool) => !tool.ok)) classes.push("has-failure");
      if (bucket.approvals > 0) classes.push("has-approval");
      if (bucket.compacted) classes.push("has-compaction");
      const weight = Math.max(1, Math.round((bucket.tokens ?? 0) / 100) || 1);
      return `<i class="${classes.join(" ")}" style="flex-grow:${weight}" title="${escape(
        iterationTitle(bucket, locale),
      )}"></i>`;
    })
    .join("");

  const rows = trace.iterations
    .map((bucket) => {
      const toolLines = bucket.tools.length
        ? `<ul class="trace-tools">${bucket.tools
            .map(
              (tool) =>
                `<li class="${tool.ok ? "ok" : "failed"}"><b>${tool.ok ? "✓" : "✗"}</b> ${escape(
                  tool.name,
                )}${tool.detail ? ` <small>${escape(tool.detail)}</small>` : ""}</li>`,
            )
            .join("")}</ul>`
        : `<p class="trace-empty">${tr(locale, "No tool calls in this iteration.", "本轮没有工具调用。")}</p>`;
      const flags: string[] = [];
      if (bucket.approvals > 0) {
        flags.push(tr(locale, `${bucket.approvals} approval gate(s)`, `${bucket.approvals} 个审批门`));
      }
      if (bucket.retries > 0) {
        flags.push(tr(locale, `${bucket.retries} retry(ies)`, `${bucket.retries} 次重试`));
      }
      if (bucket.compacted) {
        flags.push(tr(locale, "context compacted", "上下文已压缩"));
      }
      return `<li><details><summary>${escape(iterationTitle(bucket, locale))}${
        flags.length ? ` <small>${escape(flags.join(" · "))}</small>` : ""
      }</summary>${toolLines}</details></li>`;
    })
    .join("");

  return `<section class="trace-panel" aria-labelledby="trace-title">
    <header><p class="eyebrow">${tr(locale, "Durable loop · trace", "持久循环 · 追踪")}</p><h3 id="trace-title">${tr(locale, "Run trace", "运行追踪")}</h3></header>
    <div class="trace-chips">${chips.join("")}</div>
    <div class="trace-timeline" role="img" aria-label="${escape(
      tr(locale, "Iteration timeline", "迭代时间线"),
    )}">${segments}</div>
    <ol class="trace-iterations">${rows}</ol>
  </section>`;
}
