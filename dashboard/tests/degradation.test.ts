import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalApiClient } from "../src/api/client";
import { mountDashboard } from "../src/main";
import type { DashboardApi, DashboardSnapshot, DomainStatuses } from "../src/api/types";

// The client issues same-origin relative paths; this only resolves them in the stub.
const ORIGIN = "http://127.0.0.1:7337";

function baseSnapshot(domains: DomainStatuses): DashboardSnapshot {
  return {
    runs: [],
    approvals: [],
    taskBoard: { configured: false, tasks: [] },
    radar: { configured: false, items: [] },
    memory: null,
    daily: null,
    provider: null,
    domains,
  };
}

function mount(domains: DomainStatuses): HTMLElement {
  const root = document.createElement("main");
  document.body.append(root);
  const snapshot = baseSnapshot(domains);
  mountDashboard(root, {
    api: {
      pair: vi.fn(async () => undefined),
      loadDashboard: vi.fn(async () => snapshot),
    } as unknown as DashboardApi,
    snapshot,
  });
  return root;
}

function panelText(root: HTMLElement, view: string): string {
  return root.querySelector(`[data-view-panel="${view}"]`)?.textContent ?? "";
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("a broken backend is not an empty workspace", () => {
  it("distinguishes a 500 from having no data yet", () => {
    const broken = mount({ runs: { state: "unavailable", detail: "boom", status: 500 } });
    const empty = mount({ runs: { state: "ready" } });

    expect(panelText(broken, "runs")).toContain("Core did not answer");
    expect(panelText(broken, "runs")).not.toContain("No runs yet");
    expect(panelText(empty, "runs")).toContain("No runs.");
    expect(panelText(empty, "runs")).not.toContain("Core did not answer");
  });

  it("says a deferred domain is not provided rather than showing it empty", () => {
    const root = mount({ radar: { state: "not_configured", status: 404 } });

    expect(panelText(root, "radar")).toContain("does not provide this yet");
  });

  it("names a scope problem as a scope problem", () => {
    const root = mount({ memory: { state: "forbidden", status: 403, detail: "memory:read" } });

    expect(panelText(root, "memory")).toContain("not authorised");
    expect(panelText(root, "memory")).toContain("memory:read");
  });

  it("raises an unavailable domain as an alert and a deferred one only as status", () => {
    const broken = mount({ tasks: { state: "unavailable", status: 502 } });
    const deferred = mount({ tasks: { state: "not_configured", status: 404 } });

    expect(broken.querySelector('.domain-notice[role="alert"]')).not.toBeNull();
    expect(deferred.querySelector('.domain-notice[role="alert"]')).toBeNull();
    expect(deferred.querySelector('.domain-notice[role="status"]')).not.toBeNull();
  });

  it("shows Core's own detail verbatim and escaped", () => {
    const root = mount({
      runs: { state: "unavailable", status: 500, detail: '<img src=x onerror="alert(1)">' },
    });

    expect(root.querySelector("img")).toBeNull();
    expect(panelText(root, "runs")).toContain("<img src=x");
  });

  it("treats an unmeasured domain as ready so older snapshots still render", () => {
    const root = mount({});

    expect(root.querySelector(".domain-notice")).toBeNull();
    expect(panelText(root, "runs")).toContain("No runs.");
  });
});

describe("LocalApiClient classifies each domain", () => {
  function respondWith(byPath: (path: string) => { status: number; body?: unknown }) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      // The client issues relative paths; resolve against the loopback origin.
      const path = new URL(String(input), ORIGIN).pathname;
      const { status, body } = byPath(path);
      return new Response(
        status === 204 ? null : JSON.stringify(body ?? { detail: `HTTP ${status}` }),
        { status, headers: { "Content-Type": "application/json" } },
      );
    }));
  }

  it("maps 404 and 503 to not_configured, 403 to forbidden, 500 to unavailable", async () => {
    respondWith((path) => {
      if (path === "/v1/runs") return { status: 404 };
      if (path === "/v1/tasks") return { status: 503, body: { detail: "vault is not configured" } };
      if (path === "/v1/memory") return { status: 403 };
      if (path === "/v1/approvals") return { status: 500 };
      return { status: 200, body: { items: [] } };
    });

    const client = new LocalApiClient();
    client.restoreSession({
      accessToken: "synthetic-token",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const snapshot = await client.loadDashboard();

    expect(snapshot.domains?.runs?.state).toBe("not_configured");
    expect(snapshot.domains?.tasks?.state).toBe("not_configured");
    expect(snapshot.domains?.tasks?.detail).toBe("vault is not configured");
    expect(snapshot.domains?.memory?.state).toBe("forbidden");
    expect(snapshot.domains?.approvals?.state).toBe("unavailable");
  });

  it("never lets a domain failure reject the whole bootstrap", async () => {
    respondWith(() => ({ status: 500 }));

    const client = new LocalApiClient();
    client.restoreSession({
      accessToken: "synthetic-token",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const snapshot = await client.loadDashboard();

    // Every domain failed, yet the bootstrap resolved and reported each one.
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.domains?.runs?.state).toBe("unavailable");
  });
});
