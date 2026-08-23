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
        content: "# Safe preview\n\n<script>alert(1)</script>\n\n- **全参数微调：** 更新整个模型，参考 [[学习-LoRA]]\n- [ ] Review `inline-code`",
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
    expect(preview?.textContent).toContain("57 B · Markdown");
    expect(preview?.textContent).not.toContain("SHA-256");
    const bullet = preview?.querySelector<HTMLElement>(".vault-bullet");
    const task = preview?.querySelector<HTMLElement>(".vault-task");
    expect(bullet?.children).toHaveLength(2);
    expect(bullet?.querySelector(":scope > .vault-markdown-line")?.textContent)
      .toContain("全参数微调： 更新整个模型");
    expect(task?.children).toHaveLength(2);
    expect(task?.querySelector(":scope > .vault-markdown-line code")?.textContent)
      .toBe("inline-code");
    expect(root.querySelector("#vault-live-status")?.textContent).toContain("Live");

    emit?.({
      type: "vault.changed",
      data: { changed_count: 1, modified: ["Notes/Unsafe.md"] },
    });
    await vi.waitFor(() => expect(listVaultNotes).toHaveBeenCalledTimes(2));

    root.querySelector<HTMLButtonElement>('[data-view="overview"]')?.click();
  });

  it("keeps the most recently selected preview when reads finish out of order", async () => {
    const resolvers = new Map<string, (value: {
      relative_path: string;
      content: string;
      sha256: string;
      byte_count: number;
      output_is_untrusted: true;
    }) => void>();
    const api = {
      loadDashboard: vi.fn(async () => snapshot),
      listVaultNotes: vi.fn(async () => ({
        configured: true,
        items: ["First.md", "Second.md"].map((relative_path) => ({
          relative_path,
          byte_count: 8,
          modified_unix_ms: Date.parse("2026-08-08T08:00:00Z"),
        })),
        total: 2,
        page: { limit: 100, has_more: false, next_cursor: null },
      })),
      searchVaultNotes: vi.fn(async () => []),
      readVaultNote: vi.fn((relativePath: string) => new Promise((resolve) => {
        resolvers.set(relativePath, resolve);
      })),
    } as unknown as DashboardApi;
    const root = document.createElement("main");
    mountDashboard(root, { api, snapshot, locale: "zh-CN" });
    root.querySelector<HTMLButtonElement>('[data-view="vault"]')?.click();
    await vi.waitFor(() => expect(root.querySelectorAll("[data-vault-path]")).toHaveLength(2));

    root.querySelector<HTMLButtonElement>('[data-vault-path="First.md"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-vault-path="Second.md"]')?.click();
    await vi.waitFor(() => expect(resolvers.size).toBe(2));
    resolvers.get("Second.md")?.({
      relative_path: "Second.md",
      content: "# Second wins",
      sha256: "b".repeat(64),
      byte_count: 13,
      output_is_untrusted: true,
    });
    await vi.waitFor(() => expect(root.querySelector("#vault-preview")?.textContent).toContain("Second wins"));
    resolvers.get("First.md")?.({
      relative_path: "First.md",
      content: "# First finished late",
      sha256: "a".repeat(64),
      byte_count: 21,
      output_is_untrusted: true,
    });
    await Promise.resolve();

    expect(root.querySelector("#vault-preview")?.textContent).toContain("Second wins");
    expect(root.querySelector("#vault-preview")?.textContent).not.toContain("First finished late");
    root.remove();
  });
});
