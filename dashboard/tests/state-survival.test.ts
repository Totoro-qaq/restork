import { describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import type {
  DashboardApi,
  DashboardListPage,
  DashboardSnapshot,
  RunEvent,
  SessionRecordV2,
} from "../src/api/types";

function session(id: string, title: string): SessionRecordV2 {
  return {
    session_id: id,
    title,
    profile_id: "safe-mode",
    status: "active",
    version: 1,
    locale: "en",
    created_at: "2026-08-05T11:00:00Z",
    updated_at: "2026-08-05T11:05:00Z",
    archived_at: null,
  };
}

function baseSnapshot(): DashboardSnapshot {
  return {
    runs: [],
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

function workspaceSnapshot(): DashboardSnapshot {
  return {
    ...baseSnapshot(),
    workspaceV2: {
      dailyContext: null,
      personal: null,
      sessions: [session("session-first", "First"), session("session-second", "Second")],
      extensions: [],
      deliverables: [],
      schedules: [],
      providers: [],
      profiles: [],
      prompts: [],
    },
  } as DashboardSnapshot;
}

function api(overrides: Partial<DashboardApi> = {}): DashboardApi {
  return {
    pair: vi.fn(async () => undefined),
    loadDashboard: vi.fn(async () => workspaceSnapshot()),
    sessionMessages: vi.fn(async () => []),
    streamEvents: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as DashboardApi;
}

describe("state survives a re-render", () => {
  it("keeps the session the user chose instead of reselecting the first", async () => {
    const root = document.createElement("main");
    const client = api();
    mountDashboard(root, { api: client, snapshot: workspaceSnapshot() });

    await vi.waitFor(() => expect(
      root.querySelector('[data-session-select="session-second"]'),
    ).not.toBeNull());
    root.querySelector<HTMLButtonElement>('[data-session-select="session-second"]')?.click();
    await vi.waitFor(() => expect(
      root.querySelector<HTMLElement>(".conversation-pane")?.dataset.activeSession,
    ).toBe("session-second"));

    root.querySelector<HTMLButtonElement>("#refresh")?.click();

    await vi.waitFor(() => expect(client.loadDashboard).toHaveBeenCalled());
    await vi.waitFor(() => expect(
      root.querySelector<HTMLElement>(".conversation-pane")?.dataset.activeSession,
    ).toBe("session-second"));
  });

  it("falls back to the first active session only when nothing was chosen", async () => {
    const root = document.createElement("main");
    mountDashboard(root, { api: api(), snapshot: workspaceSnapshot() });

    await vi.waitFor(() => expect(
      root.querySelector<HTMLElement>(".conversation-pane")?.dataset.activeSession,
    ).toBe("session-first"));
  });
});

describe("pagination", () => {
  const page: DashboardListPage = {
    kind: "runs",
    items: [],
    page: { limit: 12, has_more: false, next_cursor: null },
  } as unknown as DashboardListPage;

  it("appends into the owning panel without replacing the workspace", async () => {
    const root = document.createElement("main");
    const state = baseSnapshot();
    state.pagination = { runs: { limit: 12, has_more: true, next_cursor: "cursor-1" } };
    const client = api({ loadPage: vi.fn(async () => page) });

    mountDashboard(root, { api: client, snapshot: state });

    const nav = root.querySelector('[data-view="runs"]');
    const otherPanel = root.querySelector('[data-view-panel="approvals"]');
    expect(nav).not.toBeNull();

    const loadMore = root.querySelector<HTMLButtonElement>('[data-page-kind="runs"]');
    expect(loadMore).not.toBeNull();
    loadMore?.click();

    await vi.waitFor(() => expect(client.loadPage).toHaveBeenCalledWith("runs", "cursor-1"));

    // Identity, not equality: a full re-render replaces these nodes.
    expect(root.querySelector('[data-view="runs"]')).toBe(nav);
    expect(root.querySelector('[data-view-panel="approvals"]')).toBe(otherPanel);
  });

  it("rebinds interactions inside the panel it re-rendered", async () => {
    const root = document.createElement("main");
    const state = baseSnapshot();
    state.pagination = { runs: { limit: 12, has_more: true, next_cursor: "cursor-1" } };
    const client = api({
      loadPage: vi.fn(async () => ({
        ...page,
        page: { limit: 12, has_more: true, next_cursor: "cursor-2" },
      }) as unknown as DashboardListPage),
    });

    mountDashboard(root, { api: client, snapshot: state });
    root.querySelector<HTMLButtonElement>('[data-page-kind="runs"]')?.click();
    await vi.waitFor(() => expect(client.loadPage).toHaveBeenCalledTimes(1));

    // The replaced button must be live, otherwise pagination stops after one page.
    await vi.waitFor(() => {
      const next = root.querySelector<HTMLButtonElement>('[data-page-kind="runs"]');
      expect(next?.dataset.pageCursor).toBe("cursor-2");
    });
    root.querySelector<HTMLButtonElement>('[data-page-kind="runs"]')?.click();
    await vi.waitFor(() => expect(client.loadPage).toHaveBeenCalledTimes(2));
  });
});

describe("live run events", () => {
  it("appends one row per event instead of re-serialising the run", async () => {
    const root = document.createElement("main");
    const state = baseSnapshot();
    state.runs = [{
      summary: {
        run_id: "run-live",
        task_id: "task-live",
        mode: "research",
        state: "running",
        stop_reason: null,
        created_at: "2026-08-05T11:00:00Z",
        updated_at: "2026-08-05T11:00:00Z",
      },
      task: { goal: "Live run" },
      budget: { usage: { tokens: 0 } },
    }] as unknown as DashboardSnapshot["runs"];

    const emitters: Array<(event: RunEvent) => void> = [];
    const client = api({
      events: vi.fn(async () => [{ id: 1, type: "run.started", data: {} } as RunEvent]),
      streamEvents: vi.fn(async (
        _runId: string,
        _after: number,
        onEvent: (event: RunEvent) => void,
      ) => {
        emitters.push(onEvent);
      }),
    });

    // `showRun` guards on `isConnected`, so the tree must be in the document.
    document.body.append(root);
    mountDashboard(root, { api: client, snapshot: state });
    root.querySelector<HTMLButtonElement>('[data-run-id="run-live"]')?.click();
    await vi.waitFor(() => expect(root.querySelector(".event-list")).not.toBeNull());

    const list = root.querySelector<HTMLOListElement>(".event-list");
    const firstRow = list?.querySelector("li");
    await vi.waitFor(() => expect(emitters).toHaveLength(1));

    emitters[0]({ id: 2, type: "model.started", data: {} } as RunEvent);

    await vi.waitFor(() => expect(
      root.querySelector('.event-list [data-event-id="2"]'),
    ).not.toBeNull());
    // The list element and the pre-existing row survive: nothing was rebuilt.
    expect(root.querySelector(".event-list")).toBe(list);
    expect(list?.querySelector("li")).toBe(firstRow);
    root.remove();
  });
});
