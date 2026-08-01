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
    prepareStudy: vi.fn(async () => {
      throw new Error("not used");
    }),
    submitStudyDiagnostic: vi.fn(async () => {
      throw new Error("not used");
    }),
    submitStudyPractice: vi.fn(async () => {
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

  it("runs diagnostic-first Study without rendering or retaining an answer", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    vi.spyOn(api, "createRun").mockResolvedValue({
      run_id: "run-study",
      task_id: "task-study",
      mode: "study",
      state: "planning",
      state_version: 1,
      stop_reason: null,
      created_at: "2026-08-02T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
    });
    vi.spyOn(api, "prepareStudy").mockResolvedValue({
      diagnostic_id: `study-diagnostic-${"1".repeat(24)}`,
      run_id: "run-study",
      objective: "Explain <script>alert(1)</script> Bayesian evidence",
      questions: [
        {
          question_id: `diagnostic-${"2".repeat(24)}`,
          prompt: "Rate readiness",
          response_kind: "rating",
        },
        {
          question_id: `diagnostic-${"3".repeat(24)}`,
          prompt: "Explain success",
          response_kind: "free_text",
        },
      ],
      source_snapshot_hash: null,
      created_at: "2026-08-02T00:00:00Z",
    });
    const artifact = {
      artifact_id: `study-${"4".repeat(24)}`,
      run_id: "run-study",
      readiness_signal: "developing" as const,
      objective: {
        objective_id: `objective-${"5".repeat(24)}`,
        outcome: "Explain Bayesian evidence",
        success_criteria: ["Explain without notes"],
      },
      prerequisites: [],
      related_notes: [],
      learning_path: [{
        step_id: `learning-step-${"6".repeat(24)}`,
        order: 1,
        title: "Build the model",
        outcome: "Explain it",
        note_refs: [],
      }],
      exercises: [{
        exercise_id: `exercise-${"7".repeat(24)}`,
        concept: "Bayesian evidence",
        kind: "active_recall" as const,
        prompt: "Explain <script>alert(2)</script> Bayesian evidence",
        hints: ["Name one boundary"],
        answer_revealed: false as const,
      }],
      metrics: {
        diagnostic_completed: true as const,
        explicit_prerequisite_ratio: 0,
        practice_count: 1,
        related_note_count: 0,
      },
      sensitivity: "public",
      created_at: "2026-08-02T00:00:00Z",
      validation_status: "valid" as const,
    };
    vi.spyOn(api, "submitStudyDiagnostic").mockResolvedValue(artifact);
    const practice = vi.spyOn(api, "submitStudyPractice").mockResolvedValue({
      attempt_id: `attempt-${"8".repeat(24)}`,
      run_id: "run-study",
      exercise_id: artifact.exercises[0].exercise_id,
      correct: false,
      feedback: "Use the hint before retrying.",
      error_count: 1,
      attempt_count: 1,
      next_review: {
        action: "retry_with_hint",
        due_at: "2026-08-02T00:10:00Z",
        interval_days: 0,
        reason: "A private rubric term was missing.",
      },
      record_preview: null,
      created_at: "2026-08-02T00:00:00Z",
    });
    mountDashboard(root, { api, snapshot });

    root.querySelector<HTMLButtonElement>('[data-mode="study"]')?.click();
    const goal = root.querySelector<HTMLInputElement>("#run-goal");
    if (goal) goal.value = "Explain Bayesian evidence";
    root.querySelector<HTMLFormElement>("#run-form")?.requestSubmit();
    await vi.waitFor(() => expect(root.textContent).toContain("DIAGNOSTIC FIRST"));
    expect(root.querySelector("script")).toBeNull();

    const diagnosticFields = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "[data-diagnostic-question]",
    );
    diagnosticFields[0].value = "2";
    diagnosticFields[1].value = "private diagnostic answer";
    root.querySelector<HTMLFormElement>("[data-study-diagnostic]")?.requestSubmit();
    await vi.waitFor(() => expect(root.textContent).toContain("VALIDATED STUDY PATH"));
    expect(root.querySelector("script")).toBeNull();
    expect(root.textContent).not.toContain("private diagnostic answer");

    const practiceForm = root.querySelector<HTMLFormElement>("[data-study-practice]");
    const response = practiceForm?.querySelector<HTMLTextAreaElement>('textarea[name="answer"]');
    if (response) response.value = "private practice answer";
    practiceForm?.requestSubmit();
    await vi.waitFor(() => expect(root.textContent).toContain("RETRY WITH HINT"));
    expect(practice).toHaveBeenCalledWith(
      "run-study",
      artifact.exercises[0].exercise_id,
      "private practice answer",
      3,
    );
    expect(response?.value).toBe("");
    expect(root.textContent).not.toContain("private practice answer");
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });
});
