import { describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import type { DashboardApi, DashboardSnapshot } from "../src/api/types";

const snapshot: DashboardSnapshot = {
  runs: [],
  approvals: [],
  taskBoard: {
    configured: true,
    tasks: [
      {
        task_id: "task-1",
        relative_path: "Tasks.md",
        line_number: 3,
        text: "- [ ] Never render <script>alert(1)</script> #todo",
        completed: false,
        fields: { priority: "P1" },
        block_id: null,
        locator_hash: "hash",
      },
    ],
  },
  radar: { configured: true, items: [] },
  memory: {
    records: [],
    counts: { working: 0, episodic: 0, semantic: 0, profile: 0 },
    architecture: ["working", "episodic", "semantic", "profile"],
  },
  daily: null,
};

function fakeApi(): DashboardApi {
  return {
    pair: vi.fn(async () => undefined),
    loadDashboard: vi.fn(async () => snapshot),
    createRun: vi.fn(async () => {
      throw new Error("not used");
    }),
    decideApproval: vi.fn(async () => {
      throw new Error("not used");
    }),
    radarAction: vi.fn(async () => ({
      item: {} as never,
      run_id: null,
      research_artifact: null,
      task_preview_available: false,
      task_approval_id: null,
    })),
    previewTask: vi.fn(async () => {
      throw new Error("not used");
    }),
    captureTask: vi.fn(async () => {
      throw new Error("not used");
    }),
    applyTask: vi.fn(async () => {
      throw new Error("not used");
    }),
    musicCover: vi.fn(async () => null),
    events: vi.fn(async () => []),
  };
}

describe("authenticated workspace", () => {
  it("renders Core data as text and keeps browser storage empty", () => {
    const root = document.createElement("main");

    mountDashboard(root, { api: fakeApi(), snapshot });

    expect(root.textContent).toContain("Never render <script>alert(1)</script>");
    expect(root.querySelector("script")).toBeNull();
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it("switches between Core-owned views", () => {
    const root = document.createElement("main");
    mountDashboard(root, { api: fakeApi(), snapshot });

    root.querySelector<HTMLButtonElement>('[data-view="tasks"]')?.click();

    expect(root.querySelector<HTMLElement>('[data-view-panel="tasks"]')?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-view-panel="overview"]')?.hidden).toBe(true);
  });

  it("renders an accessible local clock and reduced-dependency daily context", () => {
    const root = document.createElement("main");
    mountDashboard(root, {
      api: fakeApi(),
      snapshot: {
        ...snapshot,
        daily: {
          weather: {
            configured: false,
            status: "not_configured",
            provider: "",
            location_label: "",
            condition: "",
            temperature_c: null,
            apparent_temperature_c: null,
            relative_humidity_percent: null,
            is_day: null,
            observed_at: null,
            expires_at: null,
            attribution: "",
            message: "Configure private weather.",
          },
          calendar: { configured: false, status: "not_configured", events: [], message: "Select ICS." },
          music: {
            configured: true,
            status: "ready",
            message: "",
            recommendation: {
              item_id: "synthetic-track",
              title: "Synthetic Track",
              artist: "Example Artist",
              album: "Demo Album",
              tags: ["focus"],
              analysis: "Selected from public synthetic metadata.",
              cover_available: false,
            },
          },
        },
      },
    });

    expect(root.querySelector("#clock-title")?.textContent).toContain("Roman numeral");
    expect(root.querySelector("#clock-text")?.textContent).not.toContain("读取");
    expect(root.textContent).toContain("Synthetic Track");
    const toggle = root.querySelector<HTMLButtonElement>("[data-music-toggle]");
    toggle?.click();
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector("[data-music-disc]")?.classList).toContain("is-playing");
  });

  it("turns a checkbox change into a Core preview instead of browser-owned state", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const preview = vi.spyOn(api, "previewTask").mockResolvedValue({} as never);
    mountDashboard(root, { api, snapshot });
    root.querySelector<HTMLButtonElement>('[data-view="tasks"]')?.click();

    const task = root.querySelector<HTMLInputElement>('[data-task-id="task-1"]');
    expect(task).not.toBeNull();
    if (task) {
      task.checked = true;
      task.dispatchEvent(new Event("change", { bubbles: true }));
    }

    await vi.waitFor(() => expect(preview).toHaveBeenCalledWith("task-1", true));
    expect(localStorage).toHaveLength(0);
  });

  it("launches a Radar Research run and renders its write-free preview", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const item = {
      item_id: "radar-1",
      lane: "papers" as const,
      title: "Synthetic evidence",
      source: "fixture",
      url: "https://example.com/evidence",
      summary: "",
      score: 1,
      published_at: null,
      state: "new",
      data_class: "public",
    };
    const artifact = {
      artifact_id: "research-synthetic",
      run_id: "run-synthetic",
      question: "Does <script>alert(1)</script> have evidence?",
      claims: [{
        claim_id: "claim-1",
        statement: "The source reports a bounded result.",
        kind: "grounded" as const,
        evidence_refs: ["evidence-1"],
        inference_basis: null,
      }],
      conflicts: [],
      unresolved_questions: [],
      related_notes: [],
      note_preview: {
        action: "create" as const,
        relative_path: "Research/Synthetic.md",
        expected_hash: null,
        markdown: "# Safe preview\n<script>alert(2)</script>\n",
        markdown_hash: "a".repeat(64),
      },
      metrics: {
        supported_claim_rate: 1,
        primary_source_ratio: 1,
        citation_correctness: 1,
        duplicate_sources: 0,
        related_note_count: 0,
        conflict_count: 0,
      },
    };
    vi.spyOn(api, "radarAction").mockResolvedValue({
      item,
      run_id: artifact.run_id,
      research_artifact: artifact,
      task_preview_available: false,
      task_approval_id: null,
    });
    mountDashboard(root, {
      api,
      snapshot: { ...snapshot, radar: { configured: true, items: [item] } },
    });
    root.querySelector<HTMLButtonElement>('[data-view="radar"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-radar-action="research"]')?.click();

    await vi.waitFor(() => expect(root.textContent).toContain("Safe preview"));
    expect(root.textContent).toContain("Preview only");
    expect(root.querySelector("script")).toBeNull();
    expect(api.radarAction).toHaveBeenCalledWith("radar-1", "research");
  });
});
