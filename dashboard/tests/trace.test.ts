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
    expect(html).toContain("2,600 tokens");
    expect(html).toContain("$0.0036");
    expect(html).toContain("tools 1/2 ok");
    expect(html).toContain("web_search");
    expect(html).toContain("read_note");
  });

  it("localizes the header and chips", () => {
    const html = traceMarkup(buildRunTrace(researchEvents()), "zh-CN");
    expect(html).toContain("运行记录");
    expect(html).toContain("来源、工具与重试");
    expect(html).toContain("3 轮迭代");
    expect(html).toContain("工具 1/2 成功");
    expect(html).toContain("第 1 轮");
  });

  it("escapes HTML carried by tool payloads", () => {
    const html = traceMarkup(buildRunTrace(researchEvents()));
    expect(html).not.toContain("<missing>");
    expect(html).toContain("&lt;missing&gt;");
  });
});
