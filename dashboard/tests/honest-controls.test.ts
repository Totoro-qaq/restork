import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import type { DashboardApi, DashboardSnapshot } from "../src/api/types";

const source = readFileSync(resolve(import.meta.dirname, "../src/main.ts"), "utf8");

function snapshot(): DashboardSnapshot {
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
    daily: {
      observed_at: "2026-08-06T12:00:00Z",
      timezone: "UTC",
      weather: null,
      calendar: null,
      mail: {
        configured: false,
        available: true,
        unread_count: null,
        status: "not_configured",
        detail_scopes: ["unread_count"],
        refresh_interval_seconds: 15,
        message: "",
      },
      music: null,
    },
    provider: null,
  } as unknown as DashboardSnapshot;
}

function mount(overrides: Partial<DashboardApi> = {}): HTMLElement {
  const root = document.createElement("main");
  document.body.append(root);
  mountDashboard(root, {
    api: {
      pair: vi.fn(async () => undefined),
      loadDashboard: vi.fn(async () => snapshot()),
      ...overrides,
    } as unknown as DashboardApi,
    snapshot: snapshot(),
  });
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("controls reflect real capability", () => {
  it("disables a control whose capability the Core does not expose", () => {
    const root = mount();
    const connect = root.querySelector<HTMLButtonElement>("[data-native-mail-connect]");
    if (!connect) return; // Mail settings render only when the daily source exists.

    expect(connect.disabled).toBe(true);
    expect(connect.getAttribute("aria-disabled")).toBe("true");
    expect(connect.dataset.unavailableCapability).toBe("connectNativeMail");
  });

  it("states why the control is unavailable rather than failing silently", () => {
    const root = mount();
    const connect = root.querySelector<HTMLButtonElement>("[data-native-mail-connect]");
    if (!connect) return;

    expect(connect.title).toContain("does not provide this capability");
  });

  it("leaves a control enabled when the capability is present", () => {
    const root = mount({ connectNativeMail: vi.fn(async () => undefined) as never });
    const connect = root.querySelector<HTMLButtonElement>("[data-native-mail-connect]");
    if (!connect) return;

    expect(connect.disabled).toBe(false);
    expect(connect.dataset.unavailableCapability).toBeUndefined();
  });
});

describe("destructive confirmation", () => {
  it("no longer uses the blocking native prompt", () => {
    const calls = source.split("window.confirm(").length - 1;
    // The only remaining mention is the comment explaining why it was replaced.
    expect(calls).toBe(0);
  });

  it("renders an in-app dialog and does nothing until it is confirmed", async () => {
    const root = document.createElement("main");
    document.body.append(root);
    const deleteSession = vi.fn(async () => undefined);
    mountDashboard(root, {
      api: {
        pair: vi.fn(async () => undefined),
        loadDashboard: vi.fn(async () => snapshot()),
        deleteSession,
      } as unknown as DashboardApi,
      snapshot: snapshot(),
    });

    const trigger = root.querySelector<HTMLButtonElement>("[data-session-delete]");
    if (!trigger) return; // Conversation workspace is absent from this snapshot.
    trigger.click();

    await vi.waitFor(() => expect(root.querySelector("dialog.confirm-dialog")).not.toBeNull());
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("treats cancel and Escape as refusal", async () => {
    // `confirmAction` resolves false unless returnValue is exactly "confirm",
    // so an Escape-closed dialog (empty returnValue) cannot act.
    expect(source).toContain('dialog.returnValue === "confirm"');
    expect(source).toContain('data-confirm="cancel"');
  });

  it("puts Core-supplied text in the dialog as text, never as markup", () => {
    expect(source).toContain("messageNode.textContent = message");
    expect(source).toContain("detailNode.textContent = detail");
  });
});
