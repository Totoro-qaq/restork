import { describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import type {
  DashboardApi,
  DashboardSnapshot,
  VaultChangeEventV2,
} from "../src/api/types";

const snapshot: DashboardSnapshot = {
  runs: [],
  approvals: [],
  taskBoard: { configured: true, tasks: [] },
  radar: { configured: false, items: [] },
  memory: {
    records: [],
    counts: { working: 0, episodic: 0, semantic: 0, profile: 0 },
    architecture: ["working", "episodic", "semantic", "profile"],
  },
  daily: null,
  provider: null,
};

describe("Vault browser", () => {
  it("searches, previews inert Markdown and reacts to live change events", async () => {
    let emit: ((event: VaultChangeEventV2) => void) | undefined;
    const listVaultNotes = vi.fn(async () => ({
      configured: true,
      items: [{
        relative_path: "Notes/Unsafe.md",
        byte_count: 41,
        modified_unix_ms: Date.parse("2026-08-08T08:00:00Z"),
      }],
      total: 1,
      page: { limit: 100, has_more: false, next_cursor: null },
    }));
    const api = {
      pair: vi.fn(async () => undefined),
      loadDashboard: vi.fn(async () => snapshot),
      listVaultNotes,
      searchVaultNotes: vi.fn(async () => [{
        relative_path: "Notes/Unsafe.md",
        excerpt: "Review script safety",
        sha256: "a".repeat(64),
      }]),
      readVaultNote: vi.fn(async () => ({
        relative_path: "Notes/Unsafe.md",
        content: "# Safe preview\n\n<script>alert(1)</script>\n\n- [ ] Review",
        sha256: "a".repeat(64),
        byte_count: 57,
        output_is_untrusted: true as const,
      })),
      streamVaultEvents: vi.fn(async (
        onEvent: (event: VaultChangeEventV2) => void,
        signal: AbortSignal,
      ) => {
        emit = onEvent;
        onEvent({ type: "vault.ready", data: { file_count: 1 } });
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }),
    } as unknown as DashboardApi;
    const root = document.createElement("main");
    mountDashboard(root, { api, snapshot });

    root.querySelector<HTMLButtonElement>('[data-view="vault"]')?.click();
    await vi.waitFor(() => expect(root.querySelectorAll("[data-vault-path]")).toHaveLength(1));
    root.querySelector<HTMLButtonElement>("[data-vault-path]")?.click();
    await vi.waitFor(() => expect(root.querySelector(".vault-note")).not.toBeNull());

    const preview = root.querySelector<HTMLElement>("#vault-preview");
    expect(root.querySelector("#vault-file-list")?.getAttribute("tabindex")).toBe("0");
    expect(preview?.getAttribute("tabindex")).toBe("0");
    expect(preview?.textContent).toContain("<script>alert(1)</script>");
    expect(preview?.querySelector("script")).toBeNull();
    expect(preview?.querySelector("img, iframe, object")).toBeNull();
    expect(root.querySelector("#vault-live-status")?.textContent).toContain("Live");

    emit?.({
      type: "vault.changed",
      data: { changed_count: 1, modified: ["Notes/Unsafe.md"] },
    });
    await vi.waitFor(() => expect(listVaultNotes).toHaveBeenCalledTimes(2));

    root.querySelector<HTMLButtonElement>('[data-view="overview"]')?.click();
  });
});
