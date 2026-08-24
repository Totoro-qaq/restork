import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalApiClient } from "../src/api/client";
import { mountDashboard } from "../src/main";
import type { DashboardApi, DashboardSnapshot, DomainStatuses } from "../src/api/types";

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
    expect(panelText(empty, "runs")).toContain("No runs yet. Start one from the home page.");
    expect(panelText(empty, "runs")).not.toContain("Core did not answer");
  });

  it("turns an unconfigured Radar into a setup path rather than an empty feed", () => {
    const root = mount({ radar: { state: "not_configured", status: 404 } });

    expect(panelText(root, "radar")).toContain("Choose public sources");
    expect(root.querySelector("#radar-config-form")).not.toBeNull();
    expect(panelText(root, "radar")).not.toContain("Empty");
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
    expect(panelText(root, "runs")).toContain("No runs yet. Start one from the home page.");
  });
});

describe("LocalApiClient classifies each domain", () => {
  it("preserves the Core's per-domain bootstrap classifications", async () => {
    const bootstrap = baseSnapshot({
      runs: { state: "not_configured", status: 501 },
      tasks: { state: "not_configured", status: 503, detail: "vault is not configured" },
      memory: { state: "forbidden", status: 403 },
      approvals: { state: "unavailable", status: 500 },
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(bootstrap), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

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
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
