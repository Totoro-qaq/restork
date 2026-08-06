import { describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import type { DashboardApi, DashboardSnapshot } from "../src/api/types";

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

function minimalApi(overrides: Partial<DashboardApi> = {}): DashboardApi {
  return {
    pair: vi.fn(async () => undefined),
    loadDashboard: vi.fn(async () => snapshot),
    ...overrides,
  } as unknown as DashboardApi;
}

/** A message the user cannot see is not a message. */
function visibleNotice(root: HTMLElement): { text: string; role: string } | null {
  for (const node of root.querySelectorAll<HTMLElement>("#global-status, #global-alert")) {
    if (node.hidden) continue;
    if (node.classList.contains("sr-only")) continue;
    return { text: node.textContent ?? "", role: node.getAttribute("role") ?? "" };
  }
  return null;
}

describe("global notification surface", () => {
  it("starts silent with the region reserved but collapsed", () => {
    const root = document.createElement("main");

    mountDashboard(root, { api: minimalApi(), snapshot });

    expect(root.querySelector("#global-status-region")).not.toBeNull();
    expect(visibleNotice(root)).toBeNull();
    expect(root.querySelector<HTMLElement>("#global-status-region")?.dataset.visible)
      .not.toBe("true");
  });

  it("renders a failed refresh as visible text, not screen-reader-only", async () => {
    const root = document.createElement("main");
    const api = minimalApi({
      loadDashboard: vi.fn(async () => {
        throw new Error("Core is unreachable");
      }),
    });

    mountDashboard(root, { api, snapshot });
    root.querySelector<HTMLButtonElement>("#refresh")?.click();
    await vi.waitFor(() => expect(visibleNotice(root)).not.toBeNull());

    const notice = visibleNotice(root);
    expect(notice?.text).toContain("Core is unreachable");
    expect(notice?.role).toBe("alert");
  });

  it("keeps the notice inside a region that is not sr-only", async () => {
    const root = document.createElement("main");
    const api = minimalApi({
      loadDashboard: vi.fn(async () => {
        throw new Error("Core is unreachable");
      }),
    });

    mountDashboard(root, { api, snapshot });
    root.querySelector<HTMLButtonElement>("#refresh")?.click();
    await vi.waitFor(() => expect(visibleNotice(root)).not.toBeNull());

    const region = root.querySelector<HTMLElement>("#global-status-region");
    expect(region?.classList.contains("sr-only")).toBe(false);
    expect(region?.dataset.visible).toBe("true");
    expect(root.querySelector<HTMLElement>("#global-alert")?.hidden).toBe(false);
  });

  it("dismisses a notice and re-collapses the region", async () => {
    const root = document.createElement("main");
    const api = minimalApi({
      loadDashboard: vi.fn(async () => {
        throw new Error("Core is unreachable");
      }),
    });

    mountDashboard(root, { api, snapshot });
    root.querySelector<HTMLButtonElement>("#refresh")?.click();
    await vi.waitFor(() => expect(visibleNotice(root)).not.toBeNull());

    root.querySelector<HTMLButtonElement>("#global-status-dismiss")?.click();

    expect(visibleNotice(root)).toBeNull();
    expect(root.querySelector<HTMLElement>("#global-status-region")?.dataset.visible)
      .toBe("false");
    expect(root.querySelector<HTMLButtonElement>("#global-status-dismiss")?.hidden).toBe(true);
  });

  it("keeps both live regions mounted so assistive technology stays subscribed", () => {
    const root = document.createElement("main");

    mountDashboard(root, { api: minimalApi(), snapshot });

    expect(root.querySelector("#global-status")?.getAttribute("role")).toBe("status");
    expect(root.querySelector("#global-alert")?.getAttribute("role")).toBe("alert");
  });
});
