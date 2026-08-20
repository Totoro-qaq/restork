import { mountDashboard } from "./main";
import type {
  AvailableToolsV2,
  ApprovalRequest,
  AiReportDraftInputV2,
  CatalogRecordV2,
  ConfigurationProfileRecordV2,
  ConversationOperationCreateResultV2,
  ConversationOperationV2,
  ContextPreviewRecordV2,
  DashboardApi,
  DashboardSnapshot,
  DeckFromReportInputV2,
  DeckDraftInputV2,
  ExtensionInstallPreviewV2,
  ManualReportInputV2,
  Mode,
  PersonalSettingsRecord,
  PromptRevisionRecordV2,
  ProviderProfileRecordV2,
  RadarAction,
  RadarActionResult,
  RadarConfiguration,
  RadarConfigurationInput,
  ProviderDiagnostic,
  RenderDownloadV2,
  RenderPreviewV2,
  ResearchArtifact,
  RunEvent,
  RunProposalV2,
  RunSummary,
  ScheduleRunV2,
  ScheduleSpecV2,
  SessionExportV2,
  SessionForkResultV2,
  SessionMessageV2,
  SessionRecordV2,
  SessionSearchHitV2,
  StudyArtifact,
  StudyDiagnostic,
  PracticeAttemptResult,
  TaskApplyResult,
  TaskMutationPreview,
  ToolCallPreviewV2,
  ToolExecutionV2,
  ToolSearchResultV2,
  VaultChangeEventV2,
  VaultNoteMetadataV2,
  VaultNotePageV2,
  VaultNotePreviewV2,
  VaultSearchHitV2,
  WorkExportResult,
  WorkHandoffPreview,
  WorkPlanArtifact,
  WorkVerificationReport,
} from "./api/types";

const NOW = "2026-08-02T03:00:00Z";

const demoVaultNotes = new Map<string, string>([
  [
    "Projects/Restork.md",
    "# Restork\n\nA local-first workspace for **Research**, **Study**, and **Work**.\n\n- Review effects before execution\n- Keep private Markdown local\n",
  ],
  [
    "Study/Durable agent loops.md",
    "# Durable agent loops\n\nA durable loop records state before effects and can resume without duplicating them.\n\n> Checkpoints are recovery boundaries, not memory.\n",
  ],
  [
    "Inbox/Reading queue.md",
    "# Reading queue\n\n- [ ] Compare focused context strategies\n- [ ] Review MCP sandbox results\n",
  ],
]);

const studyDiagnostic: StudyDiagnostic = {
  diagnostic_id: "study-diagnostic-demo",
  run_id: "demo-study",
  objective: "Understand durable agent loops",
  questions: [{
    question_id: "study-question-demo",
    prompt: "Which part of durable state recovery is least clear to you?",
    response_kind: "free_text",
  }],
  source_snapshot_hash: null,
  created_at: NOW,
};

const studyArtifact: StudyArtifact = {
  artifact_id: "study-artifact-demo",
  run_id: "demo-study",
  readiness_signal: "developing",
  objective: {
    objective_id: "study-objective-demo",
    outcome: "Explain and test a durable agent checkpoint loop",
    success_criteria: ["Recover without duplicate effects"],
  },
  prerequisites: [],
  related_notes: [],
  learning_path: [{
    step_id: "study-step-demo",
    order: 1,
    title: "Trace one checkpoint",
    outcome: "Identify the durable inputs and state transition.",
    note_refs: [],
  }],
  exercises: [{
    exercise_id: "study-exercise-demo",
    concept: "optimistic concurrency",
    kind: "active_recall",
    prompt: "Why must checkpoint writes compare an expected version?",
    hints: ["Think about duplicate effects."],
    answer_revealed: false,
  }],
  metrics: {
    diagnostic_completed: true,
    explicit_prerequisite_ratio: 0,
    practice_count: 1,
    related_note_count: 0,
  },
  note_preview: {
    action: "create",
    relative_path: "Restork Study - Durable Agent Checkpoint Loop.md",
    expected_hash: null,
    markdown: "# Durable agent checkpoint loop\n\n- Trace one checkpoint: identify durable inputs and the state transition.\n",
    markdown_hash: "1".repeat(64),
  },
  sensitivity: "personal",
  created_at: NOW,
  validation: { status: "validated", mechanism: "demo" },
};

const approval: ApprovalRequest = {
  approval_id: "approval-synthetic-note",
  run_id: "run-research-synthetic",
  action_kind: "vault_write",
  risk_class: "local_write",
  human_summary: "Append a source-backed evidence card to Research/Synthetic Local Agents.md",
  action_digest: "6c66daee616f19a795e33ef92d06ef5fd004b65a46f36a640f99bd8f4ef4f000",
  canonical_scope: "Research/Synthetic Local Agents.md",
  resource_versions: { "Research/Synthetic Local Agents.md": "synthetic-preimage" },
  policy_version: "v1",
  preview_ref: null,
  nonce: "synthetic-nonce",
  expires_at: "2026-08-02T03:10:00Z",
  decision: "pending",
};

const researchArtifact: ResearchArtifact = {
  artifact_id: "research-synthetic-preview",
  run_id: "run-research-synthetic",
  question: "How does the typed local agent harness preserve evidence?",
  claims: [
    {
      claim_id: "claim-synthetic-1",
      statement: "The fixture links each checked claim to a source card.",
      kind: "grounded",
      evidence_refs: ["evidence-synthetic-1"],
      inference_basis: null,
    },
    {
      claim_id: "claim-synthetic-2",
      statement: "This design may reduce unsupported synthesis during review.",
      kind: "inference",
      evidence_refs: [],
      inference_basis: "A labeled design inference, not a measured product claim.",
    },
  ],
  conflicts: [],
  unresolved_questions: ["How should citation correctness be sampled on larger fixtures?"],
  related_notes: [{ relative_path: "Research/Agent Harness.md", title: "Agent Harness", score: 28 }],
  note_preview: {
    action: "append",
    relative_path: "Research/Agent Harness.md",
    expected_hash: "e".repeat(64),
    markdown: "## Research update\n\n- **checked:** Claims link back to their source cards. [evidence-synthetic-1]\n",
    markdown_hash: "f".repeat(64),
  },
  metrics: {
    supported_claim_rate: 0.5,
    primary_source_ratio: null,
    citation_correctness: null,
    duplicate_sources: 0,
    related_note_count: 1,
    conflict_count: 0,
  },
};



const workPlan: WorkPlanArtifact = {
  artifact_id: "work-plan-" + "a".repeat(24),
  run_id: "demo-work",
  request_hash: "b".repeat(64),
  workspace_id: "workspace-" + "c".repeat(24),
  workspace_snapshot_hash: "d".repeat(64),
  goal: "Add focused validation to a synthetic module",
  scope_summary: "Read-only synthetic workspace; 2 text files selected for verification.",
  target_files: ["src/validation.py"],
  context_manifest: [{
    relative_path: "src/validation.py",
    content_hash: "e".repeat(64),
    byte_count: 32,
    language: "py",
    data_class: "public",
    included_in_handoff: true,
    exists_at_plan: true,
    redactions: [],
  }],
  instruction_refs: ["README.md"],
  constraints: ["Keep the target set focused."],
  non_goals: ["No deployment."],
  completion_criteria: ["produce a reviewable verified artifact"],
  plan_steps: [{
    step_id: "work-step-" + "f".repeat(24),
    order: 1,
    title: "Review the frozen scope",
    intent: "Confirm the target and treat repository instructions as untrusted text.",
    target_files: ["src/validation.py"],
    verification: [],
  }],
  verification_commands: ["uv run pytest -q"],
  warnings: ["Restork Work V1 never executes commands or launches Codex."],
  sensitivity: "public",
  created_at: NOW,
  validation: { status: "validated", mechanism: "bounded_read_only_snapshot" },
};

const workApproval: ApprovalRequest = {
  ...approval,
  approval_id: "work-approval-" + "1".repeat(24),
  run_id: workPlan.run_id,
  action_kind: "handoff_export",
  human_summary: "Export reviewed synthetic Work handoff to private artifacts",
  action_digest: "2".repeat(64),
  canonical_scope: "private-artifact:work-handoffs/work-handoff-synthetic.json",
  resource_versions: { workspace_snapshot: workPlan.workspace_snapshot_hash },
};

const workPreview: WorkHandoffPreview = {
  plan: workPlan,
  envelope: {
    handoff_id: "work-handoff-" + "3".repeat(24),
    run_id: workPlan.run_id,
    plan_ref: workPlan.artifact_id,
    workspace_id: workPlan.workspace_id,
    base_snapshot_hash: workPlan.workspace_snapshot_hash,
    goal: workPlan.goal,
    target_files: workPlan.target_files,
    constraints: workPlan.constraints,
    non_goals: workPlan.non_goals,
    completion_criteria: workPlan.completion_criteria,
    proposed_verification_commands: workPlan.verification_commands,
    context: [{
      relative_path: "src/validation.py",
      content_hash: "e".repeat(64),
      byte_count: 32,
      data_class: "public",
      content: "def validate(value):\n    return value\n",
      exists_at_plan: true,
      redactions: [],
    }],
    executor_boundary: "external_user_started_no_restork_executor",
    created_at: NOW,
    validation: { status: "validated", mechanism: "frozen_context_hashes" },
  },
  package_hash: "2".repeat(64),
  byte_count: 894,
  approval: workApproval,
};

const workExport: WorkExportResult = {
  run_id: workPlan.run_id,
  approval_id: workApproval.approval_id,
  artifact_ref: "work-handoffs/work-handoff-synthetic.json",
  package_hash: workPreview.package_hash,
  byte_count: workPreview.byte_count,
  applied: true,
  exported_at: NOW,
};

const workVerification: WorkVerificationReport = {
  verification_id: "work-verification-" + "4".repeat(24),
  run_id: workPlan.run_id,
  manifest_hash: "5".repeat(64),
  status: "verified",
  changed_files: [{
    relative_path: "src/validation.py",
    status: "matched",
    expected_hash: "6".repeat(64),
    observed_hash: "6".repeat(64),
    reason: "Preimage and postimage hashes match read-only filesystem evidence.",
  }],
  artifacts: [],
  commands: [],
  unexpected_changes: [],
  completion_eligible: true,
  task_update_preview: {
    run_id: workPlan.run_id,
    action: "mark_complete",
    suggested_markdown: `- [x] Verified Work result [run:: ${workPlan.run_id}]`,
    evidence_ref: "work-verification-" + "4".repeat(24),
    apply_available: false,
  },
  created_at: NOW,
};

const snapshot: DashboardSnapshot = {
  runs: [
    {
      summary: {
        run_id: "run-research-synthetic",
        task_id: "task-research-synthetic",
        mode: "research",
        state: "running",
        state_version: 4,
        stop_reason: null,
        created_at: "2026-08-02T02:44:00Z",
        updated_at: "2026-08-02T02:58:00Z",
      },
      task: {
        task_id: "task-research-synthetic",
        mode: "research",
        goal: "Compare local-first agent memory designs using public synthetic sources",
        workspace_scope: "demo-vault",
        completion_criteria: ["Every claim references evidence"],
        budgets: { max_steps: 12, max_wall_time_seconds: 3600, max_tokens: 120000 },
      },
      budget: {
        budget: { max_steps: 12, max_wall_time_seconds: 3600, max_tokens: 120000 },
        usage: { steps: 6, retries: 0, tokens: 43820, cost_usd: 0, child_tasks: 0 },
        wall_time_exceeded: false,
      },
    },
  ],
  approvals: [approval],
  taskBoard: {
    configured: true,
    tasks: [
      {
        task_id: "restork-reviewevidence",
        relative_path: "Projects/Restork.md",
        line_number: 18,
        text: "Review evidence coverage #todo [due:: 2026-08-03] [priority:: P1] ^restork-reviewevidence",
        completed: false,
        fields: { due: "2026-08-03", priority: "P1" },
        block_id: "restork-reviewevidence",
        locator_hash: "a".repeat(64),
      },
      {
        task_id: "restork-recallsession",
        relative_path: "Study/Queue.md",
        line_number: 7,
        text: "Run the next recall session #todo [priority:: P2] ^restork-recallsession",
        completed: false,
        fields: { priority: "P2" },
        block_id: "restork-recallsession",
        locator_hash: "b".repeat(64),
      },
    ],
  },
  radar: {
    configured: true,
    items: [
      {
        item_id: "radar-synthetic-star",
        lane: "trending",
        title: "Typed local agent harness",
        source: "GitHub · public AI/Agent fixture",
        url: "https://example.com/restork/synthetic-harness",
        summary: "A public synthetic repository used only for the product demo.",
        score: 0.94,
        published_at: "2026-08-01T09:00:00Z",
        state: "new",
        data_class: "public",
      },
      {
        item_id: "radar-synthetic-hn",
        lane: "hn",
        title: "What should an agent remember?",
        source: "HN · synthetic fixture",
        url: "https://example.com/restork/synthetic-discussion",
        summary: "A synthetic discussion about retention boundaries.",
        score: 0.82,
        published_at: "2026-08-02T01:30:00Z",
        state: "read_later",
        data_class: "public",
      },
    ],
  },
  memory: {
    records: [
      {
        memory_id: "episode-synthetic-research",
        layer: "episodic",
        kind: "decision",
        summary: "Keep source Markdown as truth; treat indexes as rebuildable projections.",
        provenance: "user",
        data_class: "public",
        retention_class: "session",
        updated_at: NOW,
        content_hash: "c".repeat(64),
      },
    ],
    counts: { working: 3, episodic: 1, semantic: 24, profile: 4 },
    architecture: ["working", "episodic", "semantic", "profile"],
  },
  daily: {
    weather: {
      configured: true,
      status: "fresh",
      provider: "open-meteo",
      location_label: "Demo City",
      condition: "Partly cloudy",
      temperature_c: 27.4,
      apparent_temperature_c: 29.1,
      relative_humidity_percent: 71,
      is_day: true,
      observed_at: NOW,
      expires_at: "2026-08-02T03:30:00Z",
      attribution: "Weather data by Open-Meteo · synthetic response",
      message: "",
    },
    calendar: {
      configured: true,
      status: "ready",
      events: [
        {
          event_id: "event-synthetic-review",
          title: "Review evidence cards",
          starts_at: "2026-08-02T04:00:00Z",
          ends_at: "2026-08-02T04:30:00Z",
          all_day: false,
          redacted: false,
        },
        {
          event_id: "event-synthetic-private",
          title: "Busy",
          starts_at: "2026-08-02T06:00:00Z",
          ends_at: "2026-08-02T07:00:00Z",
          all_day: false,
          redacted: true,
        },
      ],
      message: "",
    },
    music: {
      configured: true,
      status: "ready",
      recommendation: {
        item_id: "track-synthetic-paper",
        title: "Paper Lanterns",
        artist: "Example Artist",
        album: "Synthetic Sessions",
        tags: ["focus", "acoustic"],
        analysis: "Selected from a deterministic daily rotation and a user-authored focus tag.",
        recommendation_reason: "Selected from the private synthetic playlist by the stable daily rotation.",
        song_analysis: "A public synthetic fixture used to demonstrate the reviewable analysis layout.",
        popularity_reason: "Synthetic chart data is shown only to demonstrate the discovery panel.",
        language: "Cantonese",
        genre: "Pop",
        published_on: "2026-07-18",
        cover_available: false,
      },
      source: {
        provider: "synthetic",
        label: "Synthetic Cantonese playlist",
        item_count: 12,
        synced_at: NOW,
        public_url: "",
        refresh_supported: false,
        experimental: true,
      },
      discoveries: Array.from({ length: 5 }, (_, index) => ({
        item_id: `synthetic-discovery-${index + 1}`,
        title: `Synthetic discovery ${index + 1}`,
        artist: index % 2 ? "Harbour Signal" : "Paper Street",
        album: "Public Demo Fixtures",
        language: "Cantonese",
        genre: "Pop",
        label: "Synthetic label",
        published_on: "2026-07-25",
        chart_name: "Synthetic Cantonese chart",
        chart_rank: index + 2,
        chart_updated_on: "2026-08-02",
        affinity_artist: index % 2 ? "Harbour Signal" : "",
        affinity_count: index % 2 ? 2 : 0,
        recommendation_reason: "Public synthetic recommendation evidence.",
        song_analysis: "Public synthetic song metadata.",
        popularity_reason: "Public synthetic chart evidence.",
        source_url: `https://example.com/restork-demo/discovery-${index + 1}`,
      })),
      message: "",
    },
  },
  provider: {
    schema_version: 1,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    status: "ready",
    message: "Configuration and Keychain metadata are ready.",
    setup_command: "restorkd provider configure deepseek",
    config_present: true,
    config_valid: true,
    credential_present: true,
    connection_checked: false,
    connection_ok: null,
    model_available: null,
    smoke_checked: false,
    smoke_ok: null,
    restart_required: false,
    latency_ms: null,
    request_id: null,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
  },
  workspaceV2: {
    dailyContext: {
      observed_at: NOW,
      timezone: "Asia/Shanghai",
      local_date: "2026-08-02",
      local_time: "11:00:00",
      time_band: "morning",
    },
    personal: {
      settings: {
        display_name: "Totoro",
        locale: "en",
        timezone: "Asia/Shanghai",
        week_start: "monday",
        theme: "light",
      },
      version: 1,
      updated_at: NOW,
    },
    sessions: [{
      session_id: "session-demo-research",
      title: "Review a local-first agent paper",
      profile_id: "research-cloud",
      status: "active",
      version: 1,
      locale: "en",
      created_at: NOW,
      updated_at: NOW,
      archived_at: null,
    }],
    extensions: [{
      package_id: "skill.last-30-days",
      package_kind: "skill",
      state: "enabled",
      manifest_hash: "7".repeat(64),
      manifest: {
        schema_version: 1,
        id: "skill.last-30-days",
        version: "1.0.0",
        procedure: "skills/last-30-days.md",
        enabled_profiles: ["research-cloud"],
        requested_permissions: [],
        provenance: {
          license: "MIT",
          source: { kind: "catalog", catalog_id: "restork-reviewed" },
        },
      },
      installed_at: NOW,
      updated_at: NOW,
    }, {
      package_id: "mcp.paper-search",
      package_kind: "mcp",
      state: "enabled",
      manifest_hash: "8".repeat(64),
      manifest: {
        schema_version: 1,
        id: "mcp.paper-search",
        version: "1.2.0",
        enabled_profiles: ["research-cloud"],
        requested_permissions: ["network:https://api.semanticscholar.org"],
        secret_references: [],
        transport: {
          kind: "stdio",
          command: "/opt/restork/bin/paper-search-mcp",
          arguments: ["--read-only"],
        },
        sandbox: { network: ["api.semanticscholar.org"], filesystem: [] },
        tools: [{
          id: "paper.search",
          name: "Search reviewed papers",
          description: "Searches a focused public paper index.",
          input_schema: { type: "object", properties: { query: { type: "string" } } },
        }, {
          id: "paper.details",
          name: "Read paper metadata",
          description: "Reads metadata for one selected public paper.",
          input_schema: { type: "object", properties: { paper_id: { type: "string" } } },
        }],
        provenance: {
          license: "MIT",
          source: { kind: "catalog", catalog_id: "restork-reviewed" },
        },
      },
      installed_at: NOW,
      updated_at: NOW,
    }, {
      package_id: "plugin.obsidian-workbench",
      package_kind: "plugin",
      state: "quarantined",
      manifest_hash: "9".repeat(64),
      manifest: {
        schema_version: 1,
        id: "plugin.obsidian-workbench",
        version: "0.4.0",
        enabled_profiles: [],
        requested_permissions: ["filesystem:vault:read"],
        skills: [{ id: "obsidian.review", procedure: "skills/review.md" }],
        mcp_servers: [{
          id: "vault-reader",
          transport: { kind: "stdio", command: "/opt/restork/bin/vault-reader" },
          tools: [{ id: "vault.search", name: "Search selected Vault" }],
        }],
        provenance: {
          license: "MIT",
          source: { kind: "local", path: "extensions/obsidian-workbench" },
        },
      },
      installed_at: NOW,
      updated_at: NOW,
    }],
    deliverables: [{
      deliverable_id: "report.demo.weekly",
      kind: "weekly_report",
      state: "draft",
      revision: 1,
      artifact: { markdown: "# Weekly review\n\n- Evidence coverage improved.\n- MCP remains approval-bound." },
      updated_at: NOW,
    }, {
      deliverable_id: "deck.demo.weekly",
      kind: "deck",
      state: "draft",
      revision: 1,
      artifact: {
        title: "A reviewable local agent",
        claims: {
          "claim:local": { text: "Local knowledge" },
          "claim:approval": { text: "Exact approval" },
          "claim:sandbox": { text: "OS sandbox" },
        },
        slides: [{
          slide_id: "slide:why",
          role: "evidence",
          action_title: "Why it matters",
          claim_refs: ["claim:local", "claim:approval", "claim:sandbox"],
          speaker_notes: [],
        }],
      },
      updated_at: NOW,
    }],
    schedules: [{
      schedule_id: "daily.refresh.demo",
      state: "active",
      revision: 1,
      schedule: {
        timezone: "Asia/Shanghai",
        recurrence: { kind: "daily", hour: 8, minute: 30 },
        missed_run_policy: "create_draft",
        job: { kind: "deterministic", job: "daily.refresh" },
      },
      next_run_at: "2026-08-03T00:30:00Z",
      updated_at: NOW,
    }],
    providers: [{
      provider: {
        profile_id: "deepseek-main",
        version: 1,
        display_name: "DeepSeek V4 Pro",
        kind: "deepseek",
        base_url: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        secret_ref: "keychain:restork/provider/deepseek-main",
        fallback: "disabled",
        reasoning: { effort: "high", max_tokens: null },
      },
      revision: 1,
      updated_at: NOW,
    }],
    providerRegistry: {
      registry_version: 1,
      items: [{
        registry_version: 1,
        kind: "deepseek",
        id: "deepseek",
        display_name: "DeepSeek",
        protocol: "open_ai_chat_completions",
        default_base_url: "https://api.deepseek.com",
        endpoint_policy: "exact_official",
        auth_kind: "bearer",
        model_discovery: "open_ai_models",
        request_adapter: "deep_seek",
        capabilities: {
          streaming: true,
          tool_calls: true,
          json_output: true,
          reasoning: true,
          vision: false,
        },
        reasoning: {
          can_disable: true,
          supported_efforts: ["high", "max"],
          supports_token_budget: false,
        },
        docs_url: "https://api-docs.deepseek.com/",
        setup_command: "restorkd provider configure deepseek",
      }, {
        registry_version: 1,
        kind: "ollama",
        id: "ollama",
        display_name: "Ollama",
        protocol: "ollama_chat",
        default_base_url: "http://127.0.0.1:11434",
        endpoint_policy: "loopback_only",
        auth_kind: "none",
        model_discovery: "ollama_tags",
        request_adapter: "ollama",
        capabilities: {
          streaming: true,
          tool_calls: true,
          json_output: true,
          reasoning: true,
          vision: true,
        },
        reasoning: {
          can_disable: true,
          supported_efforts: ["low", "medium", "high"],
          supports_token_budget: false,
        },
        docs_url: "https://docs.ollama.com/",
        setup_command: "ollama serve",
      }],
    },
    profiles: [{
      profile: {
        profile_id: "research-cloud",
        version: 1,
        name: "Research Cloud",
        provider_profile_id: "deepseek-main",
        prompt_manifest_hash: "a".repeat(64),
        enabled_skill_ids: ["skill.last-30-days"],
        allowed_tools: ["paper.search", "paper.details"],
        memory_namespace: "research",
        maximum_data_class: "public",
        include_display_name_in_prompt: false,
      },
      revision: 1,
      builtin: false,
      updated_at: NOW,
    }],
    prompts: [{
      prompt: {
        prompt_id: "personal",
        revision: 1,
        layer: "personal",
        content: "Prefer concise evidence cards and distinguish facts from inferences.",
        content_hash: "a".repeat(64),
        parent_hash: null,
        created_at: NOW,
      },
      content_hash: "a".repeat(64),
      active: true,
      created_at: NOW,
    }],
  },
};

const demoMessages = new Map<string, SessionMessageV2[]>([[
  "session-demo-research",
  [{
    message_id: "message-demo-user",
    session_id: "session-demo-research",
    sequence: 1,
    role: "user",
    content: "Compare the paper's claims with the local notes and keep citations visible.",
    context: { tool_access: false },
    data_class: "public",
    created_at: NOW,
  }, {
    message_id: "message-demo-assistant",
    session_id: "session-demo-research",
    sequence: 2,
    role: "assistant",
    content: "I can prepare a source-backed comparison. No tool will run until its exact call is reviewed.",
    context: { tool_access: false, synthetic: true },
    data_class: "public",
    created_at: NOW,
  }],
]]);

interface DemoOperation {
  operation: ConversationOperationV2;
  content: string;
  dataClass: "public" | "personal" | "confidential";
  cancelled: boolean;
}

const demoOperations = new Map<string, DemoOperation>();
let demoSequence = 1;

function workspace() {
  if (!snapshot.workspaceV2) throw new Error("Demo workspace is unavailable");
  return snapshot.workspaceV2;
}

function demoTimestamp(): string {
  return new Date(Date.now() + demoSequence * 1_000).toISOString();
}

function demoDigest(seed: string): string {
  const alphabet = "0123456789abcdef";
  let output = "";
  for (let index = 0; index < 64; index += 1) {
    output += alphabet[(seed.charCodeAt(index % Math.max(seed.length, 1)) + index) % 16];
  }
  return output;
}

function demoSession(sessionId: string): SessionRecordV2 {
  const session = workspace().sessions.find((candidate) => candidate.session_id === sessionId);
  if (!session) throw new Error("Synthetic conversation not found");
  return session;
}

function demoToolRecords(): Array<{
  id: string;
  name: string;
  packageId: string;
  serverId: string;
  permissions: string[];
}> {
  return workspace().extensions.flatMap((extension) => {
    if (extension.state !== "enabled") return [];
    const manifest = extension.manifest ?? {};
    const packageId = typeof manifest.id === "string"
      ? manifest.id
      : extension.package_id ?? "extension";
    const permissions = Array.isArray(manifest.requested_permissions)
      ? manifest.requested_permissions.filter((value): value is string => typeof value === "string")
      : [];
    const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
    const direct = tools.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const tool = value as Record<string, unknown>;
      const id = typeof tool.id === "string" ? tool.id : "unnamed-tool";
      return [{
        id,
        name: typeof tool.name === "string" ? tool.name : id,
        packageId,
        serverId: packageId,
        permissions,
      }];
    });
    const servers = Array.isArray(manifest.mcp_servers) ? manifest.mcp_servers : [];
    const nested = servers.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const server = value as Record<string, unknown>;
      const serverId = typeof server.id === "string" ? server.id : packageId;
      return (Array.isArray(server.tools) ? server.tools : []).flatMap((toolValue) => {
        if (!toolValue || typeof toolValue !== "object" || Array.isArray(toolValue)) return [];
        const tool = toolValue as Record<string, unknown>;
        const id = typeof tool.id === "string" ? tool.id : "unnamed-tool";
        return [{
          id,
          name: typeof tool.name === "string" ? tool.name : id,
          packageId,
          serverId,
          permissions,
        }];
      });
    });
    return [...direct, ...nested];
  });
}

async function demoPause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Synthetic stream cancelled", "AbortError"));
    }, { once: true });
  });
}

class DemoApi implements DashboardApi {
  async pair(): Promise<void> {}
  async loadDashboard(): Promise<DashboardSnapshot> { return snapshot; }
  async listVaultNotes(cursor = "0"): Promise<VaultNotePageV2> {
    const offset = Number(cursor) || 0;
    const records: VaultNoteMetadataV2[] = [...demoVaultNotes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, content], index) => ({
        relative_path: relativePath,
        byte_count: new TextEncoder().encode(content).byteLength,
        modified_unix_ms: Date.parse(NOW) + index * 1_000,
      }));
    const items = records.slice(offset, offset + 100);
    return {
      configured: true,
      items,
      total: records.length,
      page: {
        limit: 100,
        has_more: offset + items.length < records.length,
        next_cursor: offset + items.length < records.length ? String(offset + items.length) : null,
      },
    };
  }
  async searchVaultNotes(query: string): Promise<VaultSearchHitV2[]> {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return [...demoVaultNotes.entries()].flatMap(([relativePath, content]) => {
      const text = `${relativePath}\n${content}`.toLocaleLowerCase();
      if (!terms.every((term) => text.includes(term))) return [];
      return [{
        relative_path: relativePath,
        excerpt: content.replace(/[#*_>`\n-]+/g, " ").trim().slice(0, 180),
        sha256: demoDigest(`${relativePath}:${content}`),
      }];
    });
  }
  async readVaultNote(relativePath: string): Promise<VaultNotePreviewV2> {
    const content = demoVaultNotes.get(relativePath);
    if (!content) throw new Error("Synthetic Vault note not found");
    return {
      relative_path: relativePath,
      content,
      sha256: demoDigest(`${relativePath}:${content}`),
      byte_count: new TextEncoder().encode(content).byteLength,
      output_is_untrusted: true,
    };
  }
  async streamVaultEvents(
    onEvent: (event: VaultChangeEventV2) => void,
    signal: AbortSignal,
  ): Promise<void> {
    onEvent({ type: "vault.ready", data: { file_count: demoVaultNotes.size } });
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async createRun(mode: Mode, goal: string): Promise<RunSummary> {
    return { ...snapshot.runs[0].summary, run_id: `demo-${mode}`, mode, task_id: goal };
  }
  async listAvailableTools(): Promise<AvailableToolsV2> {
    return {
      tools: ["web_search", "vault_search", "source_read", "vault_write"],
      web_search_supported: true,
      x_search_supported: false,
      x_search_status: "not_installed",
    };
  }
  async prepareStudy(): Promise<StudyDiagnostic> { return studyDiagnostic; }
  async submitStudyDiagnostic(): Promise<StudyArtifact> { return studyArtifact; }
  async submitStudyPractice(
    runId: string,
    exerciseId: string,
  ): Promise<PracticeAttemptResult> {
    return {
      attempt_id: "study-attempt-demo",
      run_id: runId,
      exercise_id: exerciseId,
      correct: true,
      feedback: "The response addresses the concurrency risk.",
      error_count: 0,
      attempt_count: 1,
      next_review: {
        action: "spaced_review",
        due_at: NOW,
        interval_days: 3,
        reason: "Scheduled for spaced review.",
      },
      record_preview: null,
      created_at: NOW,
    };
  }
  async planWork(): Promise<WorkPlanArtifact> {
    return workPlan;
  }
  async previewWorkHandoff(): Promise<WorkHandoffPreview> { return workPreview; }
  async exportWorkHandoff(): Promise<WorkExportResult> { return workExport; }
  async verifyWorkResult(): Promise<WorkVerificationReport> { return workVerification; }
  async decideApproval(
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<ApprovalRequest> {
    return { ...approval, approval_id: approvalId, decision: decision === "approve" ? "approved" : "denied" };
  }
  async radarAction(itemId: string, action: RadarAction): Promise<RadarActionResult> {
    const item = snapshot.radar.items.find((candidate) => candidate.item_id === itemId)
      ?? snapshot.radar.items[0];
    return {
      item,
      run_id: action === "research" ? researchArtifact.run_id : null,
      research_artifact: action === "research" ? researchArtifact : null,
      task_preview_available: false,
      task_approval_id: null,
    };
  }
  async configureRadar(input: RadarConfigurationInput): Promise<RadarConfiguration> {
    return { ...input };
  }
  async cancelRun(): Promise<void> {}
  async previewTask(): Promise<TaskMutationPreview> { return {} as TaskMutationPreview; }
  async captureTask(): Promise<TaskMutationPreview> { return {} as TaskMutationPreview; }
  async previewResearchNote(): Promise<TaskMutationPreview> { return {} as TaskMutationPreview; }
  async previewStudyNote(): Promise<TaskMutationPreview> { return {} as TaskMutationPreview; }
  async applyTask(approvalId: string): Promise<TaskApplyResult> {
    return { approval_id: approvalId, task_id: "synthetic", relative_path: "Tasks.md", content_hash: "d".repeat(64), applied: true };
  }
  async configureWeather() {
    return {
      configured: true,
      location_label: "Synthetic location",
      latitude: 0,
      longitude: 0,
    };
  }
  async configureCalendar() { return snapshot.daily!.calendar; }
  async createSession(title: string, profileId: string): Promise<SessionRecordV2> {
    demoSequence += 1;
    const session: SessionRecordV2 = {
      session_id: `session-demo-${demoSequence}`,
      title,
      profile_id: profileId,
      status: "active",
      version: 1,
      locale: "en",
      created_at: demoTimestamp(),
      updated_at: demoTimestamp(),
      archived_at: null,
    };
    workspace().sessions.unshift(session);
    demoMessages.set(session.session_id, []);
    return session;
  }
  async forkSession(
    sessionId: string,
    title: string,
    profileId: string,
  ): Promise<SessionForkResultV2> {
    const sourceMessages = demoMessages.get(sessionId) ?? [];
    const session = await this.createSession(title, profileId);
    const copied = sourceMessages.slice(-24).map((message, index) => ({
      ...message,
      message_id: `message-demo-fork-${demoSequence}-${index + 1}`,
      session_id: session.session_id,
      sequence: index + 1,
      context: { branched_from: sessionId, tool_access: false },
    }));
    demoMessages.set(session.session_id, copied);
    return {
      session,
      source_session_id: sessionId,
      copied_messages: copied.length,
      omitted_messages: Math.max(0, sourceMessages.length - copied.length),
      copied_bytes: copied.reduce((total, message) => total + message.content.length, 0),
      profile_id: profileId,
    };
  }
  async sessionMessages(sessionId: string): Promise<SessionMessageV2[]> {
    return [...(demoMessages.get(sessionId) ?? [])];
  }
  async sendSessionMessage(
    sessionId: string,
    content: string,
    dataClass: "public" | "personal" | "confidential" = "public",
  ): Promise<SessionMessageV2> {
    const messages = demoMessages.get(sessionId) ?? [];
    const message: SessionMessageV2 = {
      message_id: `message-demo-${demoSequence += 1}`,
      session_id: sessionId,
      sequence: messages.length + 1,
      role: "user",
      content,
      context: { tool_access: false, synthetic: true },
      data_class: dataClass,
      created_at: demoTimestamp(),
    };
    messages.push(message);
    demoMessages.set(sessionId, messages);
    return message;
  }
  async createConversationTurn(
    sessionId: string,
    content: string,
    dataClass: "public" | "personal" | "confidential" = "public",
    contextPreviewHash: string | null = null,
  ): Promise<ConversationOperationCreateResultV2> {
    const userMessage = await this.sendSessionMessage(sessionId, content, dataClass);
    const operationId = `operation-demo-${demoSequence += 1}`;
    const operation: ConversationOperationV2 = {
      operation_id: operationId,
      session_id: sessionId,
      user_message_id: userMessage.message_id,
      assistant_message_id: null,
      state: "queued",
      phase: "queued",
      context_preview_hash: contextPreviewHash,
      provider_binding: { synthetic: true },
      cancel_requested: false,
      error_code: null,
      created_at: demoTimestamp(),
      updated_at: demoTimestamp(),
      completed_at: null,
    };
    demoOperations.set(operationId, { operation, content, dataClass, cancelled: false });
    return { operation, user_message: userMessage, replayed: false };
  }
  async streamConversationOperation(
    operationId: string,
    _after: number,
    onEvent: (event: RunEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const pending = demoOperations.get(operationId);
    if (!pending) throw new Error("Synthetic operation not found");
    onEvent({ id: 1, type: "conversation.model_started", data: { phase: "model" } });
    await demoPause(320, signal);
    if (pending.cancelled) return;
    onEvent({ id: 2, type: "conversation.validating", data: { phase: "validating" } });
    await demoPause(220, signal);
    if (pending.cancelled) return;
    const messages = demoMessages.get(pending.operation.session_id) ?? [];
    const assistant: SessionMessageV2 = {
      message_id: `message-demo-${demoSequence += 1}`,
      session_id: pending.operation.session_id,
      sequence: messages.length + 1,
      role: "assistant",
      content: "Synthetic response: I separated the claim, evidence, and open question. Tool access stayed off during this model turn.",
      context: { synthetic: true, tool_access: false },
      data_class: pending.dataClass,
      created_at: demoTimestamp(),
    };
    messages.push(assistant);
    demoMessages.set(pending.operation.session_id, messages);
    pending.operation.assistant_message_id = assistant.message_id;
    pending.operation.state = "completed";
    pending.operation.phase = "completed";
    pending.operation.completed_at = assistant.created_at;
  }
  async cancelConversationOperation(operationId: string): Promise<ConversationOperationV2> {
    const pending = demoOperations.get(operationId);
    if (!pending) throw new Error("Synthetic operation not found");
    pending.cancelled = true;
    pending.operation.cancel_requested = true;
    pending.operation.state = "cancelled";
    pending.operation.phase = "cancelled";
    pending.operation.error_code = "cancelled";
    pending.operation.completed_at = demoTimestamp();
    return pending.operation;
  }
  async createContextPreview(
    sessionId: string,
    dataClass: "public" | "personal" | "confidential",
    items: Array<{ name: string; content: string }>,
  ): Promise<ContextPreviewRecordV2> {
    const entries = items.map((item) => ({
      name: item.name,
      content_hash: demoDigest(item.content),
      byte_count: new TextEncoder().encode(item.content).byteLength,
      content: item.content,
    }));
    const byteCount = entries.reduce((total, entry) => total + entry.byte_count, 0);
    return {
      preview_id: `context-demo-${demoSequence += 1}`,
      session_id: sessionId,
      content_hash: demoDigest(JSON.stringify(entries)),
      manifest: {
        schema_version: 1,
        boundary: "explicit_demo_files",
        untrusted: true,
        entries,
      },
      data_class: dataClass,
      byte_count: byteCount,
      estimated_tokens: Math.ceil(byteCount / 4),
      created_at: demoTimestamp(),
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      used_operation_id: null,
    };
  }
  async createSessionProposal(
    sessionId: string,
    mode: Mode,
    goal: string,
    dataClass: "public" | "personal" | "confidential" = "public",
  ): Promise<RunProposalV2> {
    return {
      proposal_id: `proposal-demo-${demoSequence += 1}`,
      session_id: sessionId,
      profile_id: demoSession(sessionId).profile_id,
      mode,
      goal,
      completion_criteria: ["Produce a reviewable artifact with evidence labels"],
      requested_data_class: dataClass,
      requested_tools: [],
      sources: [],
      intake_boundary: {
        network_access: false,
        file_access: false,
        provider_access: false,
        tool_access: false,
      },
      status: "review_required",
      version: 1,
      created_at: demoTimestamp(),
    };
  }
  async savePersonalSettings(
    expectedVersion: number | null,
    settings: PersonalSettingsRecord["settings"],
  ): Promise<PersonalSettingsRecord> {
    const record = {
      settings,
      version: (expectedVersion ?? 0) + 1,
      updated_at: demoTimestamp(),
    };
    workspace().personal = record;
    return record;
  }
  async saveProviderProfile(
    expectedRevision: number | null,
    provider: ProviderProfileRecordV2["provider"],
  ): Promise<ProviderProfileRecordV2> {
    const record = { provider, revision: (expectedRevision ?? 0) + 1, updated_at: demoTimestamp() };
    workspace().providers = [
      ...(workspace().providers ?? []).filter((item) => item.provider.profile_id !== provider.profile_id),
      record,
    ];
    return record;
  }
  async saveConfigurationProfile(
    expectedRevision: number | null,
    profile: ConfigurationProfileRecordV2["profile"],
  ): Promise<ConfigurationProfileRecordV2> {
    const record = {
      profile,
      revision: (expectedRevision ?? 0) + 1,
      builtin: false,
      updated_at: demoTimestamp(),
    };
    workspace().profiles = [
      ...(workspace().profiles ?? []).filter((item) => item.profile.profile_id !== profile.profile_id),
      record,
    ];
    return record;
  }
  async createPromptRevision(
    promptId: string,
    expectedRevision: number | null,
    layer: "skill" | "personal",
    content: string,
  ): Promise<PromptRevisionRecordV2> {
    const revision = (expectedRevision ?? 0) + 1;
    const contentHash = demoDigest(content);
    const record: PromptRevisionRecordV2 = {
      prompt: {
        prompt_id: promptId,
        revision,
        layer,
        content,
        content_hash: contentHash,
        parent_hash: null,
        created_at: demoTimestamp(),
      },
      content_hash: contentHash,
      active: false,
      created_at: demoTimestamp(),
    };
    workspace().prompts = [...(workspace().prompts ?? []), record];
    return record;
  }
  async activatePromptRevision(
    promptId: string,
    revision: number,
  ): Promise<PromptRevisionRecordV2> {
    const prompts = workspace().prompts ?? [];
    prompts.forEach((item) => {
      if (item.prompt.prompt_id === promptId) item.active = item.prompt.revision === revision;
    });
    const record = prompts.find((item) => item.prompt.prompt_id === promptId && item.prompt.revision === revision);
    if (!record) throw new Error("Synthetic prompt revision not found");
    return record;
  }
  async archiveSession(sessionId: string): Promise<SessionRecordV2> {
    const session = demoSession(sessionId);
    session.status = "archived";
    session.version += 1;
    session.archived_at = demoTimestamp();
    return session;
  }
  async deleteSession(sessionId: string): Promise<void> {
    workspace().sessions = workspace().sessions.filter((session) => session.session_id !== sessionId);
    demoMessages.delete(sessionId);
  }
  async exportSession(sessionId: string): Promise<SessionExportV2> {
    return {
      schema_version: 1,
      session: demoSession(sessionId),
      messages: await this.sessionMessages(sessionId),
      exported_at: demoTimestamp(),
      secret_values_included: false,
      note: "Synthetic local export; no credential values are included.",
    };
  }
  async searchSessions(query: string): Promise<SessionSearchHitV2[]> {
    const normalized = query.toLocaleLowerCase();
    return workspace().sessions.filter((session) => session.title.toLocaleLowerCase().includes(normalized))
      .map((session) => ({
        kind: "session",
        session_id: session.session_id,
        title: session.title,
        excerpt: `Profile ${session.profile_id}`,
        score: 1,
      }));
  }
  async previewExtensionInstall(
    packageKind: "skill" | "mcp" | "plugin",
    manifest: Record<string, unknown>,
  ): Promise<ExtensionInstallPreviewV2> {
    const id = typeof manifest.id === "string" ? manifest.id : "unnamed-extension";
    return {
      state: "review_required",
      installation_started: false,
      preview_digest: demoDigest(`${packageKind}:${JSON.stringify(manifest)}`),
      preview: {
        package_kind: packageKind,
        package_id: id,
        manifest,
        status: { state: "quarantined", reason: "awaiting_install_review" },
        secret_values_included: false,
      },
    };
  }
  async installExtension(
    packageKind: "skill" | "mcp" | "plugin",
    manifest: Record<string, unknown>,
    approvedPreviewDigest: string,
  ): Promise<CatalogRecordV2> {
    const record: CatalogRecordV2 = {
      package_id: typeof manifest.id === "string" ? manifest.id : `extension.demo.${demoSequence += 1}`,
      package_kind: packageKind,
      state: "quarantined",
      manifest_hash: approvedPreviewDigest,
      manifest,
      installed_at: demoTimestamp(),
      updated_at: demoTimestamp(),
    };
    workspace().extensions.unshift(record);
    return record;
  }
  async setExtensionState(
    packageId: string,
    action: "enable" | "disable",
  ): Promise<CatalogRecordV2> {
    const record = workspace().extensions.find((item) => item.package_id === packageId);
    if (!record) throw new Error("Synthetic extension not found");
    record.state = action === "enable" ? "enabled" : "disabled";
    record.updated_at = demoTimestamp();
    return record;
  }
  async extensionRevisions(packageId: string): Promise<CatalogRecordV2[]> {
    return workspace().extensions.filter((item) => item.package_id === packageId);
  }
  async rollbackExtension(
    packageId: string,
    _expectedHash: string,
    targetHash: string,
  ): Promise<CatalogRecordV2> {
    const record = workspace().extensions.find((item) => item.package_id === packageId);
    if (!record) throw new Error("Synthetic extension not found");
    record.manifest_hash = targetHash;
    record.state = "quarantined";
    record.updated_at = demoTimestamp();
    return record;
  }
  async searchSessionTools(sessionId: string, query: string): Promise<ToolSearchResultV2> {
    const allowed = new Set(
      workspace().profiles?.find((record) => record.profile.profile_id === demoSession(sessionId).profile_id)
        ?.profile.allowed_tools ?? [],
    );
    const normalized = query.toLocaleLowerCase();
    const items = demoToolRecords().filter((tool) => (
      allowed.has(tool.id)
      && `${tool.id} ${tool.name}`.toLocaleLowerCase().includes(normalized)
    )).map((tool, index) => ({ tool_id: tool.id, name: tool.name, score: 100 - index }));
    return { session_id: sessionId, catalog_fingerprint: "c".repeat(64), items };
  }
  async previewSessionToolCall(
    _sessionId: string,
    toolId: string,
    input: Record<string, unknown>,
  ): Promise<ToolCallPreviewV2> {
    const tool = demoToolRecords().find((candidate) => candidate.id === toolId);
    if (!tool) throw new Error("Synthetic tool not found");
    return {
      state: "review_required",
      execution_started: false,
      output_is_untrusted: true,
      call_digest: demoDigest(`${toolId}:${JSON.stringify(input)}`),
      resolved_call: {
        real_tool_id: tool.id,
        package_id: tool.packageId,
        package_version: "1.2.0",
        server_id: tool.serverId,
        required_permissions: tool.permissions,
        input,
      },
    };
  }
  async executeSessionToolCall(
    sessionId: string,
    preview: ToolCallPreviewV2,
  ): Promise<ToolExecutionV2> {
    return {
      execution_id: `execution-demo-${demoSequence += 1}`,
      session_id: sessionId,
      tool_id: preview.resolved_call.real_tool_id,
      package_id: preview.resolved_call.package_id,
      package_hash: "8".repeat(64),
      catalog_fingerprint: "c".repeat(64),
      call_digest: preview.call_digest,
      state: "succeeded",
      result: { synthetic: true, records: [] },
      error_code: null,
      started_at: demoTimestamp(),
      completed_at: demoTimestamp(),
    };
  }
  async composeManualReport(input: ManualReportInputV2): Promise<CatalogRecordV2> {
    const record: CatalogRecordV2 = {
      deliverable_id: input.report_id,
      kind: `${input.kind}_report`,
      state: "draft",
      revision: input.revision,
      artifact: {
        markdown: `# ${input.title}\n\n${input.entries.map((entry) => `- ${entry.text}`).join("\n")}`,
      },
      updated_at: demoTimestamp(),
    };
    workspace().deliverables.unshift(record);
    return record;
  }
  async composeAiReportDraft(input: AiReportDraftInputV2): Promise<CatalogRecordV2> {
    return this.composeManualReport({
      ...input,
      entries: [{ section: "summary", text: "Synthetic AI draft from verified demo runs." }],
    });
  }
  async composeDeckFromReport(input: DeckFromReportInputV2): Promise<CatalogRecordV2> {
    const record: CatalogRecordV2 = {
      deliverable_id: input.deck_id,
      kind: "deck",
      state: "draft",
      revision: input.revision,
      artifact: {
        source_report_id: input.report_id,
        audience: input.audience,
        slides: [{ title: "Synthetic deck", body: ["Evidence first", "Review before export"] }],
      },
      updated_at: demoTimestamp(),
    };
    workspace().deliverables.unshift(record);
    return record;
  }
  async composeDeckDraft(input: DeckDraftInputV2): Promise<CatalogRecordV2> {
    const record: CatalogRecordV2 = {
      deliverable_id: input.deck_id,
      kind: "deck",
      state: "outline_review",
      revision: input.revision,
      artifact: {
        theme: { theme_id: input.theme_id },
        claims: { "claim:brief": { text: input.brief } },
        slides: [
          { slide_id: "slide:title", role: "title", action_title: input.title, claim_refs: [], speaker_notes: [] },
          { slide_id: "slide:brief", role: "evidence", action_title: input.brief.slice(0, 100), claim_refs: ["claim:brief"], speaker_notes: [] },
        ],
      },
      updated_at: demoTimestamp(),
    };
    workspace().deliverables.unshift(record);
    return record;
  }
  async previewDeliverableRender(
    deliverableId: string,
    revision: number,
    format: "pptx" | "pdf",
  ): Promise<RenderPreviewV2> {
    return {
      state: "review_required",
      download_started: false,
      manifest: {
        renderer_id: "restork-demo-renderer",
        renderer_version: "1.0.0",
        format,
        deck_id: deliverableId,
        deck_revision: revision,
        deck_spec_hash: "d".repeat(64),
        artifact_hash: "e".repeat(64),
        byte_count: 128,
        macro_free: true,
        deterministic: true,
      },
    };
  }
  async exportDeliverableRender(preview: RenderPreviewV2): Promise<RenderDownloadV2> {
    return {
      blob: new Blob(["Synthetic Restork render"], { type: "application/octet-stream" }),
      filename: `${preview.manifest.deck_id}.${preview.manifest.format}`,
      artifactHash: preview.manifest.artifact_hash,
    };
  }
  async createSchedule(schedule: ScheduleSpecV2): Promise<CatalogRecordV2> {
    const record: CatalogRecordV2 = {
      schedule_id: schedule.schedule_id,
      state: "active",
      revision: 1,
      schedule: { ...schedule },
      next_run_at: demoTimestamp(),
      updated_at: demoTimestamp(),
    };
    workspace().schedules.unshift(record);
    return record;
  }
  async changeScheduleState(
    scheduleId: string,
    action: "pause" | "resume",
  ): Promise<CatalogRecordV2> {
    const record = workspace().schedules.find((item) => item.schedule_id === scheduleId);
    if (!record) throw new Error("Synthetic schedule not found");
    record.state = action === "pause" ? "paused" : "active";
    record.revision = (record.revision ?? 0) + 1;
    record.updated_at = demoTimestamp();
    return record;
  }
  async runScheduleNow(scheduleId: string): Promise<ScheduleRunV2> {
    return {
      schedule_id: scheduleId,
      period_key: "demo-now",
      run_id: null,
      result: { synthetic: true, status: "completed" },
      created_at: demoTimestamp(),
      replayed: false,
    };
  }
  async deleteSchedule(scheduleId: string): Promise<void> {
    workspace().schedules = workspace().schedules.filter((item) => item.schedule_id !== scheduleId);
  }
  async providerDiagnostics(smoke: boolean): Promise<ProviderDiagnostic> {
    return {
      ...snapshot.provider as ProviderDiagnostic,
      status: smoke ? "smoke_passed" : "connected",
      connection_checked: true,
      connection_ok: true,
      model_available: true,
      smoke_checked: smoke,
      smoke_ok: smoke ? true : null,
      latency_ms: 418,
      total_tokens: smoke ? 10 : null,
    };
  }
  async musicCover(): Promise<Blob | null> { return null; }
  async events(): Promise<[]> { return []; }
  async streamEvents(): Promise<void> {}
}

const demoParams = new URLSearchParams(window.location.search);
const demoLocale = demoParams.get("locale") === "zh-CN" ? "zh-CN" : "en";
if (snapshot.workspaceV2?.personal?.settings) {
  snapshot.workspaceV2.personal.settings.locale = demoLocale;
  snapshot.workspaceV2.personal.settings.startup_page =
    demoParams.get("startup") === "start" ? "start" : "dashboard";
  const demoTheme = demoParams.get("theme");
  if (demoTheme === "dark" || demoTheme === "light" || demoTheme === "system") {
    snapshot.workspaceV2.personal.settings.theme = demoTheme;
  }
}
if (demoLocale === "zh-CN") {
  const deck = snapshot.workspaceV2?.deliverables.find((item) => item.kind === "deck");
  const artifact = deck?.artifact;
  if (artifact && typeof artifact === "object") {
    artifact.title = "可审查的本地 Agent";
    const slide = Array.isArray(artifact.slides) ? artifact.slides[0] : null;
    if (slide && typeof slide === "object" && !Array.isArray(slide)) {
      (slide as Record<string, unknown>).action_title = "为什么这很重要";
    }
    const claims = artifact.claims;
    if (claims && typeof claims === "object" && !Array.isArray(claims)) {
      const named = claims as Record<string, { text?: string }>;
      if (named["claim:local"]) named["claim:local"].text = "知识留在本机";
      if (named["claim:approval"]) named["claim:approval"].text = "每次调用都要确认";
      if (named["claim:sandbox"]) named["claim:sandbox"].text = "系统沙箱隔离";
    }
  }
}

const root = document.querySelector<HTMLElement>("#app");
if (root) {
  mountDashboard(root, { api: new DemoApi(), snapshot, locale: demoLocale });
  const requestedView = demoParams.get("view");
  if (requestedView) {
    requestAnimationFrame(() => {
      const escaped = CSS.escape(requestedView);
      const button = root.querySelector<HTMLButtonElement>(`.sidebar nav [data-view="${escaped}"]`)
        ?? root.querySelector<HTMLButtonElement>(`[data-subview="${escaped}"]`)
        ?? root.querySelector<HTMLButtonElement>(`[data-open-view="${escaped}"]`)
        ?? root.querySelector<HTMLButtonElement>(`[data-settings-tab="${escaped}"]`);
      button?.click();
      const requestedRun = demoParams.get("run");
      if (requestedRun) {
        requestAnimationFrame(() => {
          root.querySelector<HTMLButtonElement>(
            `[data-run-list] [data-run-id="${CSS.escape(requestedRun)}"]`,
          )?.click();
        });
      }
    });
  }
}
