import { afterEach, describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import { prepareRunDetail, syncRunDetailScrollbar } from "../src/features/runDetail";
import { assistantStreamMarkup, eventRow, runEventsMarkup } from "../src/ui/render";
import type {
  DashboardApi,
  DashboardSnapshot,
  RunListEntry,
  RunSummary,
} from "../src/api/types";

function runSummary(id: string, state: string): RunSummary {
  return {
    run_id: id,
    task_id: `task-${id}`,
    mode: "research",
    state,
    state_version: 1,
    stop_reason: null,
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
  };
}

function runEntry(id: string, state: string): RunListEntry {
  return {
    summary: runSummary(id, state),
    task: null,
    budget: null,
  };
}

function snapshot(activeRuns: number): DashboardSnapshot {
  return {
    runs: Array.from({ length: activeRuns }, (_, index) => runEntry(`run-${index}`, "running")),
    approvals: [],
    taskBoard: { configured: false, tasks: [] },
    radar: { configured: false, items: [] },
    memory: {
      records: [],
      counts: { working: 0, episodic: 0, semantic: 0, profile: 0 },
      architecture: ["working", "episodic", "semantic", "profile"],
    },
    daily: null,
    provider: null,
  };
}

function api(activeRuns: number): DashboardApi {
  return {
    pair: vi.fn(async () => undefined),
    loadDashboard: vi.fn(async () => snapshot(activeRuns)),
  } as unknown as DashboardApi;
}

function mount(activeRuns: number, root?: HTMLElement): HTMLElement {
  const target = root ?? document.createElement("main");
  if (!root) document.body.append(target);
  mountDashboard(target, { api: api(activeRuns), snapshot: snapshot(activeRuns) });
  return target;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("event rows stay human-readable", () => {
  it("renders a redacted diagnostic row without nesting another disclosure", () => {
    const row = eventRow({
      id: 7,
      type: "model.completed",
      data: {
        iteration: 2,
        tool_calls: ["web_search"],
        total_tokens: 1234,
        cost_usd_micros: 1500,
      },
    });
    expect(row).toContain("Iteration 2 done");
    expect(row).toContain("1,234 tokens");
    expect(row).toContain("web_search");
    expect(row).toContain("$0.0015");
    expect(row).not.toContain("<details>");
    expect(row).toContain("<pre><code>");
    expect(row).toContain("&quot;iteration&quot;");
  });

  it("keeps raw events in one collapsed developer section and offers retry", () => {
    const run = runEntry("retryable", "retryable");
    run.summary.stop_reason = "provider_unavailable";
    const markup = runEventsMarkup(run, [{
      id: 1,
      type: "tool.completed",
      data: {
        tool: "vault_search",
        observation: { result: { items: [{ excerpt: "private note", relative_path: "Private.md" }] } },
      },
    }], "zh-CN");

    expect(markup).toContain("任务已暂停，可以重试");
    expect(markup).toContain("这次模型调用没有完成");
    expect(markup).not.toContain("模型服务暂时不可用");
    expect(markup).toContain("data-run-retry");
    expect(markup).toContain("开发者诊断");
    expect(markup).toContain("[redacted]");
    expect(markup).not.toContain("private note");
    expect(markup).not.toContain("Private.md");
    expect(markup).not.toContain("技术详情");
  });

  it("explains the concrete provider failure when Core recorded one", () => {
    const run = runEntry("retryable-specific", "retryable");
    run.summary.stop_reason = "provider_unavailable";
    const markup = runEventsMarkup(run, [{
      id: 2,
      type: "provider.failed",
      data: { kind: "invalid_response", retryable: false },
    }], "zh-CN");

    expect(markup).toContain("模型返回了 Restork 暂时无法读取的响应");
    expect(markup).toContain("模型调用中断");
  });

  it("renders Chinese summaries for a Chinese locale", () => {
    const row = eventRow(
      { id: 3, type: "model.completed", data: { iteration: 2, tool_calls: [], total_tokens: 5 } },
      "zh-CN",
    );
    expect(row).toContain("第 2 轮完成");
    expect(row).not.toContain("tools:");
  });

  it("escapes hostile tool error messages inside the summary", () => {
    const row = eventRow({
      id: 9,
      type: "tool.failed",
      data: {
        tool: "web_search",
        observation: {
          ok: false,
          error: { kind: "structured_output_invalid", message: "<img src=x onerror=alert(1)>" },
        },
      },
    });
    expect(row).toContain("structured_output_invalid");
    expect(row).not.toContain("<img");
  });
});

describe("assistant stream upgrades the research envelope", () => {
  it("keeps partial output raw while the run is still streaming", () => {
    const markup = assistantStreamMarkup("{\"answer\":\"未完", "zh-CN");
    expect(markup).toContain("<pre data-assistant-stream>");
  });

  it("renders the answer with claims without exposing the raw JSON envelope", () => {
    const envelope = JSON.stringify({
      answer: "这是回答。",
      claims: [
        { claim_id: "c1", statement: "论断一", kind: "fact", evidence_refs: ["https://a.test/x"] },
      ],
      conflicts: ["两处来源矛盾"],
      unresolved_questions: [],
    });
    const markup = assistantStreamMarkup(envelope, "zh-CN");
    expect(markup).toContain("这是回答。");
    expect(markup).toContain("论断一");
    expect(markup).toContain("https://a.test/x");
    expect(markup).toContain("关键论断");
    expect(markup).toContain("两处来源矛盾");
    expect(markup).not.toContain("<details>");
    expect(markup).not.toContain("claim_id");
    expect(markup).toContain("data-assistant-stream");
  });

  it("renders the study questions envelope as a ready note, not raw JSON", () => {
    const payload = JSON.stringify({
      questions: [
        { prompt: "你希望 agent 完成什么？", response_kind: "text" },
        { prompt: "崩溃后如何恢复？", response_kind: "text" },
      ],
    });
    const markup = assistantStreamMarkup(payload, "zh-CN");
    expect(markup).toContain("学习诊断 · 2 个问题已就绪");
    expect(markup).not.toContain("<pre data-assistant-stream>");
    expect(markup).not.toContain("<details>");
    expect(markup).not.toContain("questions");
    expect(markup).not.toMatch(/^<pre/);
  });

  it("renders the work plan envelope as a ready note, not raw JSON", () => {
    const payload = JSON.stringify({
      plan_steps: [{ title: "收集运行记录" }, { title: "起草周报" }],
    });
    const markup = assistantStreamMarkup(payload, "zh-CN");
    expect(markup).toContain("工作计划 · 2 个步骤已就绪");
    expect(markup).not.toContain("<details>");
    expect(markup).not.toContain("plan_steps");
    expect(markup).not.toMatch(/^<pre/);
  });

  it("keeps an empty questions payload on the raw fallback", () => {
    const markup = assistantStreamMarkup("{\"questions\":[]}", "zh-CN");
    expect(markup).toContain("<pre data-assistant-stream>");
  });

  it("escapes hostile content inside the envelope", () => {
    const markup = assistantStreamMarkup(
      JSON.stringify({ answer: "<script>alert(1)</script>" }),
    );
    expect(markup).not.toContain("<script>");
  });

  it("keeps a completed long prose result compact and restores escaped line breaks", () => {
    const output = `${"第一段研究结论。".repeat(70)}\\n\\n## 证据\\n${"第二段证据。".repeat(70)}`;
    const markup = assistantStreamMarkup(output, "zh-CN", true);

    expect(markup).toContain("assistant-answer-compact");
    expect(markup).toContain("查看完整模型输出");
    expect(markup).toContain("<details");
    expect(markup).not.toContain("\\n\\n");
  });

  it("labels terminal output as a result instead of an always-expanded stream", () => {
    const run = runEntry("completed-output", "completed");
    const content = "研究结果。".repeat(180);
    const markup = runEventsMarkup(run, [{ id: 1, type: "assistant.delta", data: { content } }], "zh-CN");

    expect(markup).toContain("assistant-stream is-complete");
    expect(markup).toContain("模型整理结果");
    expect(markup).toContain("查看完整模型输出");
    expect(markup).not.toContain("助手 · 流式输出");
  });
});

describe("run detail navigation", () => {
  it("returns the detail pane to the top before loading another run", () => {
    const root = document.createElement("main");
    root.innerHTML = '<div data-run-list><button data-run-id="run-1"></button></div><div id="run-detail"></div>';
    const button = root.querySelector<HTMLButtonElement>("[data-run-id]")!;
    const detail = root.querySelector<HTMLElement>("#run-detail")!;
    detail.scrollTop = 320;

    prepareRunDetail(root, detail, button, "zh-CN");

    expect(detail.scrollTop).toBe(0);
    expect(button.getAttribute("aria-current")).toBe("true");
  });

  it("keeps a persistent in-interface rail in sync with long process content", () => {
    const root = document.createElement("main");
    root.innerHTML = '<div class="run-detail-shell"><div id="run-detail"></div><div data-run-detail-scrollbar hidden><i data-run-detail-scroll-thumb></i></div></div>';
    const detail = root.querySelector<HTMLElement>("#run-detail")!;
    const rail = root.querySelector<HTMLElement>("[data-run-detail-scrollbar]")!;
    const thumb = root.querySelector<HTMLElement>("[data-run-detail-scroll-thumb]")!;
    Object.defineProperties(detail, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 1_000 },
    });
    Object.defineProperty(rail, "clientHeight", { value: 384 });
    detail.scrollTop = 300;

    syncRunDetailScrollbar(detail);

    expect(rail.hidden).toBe(false);
    expect(thumb.style.height).toBe("154px");
    expect(thumb.style.transform).toBe("translate3d(0, 115px, 0)");
  });
});

describe("navigation badges count only unseen items", () => {
  it("clears the badge when the view is opened", () => {
    const root = mount(2);
    const badge = root.querySelector<HTMLElement>('[data-view="runs"] [data-nav-count]');
    expect(badge?.hidden).toBe(false);
    expect(badge?.textContent).toBe("2");

    root.querySelector<HTMLButtonElement>('[data-view="runs"]')?.click();
    expect(badge?.hidden).toBe(true);
  });

  it("shows only the delta after new items arrive", () => {
    const root = mount(2);
    root.querySelector<HTMLButtonElement>('[data-view="runs"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-view="overview"]')?.click();

    // A background refresh re-renders the workspace with one more active run.
    // Restore keeps overview; the extra run is unseen until Runs is opened again.
    mount(3, root);

    const badge = root.querySelector<HTMLElement>('[data-view="runs"] [data-nav-count]');
    expect(badge?.hidden).toBe(false);
    expect(badge?.textContent).toBe("1");
  });

  it("starts each newly selected workspace at the top", () => {
    const root = mount(1);
    const workspace = root.querySelector<HTMLElement>(".workspace");
    expect(workspace).not.toBeNull();
    if (!workspace) return;
    workspace.scrollTop = 480;

    root.querySelector<HTMLButtonElement>('[data-view="runs"]')?.click();

    expect(workspace.scrollTop).toBe(0);
  });
});

describe("refresh feedback", () => {
  it("disables repeated refreshes while the current request is pending", async () => {
    let resolveLoad: ((value: DashboardSnapshot) => void) | undefined;
    const load = new Promise<DashboardSnapshot>((resolve) => { resolveLoad = resolve; });
    const client = {
      pair: vi.fn(async () => undefined),
      loadDashboard: vi.fn(() => load),
    } as unknown as DashboardApi;
    const root = document.createElement("main");
    document.body.append(root);
    mountDashboard(root, { api: client, snapshot: snapshot(0) });
    const button = root.querySelector<HTMLButtonElement>("#refresh");
    expect(button).not.toBeNull();

    button?.click();

    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    button?.click();
    expect(client.loadDashboard).toHaveBeenCalledTimes(1);

    resolveLoad?.(snapshot(0));
    await vi.waitFor(() => expect(root.querySelector("#refresh")).not.toBe(button));
  });
});

describe("research run creation keeps the launch context", () => {
  it("stays on the current view instead of jumping to Runs", async () => {
    const created = runSummary("run-stay", "running");
    const client = {
      pair: vi.fn(async () => undefined),
      loadDashboard: vi.fn(async () => snapshot(1)),
      createRun: vi.fn(async () => created),
      streamEvents: vi.fn(async () => undefined),
    } as unknown as DashboardApi;
    const root = document.createElement("main");
    document.body.append(root);
    mountDashboard(root, {
      api: client,
      snapshot: {
        ...snapshot(0),
        provider: {
          schema_version: 1,
          provider: "deepseek",
          model: "deepseek-v4-pro",
          status: "ready",
          message: "Ready",
          setup_command: "",
          config_present: true,
          config_valid: true,
          credential_present: true,
          connection_checked: false,
          connection_ok: null,
          model_available: null,
          smoke_checked: false,
          smoke_ok: null,
          restart_required: false,
          latency_ms: null,
          request_id: null,
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null,
        },
      },
    });

    const form = root.querySelector<HTMLFormElement>("#start-run-form");
    const goal = root.querySelector<HTMLTextAreaElement>("#start-goal");
    expect(form).not.toBeNull();
    if (!form || !goal) return;
    goal.value = "test goal";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(root.querySelector("[data-run-status]")?.textContent).toContain("run-stay");
    });
    expect(root.querySelector('[data-view="runs"]')?.classList.contains("is-active")).toBe(false);
    expect(root.querySelector('[data-view="start"]')?.classList.contains("is-active")).toBe(true);
  });
});
