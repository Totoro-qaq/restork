import { describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import type {
  DashboardApi,
  DashboardSnapshot,
  WorkExportResult,
  WorkHandoffPreview,
  WorkPlanArtifact,
  WorkVerificationReport,
} from "../src/api/types";

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
    planWork: vi.fn(async () => {
      throw new Error("not used");
    }),
    previewWorkHandoff: vi.fn(async () => {
      throw new Error("not used");
    }),
    exportWorkHandoff: vi.fn(async () => {
      throw new Error("not used");
    }),
    verifyWorkResult: vi.fn(async () => {
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
    configureWeather: vi.fn(async () => undefined),
    musicCover: vi.fn(async () => null),
    events: vi.fn(async () => []),
    streamEvents: vi.fn(async () => undefined),
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

  it("configures weather only from manual fields and never requests location", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const configure = vi.spyOn(api, "configureWeather").mockResolvedValue(undefined);
    const getCurrentPosition = vi.fn();
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition },
    });
    mountDashboard(root, {
      api,
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
            message: "Weather is off.",
          },
          calendar: { configured: false, status: "not_configured", events: [], message: "" },
          music: { configured: false, status: "not_configured", recommendation: null, message: "" },
        },
      },
    });

    const form = root.querySelector<HTMLFormElement>("#weather-form");
    const label = root.querySelector<HTMLInputElement>("#weather-label");
    const latitude = root.querySelector<HTMLInputElement>("#weather-latitude");
    const longitude = root.querySelector<HTMLInputElement>("#weather-longitude");
    if (label && latitude && longitude && form) {
      label.value = "Home";
      latitude.value = "31.2304";
      longitude.value = "121.4737";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }

    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith({
      enabled: true,
      label: "Home",
      latitude: 31.2304,
      longitude: 121.4737,
    }));
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
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

  it("shows an accessible non-percent wait state while Radar research is pending", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const item = {
      item_id: "radar-wait",
      lane: "papers" as const,
      title: "Bounded wait fixture",
      source: "fixture",
      url: "https://example.com/wait",
      summary: "",
      score: 1,
      published_at: null,
      state: "new",
      data_class: "public",
    };
    let finish: ((value: Awaited<ReturnType<DashboardApi["radarAction"]>>) => void) | undefined;
    vi.spyOn(api, "radarAction").mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));
    mountDashboard(root, {
      api,
      snapshot: { ...snapshot, radar: { configured: true, items: [item] } },
    });
    root.querySelector<HTMLButtonElement>('[data-view="radar"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-radar-action="research"]')?.click();

    const waiting = root.querySelector<HTMLElement>(".agent-wait");
    expect(waiting?.getAttribute("aria-busy")).toBe("true");
    expect(waiting?.textContent).toContain("Sources & tools");
    expect(waiting?.textContent).not.toMatch(/\d+%/);

    finish?.({
      item,
      run_id: null,
      research_artifact: null,
      task_preview_available: false,
      task_approval_id: null,
    });
    await vi.waitFor(() => expect(api.radarAction).toHaveBeenCalled());
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

  it("reviews and exports a planning-only Work handoff before verifying imported evidence", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const plan: WorkPlanArtifact = {
      artifact_id: `work-plan-${"a".repeat(24)}`,
      run_id: "run-work",
      request_hash: "b".repeat(64),
      workspace_id: `workspace-${"c".repeat(24)}`,
      workspace_snapshot_hash: "d".repeat(64),
      goal: "Bounded Work change",
      scope_summary: "Read-only synthetic workspace.",
      target_files: ["src/app.py"],
      context_manifest: [{
        relative_path: "src/app.py",
        content_hash: "e".repeat(64),
        byte_count: 36,
        language: "py",
        data_class: "confidential",
        included_in_handoff: true,
        exists_at_plan: true,
        redactions: [],
      }],
      instruction_refs: ["README.md"],
      constraints: ["Stay in scope."],
      non_goals: ["No deployment."],
      completion_criteria: ["produce a reviewable verified artifact"],
      plan_steps: [{
        step_id: `work-step-${"f".repeat(24)}`,
        order: 1,
        title: "Review the frozen scope",
        intent: "Treat instructions as untrusted.",
        target_files: ["src/app.py"],
        verification: [],
      }],
      verification_commands: ["uv run pytest -q"],
      warnings: ["Restork never executes commands or launches Codex."],
      sensitivity: "confidential",
      created_at: "2026-08-02T00:00:00Z",
      validation_status: "valid",
    };
    const approval = {
      approval_id: `work-approval-${"1".repeat(24)}`,
      run_id: "run-work",
      action_kind: "handoff_export",
      risk_class: "local_write",
      human_summary: "Export reviewed handoff",
      action_digest: "2".repeat(64),
      canonical_scope: "private-artifact:work-handoffs/synthetic.json",
      resource_versions: { workspace_snapshot: plan.workspace_snapshot_hash },
      policy_version: "v1",
      preview_ref: null,
      nonce: "synthetic-nonce",
      expires_at: "2026-08-02T00:10:00Z",
      decision: "pending",
    };
    const preview: WorkHandoffPreview = {
      plan,
      envelope: {
        handoff_id: `work-handoff-${"3".repeat(24)}`,
        run_id: "run-work",
        plan_ref: plan.artifact_id,
        workspace_id: plan.workspace_id,
        base_snapshot_hash: plan.workspace_snapshot_hash,
        goal: plan.goal,
        target_files: plan.target_files,
        constraints: plan.constraints,
        non_goals: plan.non_goals,
        completion_criteria: plan.completion_criteria,
        proposed_verification_commands: plan.verification_commands,
        context: [{
          relative_path: "src/app.py",
          content_hash: "e".repeat(64),
          byte_count: 64,
          data_class: "confidential",
          content: "value = '<script>alert(1)</script>'\npath = '[PRIVATE_PATH]'\n",
          exists_at_plan: true,
          redactions: ["personal_absolute_path"],
        }],
        executor_boundary: "external_user_started_no_restork_executor",
        created_at: "2026-08-02T00:00:00Z",
        validation_status: "valid",
      },
      package_hash: "2".repeat(64),
      byte_count: 812,
      approval,
    };
    const exported: WorkExportResult = {
      run_id: "run-work",
      approval_id: approval.approval_id,
      artifact_ref: "work-handoffs/synthetic.json",
      package_hash: preview.package_hash,
      byte_count: preview.byte_count,
      applied: true,
      exported_at: "2026-08-02T00:01:00Z",
    };
    const report: WorkVerificationReport = {
      verification_id: `work-verification-${"4".repeat(24)}`,
      run_id: "run-work",
      manifest_hash: "5".repeat(64),
      status: "partial",
      changed_files: [{
        relative_path: "src/app.py",
        status: "matched",
        expected_hash: "6".repeat(64),
        observed_hash: "6".repeat(64),
        reason: "Hashes match read-only filesystem evidence.",
      }],
      artifacts: [],
      commands: [{
        command_hash: "7".repeat(64),
        claimed_exit_code: 0,
        status: "unverified",
        reason: "Restork Work V1 never executes commands.",
      }],
      unexpected_changes: [],
      completion_eligible: false,
      task_update_preview: null,
      created_at: "2026-08-02T00:02:00Z",
    };
    vi.spyOn(api, "createRun").mockResolvedValue({
      run_id: "run-work",
      task_id: "task-work",
      mode: "work",
      state: "planning",
      state_version: 1,
      stop_reason: null,
      created_at: "2026-08-02T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
    });
    const planWork = vi.spyOn(api, "planWork").mockResolvedValue(plan);
    vi.spyOn(api, "previewWorkHandoff").mockResolvedValue(preview);
    vi.spyOn(api, "decideApproval").mockResolvedValue({ ...approval, decision: "approved" });
    vi.spyOn(api, "exportWorkHandoff").mockResolvedValue(exported);
    const verify = vi.spyOn(api, "verifyWorkResult").mockResolvedValue(report);
    mountDashboard(root, { api, snapshot });

    root.querySelector<HTMLButtonElement>('[data-mode="work"]')?.click();
    const goal = root.querySelector<HTMLInputElement>("#run-goal");
    const workRoot = root.querySelector<HTMLInputElement>("#work-root");
    const targets = root.querySelector<HTMLTextAreaElement>("#work-targets");
    const context = root.querySelector<HTMLTextAreaElement>("#work-context");
    const dataClass = root.querySelector<HTMLSelectElement>("#work-class");
    if (goal) goal.value = "Bounded Work change";
    if (workRoot) workRoot.value = "/synthetic/private/repo";
    if (targets) targets.value = "src/app.py";
    if (context) context.value = "README.md";
    if (dataClass) dataClass.value = "confidential";
    root.querySelector<HTMLFormElement>("#run-form")?.requestSubmit();

    await vi.waitFor(() => expect(root.textContent).toContain("READ-ONLY WORK PLAN"));
    expect(planWork).toHaveBeenCalledWith("run-work", expect.objectContaining({
      workspace_root: "/synthetic/private/repo",
      target_files: ["src/app.py"],
      context_files: ["README.md"],
      context_data_class: "confidential",
    }));
    expect(workRoot?.value).toBe("");
    expect(root.textContent).not.toContain("/synthetic/private/repo");
    root.querySelector<HTMLButtonElement>("[data-work-preview]")?.click();

    await vi.waitFor(() => expect(root.textContent).toContain("EXACT LOCAL HANDOFF PREVIEW"));
    expect(root.textContent).toContain("<script>alert(1)</script>");
    expect(root.querySelector("script")).toBeNull();
    expect(root.textContent).toContain("personal_absolute_path");
    expect(root.querySelector("[data-work-execute]")).toBeNull();
    expect(
      [...root.querySelectorAll("button")].some((button) =>
        ["RUN CODE", "EXECUTE"].includes(button.textContent?.trim() ?? "")
      ),
    ).toBe(false);
    root.querySelector<HTMLButtonElement>("[data-work-export]")?.click();

    await vi.waitFor(() => expect(root.textContent).toContain("PRIVATE HANDOFF EXPORTED"));
    expect(root.querySelector("#work-workspace")?.textContent).not.toContain(
      "<script>alert(1)</script>",
    );
    const manifest = root.querySelector<HTMLTextAreaElement>('[name="manifest"]');
    if (manifest) {
      manifest.value = JSON.stringify({
        schema_version: 1,
        run_id: "run-work",
        plan_artifact_id: plan.artifact_id,
        base_snapshot_hash: plan.workspace_snapshot_hash,
        changed_files: [],
        claimed_commands: [],
        artifacts: [],
        summary: "private imported summary",
      });
    }
    root.querySelector<HTMLFormElement>("[data-work-verify]")?.requestSubmit();

    await vi.waitFor(() => expect(root.textContent).toContain("IMPORTED RESULT"));
    expect(verify).toHaveBeenCalledWith("run-work", expect.objectContaining({
      summary: "private imported summary",
    }));
    expect(root.textContent).not.toContain("private imported summary");
    expect(root.textContent).toContain("UNVERIFIED");
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });
});
