import { afterEach, describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import { assistantStreamMarkup, eventRow } from "../src/ui/render";
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
  it("summarises model telemetry and tucks raw JSON behind a disclosure", () => {
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
    expect(row).toContain("<details>");
    expect(row).toContain("&quot;iteration&quot;");
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

  it("renders the answer with claims and tucks the raw JSON away", () => {
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
    expect(markup).toContain("<details>");
    expect(markup).toContain("data-assistant-stream");
  });

  it("escapes hostile content inside the envelope", () => {
    const markup = assistantStreamMarkup(
      JSON.stringify({ answer: "<script>alert(1)</script>" }),
    );
    expect(markup).not.toContain("<script>");
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

    // A background refresh re-renders the workspace with one more active run.
    mount(3, root);
    root.querySelector<HTMLButtonElement>('[data-view="overview"]')?.click();

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
    mountDashboard(root, { api: client, snapshot: snapshot(0) });

    const form = root.querySelector<HTMLFormElement>("#run-form");
    const goal = root.querySelector<HTMLInputElement>("#run-goal");
    expect(form).not.toBeNull();
    if (!form || !goal) return;
    goal.value = "test goal";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(root.querySelector("#global-status")?.textContent).toContain("run-stay");
    });
    expect(root.querySelector('[data-view="runs"]')?.classList.contains("is-active")).toBe(false);
    expect(root.querySelector('[data-view="overview"]')?.classList.contains("is-active")).toBe(true);
  });
});
