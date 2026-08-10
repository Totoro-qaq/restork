import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalApiClient } from "../src/api/client";
import type { DashboardSnapshot } from "../src/api/types";
import { mountBrowserDashboard } from "../src/main";

const snapshot: DashboardSnapshot = {
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

function jsonResponse(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("browser session recovery", () => {
  it("opens the workspace after a page refresh without showing pairing again", async () => {
    const responses = [
      jsonResponse({
        access_token: "resumed-token",
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      }),
      jsonResponse(snapshot),
    ];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }));
    const root = document.createElement("main");

    await mountBrowserDashboard(root, new LocalApiClient());

    expect(root.querySelector("#pair-form")).toBeNull();
    expect(root.textContent).toContain("Dashboard");
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it("shows pairing only when Core has no recoverable local session", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(
      { detail: "local session is unavailable" },
      401,
    )));
    const root = document.createElement("main");

    await mountBrowserDashboard(root, new LocalApiClient());

    expect(root.querySelector("#pair-form")).not.toBeNull();
    expect(root.textContent).toContain("one-time Web pairing code");
  });
});
