import { describe, expect, it } from "vitest";

import { buildRunTrace, traceMarkup } from "../src/ui/trace";
import type { RunEvent } from "../src/api/types";

function event(id: number, type: string, data: Record<string, unknown> = {}): RunEvent {
  return { id, type, data };
}

function researchEvents(): RunEvent[] {
  return [
    event(1, "run.created", { mode: "research", provider_profile_id: "deepseek" }),
    event(2, "run.started"),
    event(3, "model.started", { iteration: 1 }),
    event(4, "model.completed", { iteration: 1, total_tokens: 1200, cost_usd_micros: 2100, tool_calls: ["web_search"] }),
    event(5, "tool.completed", { tool: "web_search", observation: { result: { items: [1, 2, 3] } } }),
    event(6, "model.started", { iteration: 2 }),
    event(7, "retry.scheduled", { attempt: 1, kind: "provider", status: 429 }),
    event(8, "model.completed", { iteration: 2, total_tokens: 900, cost_usd_micros: 1500, tool_calls: ["read_note"] }),
    event(9, "tool.failed", { tool: "read_note", observation: { error: { kind: "not_found", message: "note <missing> is gone" } } }),
    event(10, "context.compacted", { removed_messages: 4 }),
    event(11, "model.started", { iteration: 3 }),
    event(12, "model.completed", { iteration: 3, total_tokens: 500, tool_calls: [] }),
    event(13, "run.completed", { iterations: 3, total_tokens: 2600 }),
  ];
}

describe("buildRunTrace", () => {
  it("groups tool outcomes, retries, and compactions under their open iteration", () => {
    const trace = buildRunTrace(researchEvents());
    expect(trace.iterations.map((bucket) => bucket.iteration)).toEqual([1, 2, 3]);

    const first = trace.iterations[0];
    expect(first.tokens).toBe(1200);
    expect(first.costMicros).toBe(2100);
    expect(first.plannedTools).toEqual(["web_search"]);
    expect(first.tools).toEqual([{ name: "web_search", ok: true, detail: "3" }]);

    const second = trace.iterations[1];
    expect(second.retries).toBe(1);
    expect(second.compacted).toBe(true);
    expect(second.tools).toHaveLength(1);
    expect(second.tools[0].ok).toBe(false);
    expect(second.tools[0].detail).toContain("not_found");
  });

  it("aggregates totals and terminal state", () => {
    const trace = buildRunTrace(researchEvents());
    expect(trace.totalTools).toBe(2);
    expect(trace.failedTools).toBe(1);
    expect(trace.retries).toBe(1);
    expect(trace.compactions).toBe(1);
    expect(trace.totalTokens).toBe(2600);
    expect(trace.totalCostMicros).toBe(3600);
    expect(trace.terminalType).toBe("run.completed");
  });

  it("sorts defensively so paginated prepends cannot scramble grouping", () => {
    const events = researchEvents();
    const shuffled = [...events.slice(6), ...events.slice(0, 6)];
    expect(buildRunTrace(shuffled)).toEqual(buildRunTrace(events));
  });

  it("returns an empty trace when no model events exist", () => {
    const trace = buildRunTrace([event(1, "run.created"), event(2, "assistant.delta", { content: "hi" })]);
    expect(trace.iterations).toEqual([]);
    expect(trace.terminalType).toBeNull();
    expect(traceMarkup(trace)).toBe("");
  });
});

describe("traceMarkup", () => {
  it("renders chips, timeline segments with failure markers, and per-iteration details", () => {
    const html = traceMarkup(buildRunTrace(researchEvents()));
    expect(html).toContain("trace-panel");
    expect(html).toContain("trace-timeline");
    expect(html).toContain("has-failure");
    expect(html).toContain("has-compaction");
    expect(html).toContain("Run data");
    expect(html).toContain("<dd>2,600</dd>");
    expect(html).toContain("$0.0036");
    expect(html).toContain("1/2 tool actions completed");
    expect(html).toContain("Search the web");
    expect(html).toContain("Read note");
    expect(html).not.toContain("web_search");
  });

  it("localizes the header and chips", () => {
    const html = traceMarkup(buildRunTrace(researchEvents()), "zh-CN");
    expect(html).toContain("任务过程");
    expect(html).toContain("进度与资料活动");
    expect(html).toContain("3/3 次处理完成");
    expect(html).toContain("1/2 次工具操作完成");
    expect(html).toContain("第 1 次处理");
    expect(html).toContain("搜索网页");
  });

  it("does not expose tool error payloads in the user-facing process", () => {
    const html = traceMarkup(buildRunTrace(researchEvents()));
    expect(html).not.toContain("<missing>");
    expect(html).not.toContain("missing");
  });

  it("distinguishes completed processing from an interrupted final model call", () => {
    const events = [
      ...researchEvents().slice(0, -1),
      event(13, "model.started", { iteration: 4 }),
      event(14, "run.stopped", { state: "retryable", stop_reason: "provider_unavailable", total_tokens: 2600 }),
    ];
    const trace = buildRunTrace(events);
    const html = traceMarkup(trace, "zh-CN");
    expect(trace.completedIterations).toBe(3);
    expect(trace.interruptedIterations).toBe(1);
    expect(html).toContain("3/4 次处理完成");
    expect(html).toContain("1 次中断");
    expect(html).toContain("第 4 次处理 · 已中断");
  });
});
