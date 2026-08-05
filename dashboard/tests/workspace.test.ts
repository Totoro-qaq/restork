import { describe, expect, it, vi } from "vitest";

import { mountDashboard } from "../src/main";
import type {
  ConversationTurn,
  ConversationOperationCreateResultV2,
  ConversationOperationV2,
  DashboardApi,
  DashboardSnapshot,
  MusicConfigurationInput,
  ProviderDiagnostic,
  RunEvent,
  SessionForkResultV2,
  SessionMessageV2,
  SessionRecordV2,
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
  provider: {
    schema_version: 1,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    status: "ready",
    message: "Ready without a network check.",
    setup_command: "uv run restork provider configure",
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
    configureWeather: vi.fn(async () => ({
      configured: true,
      location_label: "Synthetic location",
      latitude: 0,
      longitude: 0,
    })),
    configureCalendar: vi.fn(async () => ({
      configured: false,
      status: "not_configured" as const,
      events: [],
      message: "",
    })),
    configureMusic: vi.fn(async () => ({
      configured: false,
      status: "not_configured" as const,
      recommendation: null,
      source: null,
      discoveries: [],
      message: "",
    })),
    refreshMusic: vi.fn(async () => ({
      configured: false,
      status: "not_configured" as const,
      recommendation: null,
      source: null,
      discoveries: [],
      message: "",
    })),
    providerDiagnostics: vi.fn(async () => {
      throw new Error("not used");
    }),
    musicCover: vi.fn(async () => null),
    events: vi.fn(async () => []),
    streamEvents: vi.fn(async () => undefined),
  };
}

function dailyWithMail(
  configured: boolean,
  unreadCount: number | null,
): NonNullable<DashboardSnapshot["daily"]> {
  return {
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
      message: "",
    },
    calendar: { configured: false, status: "not_configured", events: [], message: "" },
    native_calendar: {
      platform: "macos",
      adapter: "eventkit",
      available: true,
      status: "available",
      detail_scopes: ["busy_only", "titles"],
      message: "",
    },
    mail: {
      configured,
      status: configured ? "fresh" : "not_configured",
      provider: configured ? "macos-mail" : "",
      unread_count: unreadCount,
      observed_at: configured ? "2026-08-05T12:00:00Z" : null,
      message: "",
    },
    native_mail: {
      platform: "macos",
      adapter: "mail-app-apple-events",
      available: true,
      status: "available",
      detail_scopes: ["unread_count"],
      refresh_interval_seconds: 15,
      message: "",
    },
    music: {
      configured: false,
      status: "not_configured",
      recommendation: null,
      source: null,
      discoveries: [],
      message: "",
    },
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

  it("exposes Keychain setup without an API-key field in the browser", () => {
    const root = document.createElement("main");

    mountDashboard(root, { api: fakeApi(), snapshot });

    expect(root.textContent).toContain("restorkd provider configure deepseek");
    expect(root.textContent).toContain("The browser never receives it");
    expect(root.querySelector('input[type="password"]')).toBeNull();
    expect(root.querySelector('input[name*="key" i]')).toBeNull();
  });

  it("shows a bounded provider wait state and renders only safe smoke metadata", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    let finish: ((value: ProviderDiagnostic) => void) | undefined;
    const diagnostic = vi.spyOn(api, "providerDiagnostics").mockImplementation(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    mountDashboard(root, { api, snapshot });

    root.querySelector<HTMLButtonElement>('[data-provider-diagnostic="smoke"]')?.click();

    const waiting = root.querySelector<HTMLElement>(".provider-wait");
    expect(waiting?.getAttribute("aria-busy")).toBe("true");
    expect(waiting?.textContent).toContain("No Vault, memory, task, location");
    expect(diagnostic).toHaveBeenCalledWith(true, "primary", "deepseek");
    finish?.({
      ...(snapshot.provider as ProviderDiagnostic),
      status: "smoke_passed",
      message: "Synthetic smoke passed.",
      connection_checked: true,
      connection_ok: true,
      model_available: true,
      smoke_checked: true,
      smoke_ok: true,
      latency_ms: 420,
      request_id: "request-safe-1",
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
    });
    await vi.waitFor(() => {
      expect(root.querySelector('[data-provider-status="smoke_passed"]')).not.toBeNull();
    });
    expect(root.querySelector("[data-provider-summary]")?.textContent).toBe("smoke passed");
    expect(root.textContent).toContain("10 test tokens");
    expect(root.textContent).not.toContain("RESTORK_OK");
  });

  it("keeps the V4 Flash web-search diagnostic separate from V4 Pro", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const diagnostic = vi.spyOn(api, "providerDiagnostics").mockResolvedValue({
      ...(snapshot.provider as ProviderDiagnostic),
      model: "deepseek-v4-flash",
      status: "smoke_passed",
      message: "Synthetic web-search capability passed.",
      connection_checked: true,
      connection_ok: true,
      model_available: true,
      smoke_checked: true,
      smoke_ok: true,
    });
    mountDashboard(root, { api, snapshot });

    root.querySelector<HTMLButtonElement>('[data-provider-diagnostic="web_search"]')?.click();

    await vi.waitFor(() => {
      expect(diagnostic).toHaveBeenCalledWith(true, "web_search", "deepseek");
      expect(root.textContent).toContain("deepseek-v4-flash");
    });
  });

  it("renders a localized safe provider failure without transport details", async () => {
    const root = document.createElement("main");
    mountDashboard(root, { api: fakeApi(), snapshot, locale: "zh-CN" });

    root.querySelector<HTMLButtonElement>('[data-provider-diagnostic="connect"]')?.click();

    await vi.waitFor(() => {
      expect(root.querySelector('[data-provider-status="provider_unavailable"]')).not.toBeNull();
    });
    expect(root.textContent).toContain("检查失败");
    expect(root.textContent).not.toContain("not used");
  });

  it("switches between Core-owned views", () => {
    const root = document.createElement("main");
    mountDashboard(root, { api: fakeApi(), snapshot });

    root.querySelector<HTMLButtonElement>('[data-mode="research"]')?.click();
    expect(root.querySelector<HTMLElement>("#action-panel")?.hidden).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-view="tasks"]')?.click();

    const tasks = root.querySelector<HTMLElement>('[data-view-panel="tasks"]');
    const overview = root.querySelector<HTMLElement>('[data-view-panel="overview"]');
    expect(tasks?.hidden).toBe(false);
    expect(overview?.hidden).toBe(true);
    expect(overview?.contains(root.querySelector(".metrics"))).toBe(true);
    expect(overview?.contains(root.querySelector(".provider-console"))).toBe(true);
    expect(overview?.contains(root.querySelector(".daily-context"))).toBe(true);
    expect(root.querySelector('[data-view="tasks"]')?.getAttribute("aria-current")).toBe("page");
    expect(root.querySelector('[data-view="overview"]')?.hasAttribute("aria-current")).toBe(false);
    expect(root.querySelector<HTMLElement>("#action-panel")?.hidden).toBe(true);
  });

  it("keeps the selected page when the user refreshes Core data", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    mountDashboard(root, { api, snapshot });

    root.querySelector<HTMLButtonElement>('[data-view="memory"]')?.click();
    root.querySelector<HTMLButtonElement>("#refresh")?.click();

    await vi.waitFor(() => {
      expect(api.loadDashboard).toHaveBeenCalledOnce();
      expect(root.querySelector<HTMLElement>('[data-view-panel="memory"]')?.hidden).toBe(false);
      expect(root.querySelector('[data-view="memory"]')?.getAttribute("aria-current")).toBe("page");
    });
  });

  it("lets a new run be toggled, closed, and dismissed with Escape", () => {
    const root = document.createElement("main");
    document.body.append(root);
    mountDashboard(root, { api: fakeApi(), snapshot });
    const research = root.querySelector<HTMLButtonElement>('[data-mode="research"]');
    const study = root.querySelector<HTMLButtonElement>('[data-mode="study"]');
    const panel = root.querySelector<HTMLElement>("#action-panel");

    research?.click();
    expect(panel?.hidden).toBe(false);
    expect(research?.getAttribute("aria-expanded")).toBe("true");
    research?.click();
    expect(panel?.hidden).toBe(true);
    expect(research?.getAttribute("aria-expanded")).toBe("false");

    study?.click();
    panel?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel?.hidden).toBe(true);
    expect(document.activeElement).toBe(study);

    study?.click();
    root.querySelector<HTMLButtonElement>("[data-run-panel-close]")?.click();
    expect(panel?.hidden).toBe(true);
    root.remove();
  });

  it("keeps mode drafts while switching between Study and Work", () => {
    const root = document.createElement("main");
    mountDashboard(root, { api: fakeApi(), snapshot });

    root.querySelector<HTMLButtonElement>('[data-mode="study"]')?.click();
    const target = root.querySelector<HTMLInputElement>("#study-target-note");
    if (target) target.value = "Study/Bayes.md";
    root.querySelector<HTMLButtonElement>('[data-mode="work"]')?.click();
    const workRoot = root.querySelector<HTMLInputElement>("#work-root");
    if (workRoot) workRoot.value = "/private/example";
    root.querySelector<HTMLButtonElement>('[data-mode="study"]')?.click();

    expect(target?.value).toBe("Study/Bayes.md");
    expect(target?.hidden).toBe(false);
    expect(workRoot?.value).toBe("/private/example");
  });

  it("updates only the aggregate unread count through the private mail stream", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const streamMail = vi.fn<NonNullable<DashboardApi["streamMail"]>>(async (onSnapshot) => {
      onSnapshot({
        configured: true,
        status: "fresh",
        provider: "macos-mail",
        unread_count: 7,
        observed_at: "2026-08-05T12:00:15Z",
        message: "PRIVATE SUBJECT MUST NEVER RENDER",
      });
    });
    api.streamMail = streamMail;

    mountDashboard(root, {
      api,
      snapshot: { ...snapshot, daily: dailyWithMail(true, 2) },
      locale: "zh-CN",
    });

    await vi.waitFor(() => expect(root.querySelector("[data-mail-count]")?.textContent).toBe("7 封未读"));
    expect(streamMail).toHaveBeenCalledOnce();
    expect(root.textContent).toContain("仅未读数量");
    expect(root.textContent).not.toContain("PRIVATE SUBJECT MUST NEVER RENDER");
  });

  it("does not request Mail access until the user presses Connect", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const connected = dailyWithMail(true, 3).mail!;
    const connect = vi.fn(async () => connected);
    api.connectNativeMail = connect;
    vi.spyOn(api, "loadDashboard").mockResolvedValue({
      ...snapshot,
      daily: dailyWithMail(true, 3),
    });

    mountDashboard(root, { api, snapshot: { ...snapshot, daily: dailyWithMail(false, null) } });
    expect(connect).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>("[data-native-mail-connect]")?.click();

    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalledOnce();
      expect(root.querySelector("[data-mail-count]")?.textContent).toBe("3 unread");
    });
  });

  it("renders an accessible local clock and reduced-dependency daily context", () => {
    const root = document.createElement("main");
    const eventStart = new Date();
    eventStart.setHours(10, 30, 0, 0);
    const eventEnd = new Date(eventStart);
    eventEnd.setHours(11, 0, 0, 0);
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
          calendar: {
            configured: true,
            status: "ready",
            events: [{
              event_id: "event-today",
              title: "Private focus block",
              starts_at: eventStart.toISOString(),
              ends_at: eventEnd.toISOString(),
              all_day: false,
              redacted: false,
            }],
            message: "",
          },
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
            source: {
              provider: "qqmusic",
              label: "Private fixture",
              item_count: 12,
              synced_at: "2026-08-03T08:00:00Z",
              public_url: "https://y.qq.com/n/ryqq_v2/playlist/1",
              refresh_supported: true,
              experimental: true,
            },
            discoveries: [{
              item_id: "qqmusic:new-track",
              title: "New <Cantonese> Track",
              artist: "Example Artist",
              album: "Current Album",
              language: "粤语",
              genre: "Pop",
              label: "Example Label",
              published_on: "2026-07-31",
              chart_name: "Hong Kong chart",
              chart_rank: 2,
              chart_updated_on: "2026-08-03",
              affinity_artist: "Example Artist",
              affinity_count: 3,
              recommendation_reason: "Fixture reason.",
              song_analysis: "Fixture analysis.",
              popularity_reason: "Fixture evidence.",
              source_url: "https://y.qq.com/n/ryqq/songDetail/new-track",
            }],
          },
        },
      },
    });

    expect(root.querySelector("#clock-title")?.textContent).toContain("Roman numeral");
    expect(root.querySelector("#clock-text")?.textContent).not.toContain("读取");
    expect(root.querySelectorAll(".calendar-weekdays > span")).toHaveLength(7);
    expect(root.querySelectorAll(".calendar-month-grid > .calendar-day")).toHaveLength(42);
    expect(root.querySelector('.calendar-day[aria-current="date"]')).not.toBeNull();
    expect(root.querySelector(".calendar-day.has-events")).not.toBeNull();
    expect(root.querySelector(".calendar-agenda")?.textContent).toContain("Private focus block");
    expect(root.textContent).toContain("Synthetic Track");
    expect(root.textContent).toContain("Connected discoveries (1)");
    expect(root.textContent).toContain("New <Cantonese> Track");
    expect(root.querySelector<HTMLDetailsElement>(".music-discoveries")?.open).toBe(false);
    expect(root.querySelector("script")).toBeNull();
    const toggle = root.querySelector<HTMLButtonElement>("[data-music-toggle]");
    toggle?.click();
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector("[data-music-disc]")?.classList).toContain("is-playing");
  });

  it("does not leak legacy English song fallback copy into the Chinese interface", () => {
    const root = document.createElement("main");
    mountDashboard(root, {
      api: fakeApi(),
      locale: "zh-CN",
      snapshot: {
        ...snapshot,
        daily: {
          weather: { configured: false, status: "not_configured", provider: "", location_label: "", condition: "", temperature_c: null, apparent_temperature_c: null, relative_humidity_percent: null, is_day: null, observed_at: null, expires_at: null, attribution: "", message: "" },
          calendar: { configured: false, status: "not_configured", events: [], message: "" },
          music: {
            configured: true,
            status: "ready",
            message: "",
            recommendation: {
              item_id: "legacy-track",
              title: "爱是永恒",
              artist: "张学友",
              album: "不老的传说",
              tags: [],
              analysis: "",
              song_analysis: "No reviewed song-detail evidence is cached yet. Refresh the connected source.",
              popularity_reason: "This track has no current chart evidence.",
              cover_available: false,
            },
            source: {
              provider: "qqmusic",
              label: "Cantonese Favorites",
              item_count: 443,
              synced_at: "2026-08-04T08:00:00Z",
              public_url: "https://y.qq.com/n/ryqq_v2/playlist/1",
              refresh_supported: true,
              experimental: true,
            },
            discoveries: [],
          },
        },
      },
    });

    const insights = root.querySelector(".music-insights")?.textContent ?? "";
    expect(insights).toContain("尚未缓存经过核验的歌曲资料");
    expect(insights).toContain("Restork 不会编造它走红的原因");
    expect(insights).not.toContain("No reviewed song-detail evidence");
    expect(insights).not.toContain("no current chart evidence");
  });

  it("localizes backend-authored daily empty states in the Chinese interface", () => {
    const root = document.createElement("main");
    mountDashboard(root, {
      api: fakeApi(),
      locale: "zh-CN",
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
            message: "Weather is off. Enter a place or explicitly approve one-shot location.",
          },
          calendar: { configured: false, status: "not_configured", events: [], message: "" },
          music: {
            configured: false,
            status: "not_configured",
            recommendation: null,
            message: "Connect a supported music source or import a private JSON/CSV playlist.",
          },
        },
      },
    });

    expect(root.querySelector(".weather-card > header span")?.textContent).toBe("未启用");
    expect(root.querySelector(".music-card > header span")?.textContent).toBe("未启用");
    expect(root.querySelector(".weather-card")?.textContent).toContain("天气尚未启用");
    expect(root.querySelector(".music-card")?.textContent).toContain("连接受支持的音乐来源");
    expect(root.textContent).not.toContain("Weather is off");
    expect(root.textContent).not.toContain("Connect a supported music source");
  });

  it("connects a QQ Music share link only after explicit submit", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    let finish: ((value: NonNullable<DashboardSnapshot["daily"]>["music"]) => void) | undefined;
    const configure = vi.fn(
      (input: MusicConfigurationInput) => {
        void input;
        return new Promise<NonNullable<DashboardSnapshot["daily"]>["music"]>(
          (resolve) => { finish = resolve; },
        );
      },
    );
    api.configureMusic = configure;
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
            message: "",
          },
          calendar: { configured: false, status: "not_configured", events: [], message: "" },
          music: { configured: false, status: "not_configured", recommendation: null, message: "" },
        },
      },
    });

    expect(configure).not.toHaveBeenCalled();
    const form = root.querySelector<HTMLFormElement>("#music-form");
    const input = root.querySelector<HTMLInputElement>("#music-share-url");
    if (form && input) {
      input.value = "https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=123";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }

    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      source: "qqmusic",
      share_url: "https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=123",
    })));
    expect(form?.getAttribute("aria-busy")).toBe("true");
    expect(root.querySelector("[data-music-sync-status]")?.textContent).toContain("current Cantonese chart");
    finish?.({
      configured: true,
      status: "ready",
      recommendation: null,
      source: null,
      discoveries: [],
      message: "",
    });
    await vi.waitFor(() => expect(api.loadDashboard).toHaveBeenCalled());
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it("selects a credential-free NetEase adapter without accepting account data", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const configure = vi.fn(async () => ({
      configured: true,
      status: "ready" as const,
      recommendation: null,
      source: null,
      discoveries: [],
      message: "",
    }));
    api.configureMusic = configure;
    mountDashboard(root, {
      api,
      snapshot: {
        ...snapshot,
        musicSources: [
          {
            provider: "netease",
            label: "NetEase Cloud Music",
            stability: "experimental",
            credential_mode: "none",
            setup_status: "ready",
            setup_command: "",
            capabilities: {
              read_only: true,
              refresh_supported: true,
              supports_public_playlists: true,
              supports_library: false,
              supports_charts: false,
              requires_user_consent: false,
            },
          },
        ],
        daily: {
          weather: { configured: false, status: "not_configured", provider: "", location_label: "", condition: "", temperature_c: null, apparent_temperature_c: null, relative_humidity_percent: null, is_day: null, observed_at: null, expires_at: null, attribution: "", message: "" },
          calendar: { configured: false, status: "not_configured", events: [], message: "" },
          music: { configured: false, status: "not_configured", recommendation: null, message: "" },
        },
      },
    });
    const form = root.querySelector<HTMLFormElement>("#music-form");
    const source = root.querySelector<HTMLSelectElement>("#music-source");
    const input = root.querySelector<HTMLInputElement>("#music-share-url");
    if (form && source && input) {
      source.value = "netease";
      source.dispatchEvent(new Event("change", { bubbles: true }));
      input.value = "https://music.163.com/playlist?id=42&userid=discarded";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      source: "netease",
      share_url: "https://music.163.com/playlist?id=42&userid=discarded",
    })));
    expect(root.querySelector("[data-music-source-help]")?.textContent).toContain("credential-free");
  });

  it("keeps an unconfigured Apple Music token out of the Dashboard", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const configure = vi.fn();
    api.configureMusic = configure;
    mountDashboard(root, {
      api,
      snapshot: {
        ...snapshot,
        daily: {
          weather: { configured: false, status: "not_configured", provider: "", location_label: "", condition: "", temperature_c: null, apparent_temperature_c: null, relative_humidity_percent: null, is_day: null, observed_at: null, expires_at: null, attribution: "", message: "" },
          calendar: { configured: false, status: "not_configured", events: [], message: "" },
          music: { configured: false, status: "not_configured", recommendation: null, message: "" },
        },
      },
    });
    const form = root.querySelector<HTMLFormElement>("#music-form");
    const source = root.querySelector<HTMLSelectElement>("#music-source");
    const input = root.querySelector<HTMLInputElement>("#music-share-url");
    if (form && source && input) {
      source.value = "apple-music";
      source.dispatchEvent(new Event("change", { bubbles: true }));
      input.value = "https://music.apple.com/hk/playlist/synthetic/pl.u-1234";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
    await vi.waitFor(() => expect(root.querySelector("[data-music-sync-status]")?.textContent).toContain("restorkd music apple configure"));
    expect(configure).not.toHaveBeenCalled();
    expect(root.querySelector('input[name="token"]')).toBeNull();
  });

  it("configures weather from a city without requesting browser location", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const configure = vi.spyOn(api, "configureWeather").mockResolvedValue({
      configured: true,
      location_label: "Guangzhou, Guangdong, China",
      latitude: 23.13,
      longitude: 113.26,
    });
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
    const query = root.querySelector<HTMLInputElement>("#weather-query");
    if (query && form) {
      query.value = "Guangzhou";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }

    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith({
      enabled: true,
      mode: "query",
      query: "Guangzhou",
      language: "en",
    }));
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it("requests browser location only after the user presses the location button", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const configure = vi.spyOn(api, "configureWeather").mockResolvedValue({
      configured: true,
      location_label: "Current location",
      latitude: 31.2304,
      longitude: 121.4737,
    });
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: {
        latitude: 31.2304,
        longitude: 121.4737,
        accuracy: 20,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
        toJSON: () => ({}),
      },
      timestamp: Date.now(),
      toJSON: () => ({}),
    }));
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

    expect(getCurrentPosition).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>("[data-weather-locate]")?.click();

    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith({
      enabled: true,
      mode: "coordinates",
      label: "Current location",
      latitude: 31.2304,
      longitude: 121.4737,
    }));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
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

  it("keeps run conversation in a bounded scroll region with a visible wait state", async () => {
    const root = document.createElement("main");
    document.body.append(root);
    const api = fakeApi();
    const runSnapshot: DashboardSnapshot = {
      ...snapshot,
      runs: [{
        summary: {
          run_id: "run-chat",
          task_id: "task-chat",
          mode: "research",
          state: "completed",
          state_version: 2,
          stop_reason: "completed",
          created_at: "2026-08-02T00:00:00Z",
          updated_at: "2026-08-02T00:01:00Z",
        },
        task: {
          task_id: "task-chat",
          mode: "research",
          goal: "Explain a synthetic result",
          workspace_scope: "synthetic",
          completion_criteria: ["answer clearly"],
          budgets: {
            max_steps: 8,
            max_wall_time_seconds: 120,
            max_tokens: 2_000,
          },
        },
        budget: null,
      }],
    };
    api.eventPage = vi.fn(async () => ({
      events: [],
      page: { limit: 50, has_more: false, next_cursor: null },
    }));
    api.conversationPage = vi.fn(async () => ({
      turns: [],
      page: { limit: 24, has_more: false, next_cursor: null },
    }));
    let finish: ((value: ConversationTurn) => void) | undefined;
    api.sendConversation = vi.fn(
      () => new Promise<ConversationTurn>((resolve) => { finish = resolve; }),
    );
    mountDashboard(root, { api, snapshot: runSnapshot });

    root.querySelector<HTMLButtonElement>('[data-view="runs"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-run-id="run-chat"]')?.click();
    await vi.waitFor(() => expect(root.querySelector(".conversation-composer")).not.toBeNull());

    const input = root.querySelector<HTMLTextAreaElement>("#conversation-input");
    if (input) input.value = "What does this result mean?";
    root.querySelector<HTMLFormElement>("[data-conversation-form]")?.requestSubmit();

    await vi.waitFor(() => expect(root.querySelector(".conversation-wait")).not.toBeNull());
    expect(root.querySelector(".conversation-history")?.getAttribute("role")).toBe("log");
    expect(root.querySelector<HTMLTextAreaElement>("#conversation-input")?.disabled).toBe(true);
    finish?.({
      turn_id: "turn-chat",
      run_id: "run-chat",
      sequence: 1,
      mode: "research",
      user: {
        message_id: "message-user",
        run_id: "run-chat",
        turn_sequence: 1,
        role: "user",
        content: "What does this result mean?",
        created_at: "2026-08-02T00:02:00Z",
        data_class: "public",
      },
      assistant: {
        message_id: "message-assistant",
        run_id: "run-chat",
        turn_sequence: 1,
        role: "assistant",
        content: "It is a bounded synthetic explanation.",
        created_at: "2026-08-02T00:02:01Z",
        data_class: "public",
      },
      prompt_id: "conversation.research.system",
      prompt_version: "1.0.0",
      prompt_hash: "a".repeat(64),
      dropped_messages: 0,
      estimated_context_tokens: 40,
      total_tokens: 12,
    });

    await vi.waitFor(() => expect(root.textContent).toContain("bounded synthetic explanation"));
    expect(api.sendConversation).toHaveBeenCalledWith(
      "run-chat",
      "What does this result mean?",
    );
    expect(root.querySelector(".conversation-wait")).toBeNull();
    root.remove();
  });
});

describe("Rust conversation workspace", () => {
  const workspaceSnapshot = (): DashboardSnapshot => ({
    ...snapshot,
    workspaceV2: {
      dailyContext: {
        observed_at: "2026-08-02T12:00:00Z",
        timezone: "Asia/Shanghai",
        local_date: "2026-08-02",
        local_time: "20:00:00",
        time_band: "evening",
      },
      personal: null,
      sessions: [],
      extensions: [],
      deliverables: [],
      schedules: [],
      providers: [],
      profiles: [{
        profile: {
          profile_id: "research-cloud",
          version: 1,
          name: "Research Cloud",
          provider_profile_id: "deepseek",
          prompt_manifest_hash: "a".repeat(64),
          enabled_skill_ids: [],
          allowed_tools: [],
          memory_namespace: "research",
          maximum_data_class: "personal",
          include_display_name_in_prompt: false,
        },
        revision: 1,
        builtin: false,
        updated_at: "2026-08-02T12:00:00Z",
      }],
      prompts: [],
    },
  });

  it("makes local or cloud selection explicit when a conversation is created", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    api.createSession = vi.fn(async (
      title: string,
      profileId: string,
    ): Promise<SessionRecordV2> => ({
      session_id: "session-cloud",
      title,
      profile_id: profileId,
      status: "active",
      version: 1,
      locale: "en",
      created_at: "2026-08-02T12:00:00Z",
      updated_at: "2026-08-02T12:00:00Z",
      archived_at: null,
    }));
    api.sessionMessages = vi.fn(async () => []);
    mountDashboard(root, { api, snapshot: workspaceSnapshot() });

    root.querySelector<HTMLButtonElement>('[data-view="conversation"]')?.click();
    const form = root.querySelector<HTMLFormElement>("#session-create-form");
    const title = form?.elements.namedItem("title");
    const profile = form?.elements.namedItem("profile_id");
    if (title instanceof HTMLInputElement && profile instanceof HTMLSelectElement && form) {
      title.value = "Recent model papers";
      profile.value = "deepseek";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }

    await vi.waitFor(() => expect(api.createSession).toHaveBeenCalledWith(
      "Recent model papers",
      "deepseek",
    ));
    expect(root.textContent).toContain("cloud use is never selected silently");
    expect(root.querySelector('input[type="password"]')).toBeNull();
  });

  it("switches models by creating a bounded conversation branch", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const state = workspaceSnapshot();
    if (!state.workspaceV2) throw new Error("workspace fixture");
    state.workspaceV2.sessions.push({
      session_id: "session-source",
      title: "Model comparison",
      profile_id: "safe-mode",
      status: "active",
      version: 1,
      locale: "en",
      created_at: "2026-08-05T11:00:00Z",
      updated_at: "2026-08-05T11:05:00Z",
      archived_at: null,
    });
    api.sessionMessages = vi.fn(async () => []);
    api.forkSession = vi.fn(async (
      _sessionId: string,
      title: string,
      profileId: string,
    ): Promise<SessionForkResultV2> => ({
      session: {
        session_id: "session-branch",
        title,
        profile_id: profileId,
        status: "active",
        version: 1,
        locale: "en",
        created_at: "2026-08-05T11:06:00Z",
        updated_at: "2026-08-05T11:06:00Z",
        archived_at: null,
      },
      source_session_id: "session-source",
      copied_messages: 2,
      omitted_messages: 0,
      copied_bytes: 64,
      profile_id: profileId,
    }));
    mountDashboard(root, { api, snapshot: state });

    const form = root.querySelector<HTMLFormElement>("#session-fork-form");
    const profile = form?.elements.namedItem("profile_id");
    if (!(profile instanceof HTMLSelectElement) || !form) throw new Error("fork form");
    profile.value = "deepseek";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.forkSession).toHaveBeenCalledWith(
      "session-source",
      "Model comparison · deepseek",
      "deepseek",
      "2026-08-05T11:05:00Z",
      24,
    ));
    await vi.waitFor(() => expect(root.querySelector("#conversation-profile-label")?.textContent)
      .toContain("DeepSeek"));
    expect(state.workspaceV2.sessions.map((session) => session.session_id)).toEqual([
      "session-branch",
      "session-source",
    ]);
    expect(root.textContent).toContain("original conversation stays unchanged");
    expect(root.querySelector('input[type="password"]')).toBeNull();
  });

  it("shows an honest model wait state and keeps the conversation scrollable", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const state = workspaceSnapshot();
    state.workspaceV2?.sessions.push({
      session_id: "session-cloud",
      title: "Research with DeepSeek",
      profile_id: "deepseek",
      status: "active",
      version: 1,
      locale: "en",
      created_at: "2026-08-02T12:00:00Z",
      updated_at: "2026-08-02T12:00:00Z",
      archived_at: null,
    });
    let finish: ((value: SessionMessageV2) => void) | undefined;
    api.sessionMessages = vi.fn(async () => []);
    api.sendSessionMessage = vi.fn(() => new Promise<SessionMessageV2>((resolve) => {
      finish = resolve;
    }));
    mountDashboard(root, { api, snapshot: state });

    const composer = root.querySelector<HTMLFormElement>("#session-message-form");
    const textarea = composer?.querySelector<HTMLTextAreaElement>("textarea");
    if (composer && textarea) {
      textarea.value = "Summarize the evidence.";
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }

    expect(root.querySelector("#conversation-wait")?.getAttribute("aria-busy")).toBe("true");
    expect(root.querySelector("#conversation-wait")?.textContent).toContain(
      "Waiting for the configured model",
    );
    expect(root.querySelector("#conversation-wait")?.textContent).toContain("tools remain off");
    expect(root.querySelector("#conversation-messages")?.getAttribute("tabindex")).toBe("0");
    const dataClass = root.querySelector<HTMLSelectElement>(
      '#session-message-form [name="data_class"]',
    );
    expect(dataClass?.value).toBe("public");
    expect(dataClass?.querySelector<HTMLOptionElement>('option[value="personal"]')?.disabled)
      .toBe(true);
    expect(dataClass?.querySelector<HTMLOptionElement>('option[value="confidential"]')?.disabled)
      .toBe(true);
    finish?.({
      message_id: "assistant-1",
      session_id: "session-cloud",
      sequence: 2,
      role: "assistant",
      content: "Synthetic response",
      context: { tool_access: false },
      data_class: "public",
      created_at: "2026-08-02T12:00:01Z",
    });
    await vi.waitFor(() => expect(root.querySelector("#conversation-wait")?.textContent).toBe(""));
  });

  it("streams durable conversation phases and lets the user cancel the model request", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const state = workspaceSnapshot();
    state.workspaceV2?.sessions.push({
      session_id: "session-operation",
      title: "Cancellable model turn",
      profile_id: "deepseek",
      status: "active",
      version: 1,
      locale: "en",
      created_at: "2026-08-03T00:00:00Z",
      updated_at: "2026-08-03T00:00:00Z",
      archived_at: null,
    });
    api.sessionMessages = vi.fn(async () => []);
    api.createConversationTurn = vi.fn(async (): Promise<ConversationOperationCreateResultV2> => ({
      operation: {
        operation_id: "operation-ui",
        session_id: "session-operation",
        user_message_id: "message-user",
        assistant_message_id: null,
        state: "queued",
        phase: "queued",
        context_preview_hash: null,
        provider_binding: { reasoning: { effort: "high" } },
        cancel_requested: false,
        error_code: null,
        created_at: "2026-08-03T00:00:01Z",
        updated_at: "2026-08-03T00:00:01Z",
        completed_at: null,
      },
      user_message: {
        message_id: "message-user",
        session_id: "session-operation",
        sequence: 1,
        role: "user",
        content: "Stop this safely",
        context: {},
        data_class: "public",
        created_at: "2026-08-03T00:00:01Z",
      },
      replayed: false,
    }));
    let finishStream: (() => void) | undefined;
    let deliverEvent: ((event: RunEvent) => void) | undefined;
    api.streamConversationOperation = vi.fn(async (_operationId, _after, onEvent) => {
      deliverEvent = onEvent;
      onEvent({ id: 2, type: "conversation.model_started", data: { phase: "model" } });
      await new Promise<void>((resolve) => { finishStream = resolve; });
    });
    api.cancelConversationOperation = vi.fn(async (): Promise<ConversationOperationV2> => {
      deliverEvent?.({
        id: 3,
        type: "conversation.cancel_requested",
        data: { phase: "cancelling" },
      });
      deliverEvent?.({
        id: 4,
        type: "conversation.cancelled",
        data: { phase: "cancelled" },
      });
      finishStream?.();
      return {
        operation_id: "operation-ui",
        session_id: "session-operation",
        user_message_id: "message-user",
        assistant_message_id: null,
        state: "cancelled",
        phase: "cancelled",
        context_preview_hash: null,
        provider_binding: {},
        cancel_requested: true,
        error_code: "cancelled",
        created_at: "2026-08-03T00:00:01Z",
        updated_at: "2026-08-03T00:00:02Z",
        completed_at: "2026-08-03T00:00:02Z",
      };
    });
    mountDashboard(root, { api, snapshot: state });

    const composer = root.querySelector<HTMLFormElement>("#session-message-form");
    const textarea = composer?.querySelector<HTMLTextAreaElement>("textarea");
    if (!composer || !textarea) throw new Error("conversation composer");
    textarea.value = "Stop this safely";
    composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(root.querySelector("#conversation-wait")?.textContent)
      .toContain("Thinking with the configured model"));
    root.querySelector<HTMLButtonElement>("[data-conversation-cancel]")?.click();
    await vi.waitFor(() => expect(api.cancelConversationOperation)
      .toHaveBeenCalledWith("operation-ui"));
    await vi.waitFor(() => expect(root.querySelector("#conversation-wait")?.textContent).toBe(""));
    expect(api.streamConversationOperation).toHaveBeenCalledWith(
      "operation-ui",
      0,
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });

  it("renders bilingual extension, deliverable, and automation workspaces without wide-page overflow", () => {
    const root = document.createElement("main");
    const state = workspaceSnapshot();
    state.workspaceV2?.extensions.push({
      package_id: "skill.synthetic",
      package_kind: "skill",
      state: "quarantined",
      manifest_hash: "b".repeat(64),
      manifest: { schema_version: 1, version: "1.0.0", tools: [] },
      updated_at: "2026-08-02T12:00:00Z",
    });
    state.workspaceV2?.deliverables.push({
      deliverable_id: "report.synthetic",
      kind: "daily_report",
      state: "draft",
      revision: 1,
      artifact: { markdown: "# Synthetic report\n\n- self-asserted" },
      updated_at: "2026-08-02T12:00:00Z",
    });
    state.workspaceV2?.schedules.push({
      schedule_id: "daily.synthetic",
      state: "active",
      revision: 1,
      schedule: {
        timezone: "Asia/Shanghai",
        recurrence: { kind: "daily", hour: 9, minute: 0 },
        job: { kind: "deterministic", job: "health.check" },
      },
      next_run_at: "2026-08-03T01:00:00Z",
      updated_at: "2026-08-02T12:00:00Z",
    });
    mountDashboard(root, { api: fakeApi(), snapshot: state, locale: "zh-CN" });

    root.querySelector<HTMLButtonElement>('[data-view="extensions"]')?.click();
    expect(root.querySelector<HTMLElement>('[data-view-panel="extensions"]')?.hidden).toBe(false);
    expect(root.querySelector("#extension-install-form")).not.toBeNull();
    expect(root.textContent).toContain("安装已固定版本的清单");
    root.querySelector<HTMLButtonElement>('[data-extension-filter="plugin"]')?.click();
    expect(root.querySelector<HTMLElement>('[data-extension-card-kind="skill"]')?.hidden).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-view="deliverables"]')?.click();
    expect(root.querySelector("#manual-report-form")).not.toBeNull();
    expect(root.querySelector("#deck-from-report-form")).not.toBeNull();
    expect(root.textContent).toContain("日报 / 周报草稿");

    root.querySelector<HTMLButtonElement>('[data-view="automation"]')?.click();
    expect(root.querySelector("#schedule-create-form")).not.toBeNull();
    expect(root.textContent).toContain("恢复与评估契约");
    expect(root.querySelector('input[type="password"]')).toBeNull();
  });

  it("shows immutable extension history and creates a reviewed rollback without executing a tool", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const state = workspaceSnapshot();
    const currentHash = "c".repeat(64);
    const previousHash = "b".repeat(64);
    state.workspaceV2?.extensions.push({
      package_id: "skill.synthetic",
      package_kind: "skill",
      state: "enabled",
      manifest_hash: currentHash,
      manifest: { schema_version: 1, version: "2.0.0" },
      updated_at: "2026-08-03T00:00:00Z",
    });
    api.extensionRevisions = vi.fn(async () => [{
      package_id: "skill.synthetic",
      package_kind: "skill",
      state: "disabled",
      manifest_hash: previousHash,
      manifest: { schema_version: 1, version: "1.0.0" },
      updated_at: "2026-08-02T00:00:00Z",
    }]);
    api.rollbackExtension = vi.fn(async () => ({
      package_id: "skill.synthetic",
      package_kind: "skill",
      state: "quarantined",
      manifest_hash: previousHash,
      manifest: { schema_version: 1, version: "1.0.0" },
      updated_at: "2026-08-03T00:01:00Z",
    }));
    api.executeSessionToolCall = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mountDashboard(root, { api, snapshot: state });

    root.querySelector<HTMLButtonElement>('[data-view="extensions"]')?.click();
    root.querySelector<HTMLButtonElement>("[data-extension-history]")?.click();
    await vi.waitFor(() => expect(api.extensionRevisions).toHaveBeenCalledWith("skill.synthetic"));
    const rollback = root.querySelector<HTMLButtonElement>(".extension-history button");
    expect(rollback?.textContent).toContain("REVIEW ROLLBACK");
    rollback?.click();
    await vi.waitFor(() => expect(api.rollbackExtension)
      .toHaveBeenCalledWith("skill.synthetic", currentHash, previousHash));
    expect(api.executeSessionToolCall).not.toHaveBeenCalled();
  });

  it("offers only provider-supported reasoning levels and saves the frozen policy", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const state = workspaceSnapshot();
    if (!state.workspaceV2) throw new Error("workspace fixture");
    state.workspaceV2.providerRegistry = {
      registry_version: 1,
      items: [
        {
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
        },
        {
          registry_version: 1,
          kind: "qwen",
          id: "qwen",
          display_name: "Qwen",
          protocol: "open_ai_chat_completions",
          default_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          endpoint_policy: "exact_official",
          auth_kind: "bearer",
          model_discovery: "open_ai_models",
          request_adapter: "qwen",
          capabilities: {
            streaming: true,
            tool_calls: true,
            json_output: true,
            reasoning: true,
            vision: false,
          },
          reasoning: {
            can_disable: true,
            supported_efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
            supports_token_budget: true,
          },
          docs_url: "https://help.aliyun.com/",
        },
      ],
    };
    api.loadDashboard = vi.fn(async () => state);
    api.saveProviderProfile = vi.fn(async (_expected, provider) => ({
      provider,
      revision: 1,
      updated_at: "2026-08-03T00:00:00Z",
    }));
    mountDashboard(root, { api, snapshot: state });

    root.querySelector<HTMLButtonElement>('[data-view="settings"]')?.click();
    const form = root.querySelector<HTMLFormElement>("#provider-profile-form");
    const kind = form?.elements.namedItem("kind") as HTMLSelectElement | null;
    const effort = form?.elements.namedItem("reasoning_effort") as HTMLSelectElement | null;
    const budget = form?.elements.namedItem("reasoning_max_tokens") as HTMLInputElement | null;
    expect(effort?.querySelector<HTMLOptionElement>('option[value="medium"]')?.disabled)
      .toBe(true);

    if (!form || !kind || !effort || !budget) throw new Error("provider form");
    kind.value = "qwen";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    expect(effort.querySelector<HTMLOptionElement>('option[value="medium"]')?.disabled)
      .toBe(false);
    effort.value = "medium";
    effort.dispatchEvent(new Event("change", { bubbles: true }));
    budget.value = "2048";
    (form.elements.namedItem("profile_id") as HTMLInputElement).value = "qwen-main";
    (form.elements.namedItem("display_name") as HTMLInputElement).value = "Qwen Main";
    (form.elements.namedItem("model") as HTMLInputElement).value = "qwen-max";
    (form.elements.namedItem("secret_ref") as HTMLInputElement).value =
      "keychain:restork/provider/qwen";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(api.saveProviderProfile).toHaveBeenCalled());
    expect(api.saveProviderProfile).toHaveBeenCalledWith(null, expect.objectContaining({
      kind: "qwen",
      reasoning: { effort: "medium", max_tokens: 2048 },
    }));
  });

  it("tests the exact saved provider and model instead of a hard-coded vendor", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const state = workspaceSnapshot();
    if (!state.workspaceV2) throw new Error("workspace fixture");
    state.workspaceV2.providers = [{
      provider: {
        profile_id: "qwen-main",
        version: 1,
        display_name: "Qwen Main",
        kind: "qwen",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-max",
        secret_ref: "keychain:restork/provider/qwen",
        fallback: "disabled",
        reasoning: { effort: "medium", max_tokens: 2048 },
      },
      revision: 1,
      updated_at: "2026-08-04T00:00:00Z",
    }];
    const diagnostic = vi.spyOn(api, "providerDiagnostics").mockResolvedValue({
      ...(snapshot.provider as ProviderDiagnostic),
      provider: "qwen-main",
      model: "qwen-max",
      status: "smoke_passed",
      connection_checked: true,
      connection_ok: true,
      model_available: true,
      smoke_checked: true,
      smoke_ok: true,
    });
    mountDashboard(root, { api, snapshot: state });

    root.querySelector<HTMLButtonElement>('[data-view="settings"]')?.click();
    root.querySelector<HTMLButtonElement>('[data-provider-profile-test="qwen-main"]')?.click();

    await vi.waitFor(() => {
      expect(diagnostic).toHaveBeenCalledWith(true, "primary", "qwen-main");
      expect(root.textContent).toContain("qwen-max");
    });
  });

  it("selects and tests a saved model from the overview while setup commands follow the provider", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const state = workspaceSnapshot();
    if (!state.workspaceV2) throw new Error("workspace fixture");
    state.workspaceV2.providers = [{
      provider: {
        profile_id: "qwen-main",
        version: 1,
        display_name: "Qwen Main",
        kind: "qwen",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-max",
        secret_ref: "keychain:restork/provider/qwen",
        fallback: "disabled",
        reasoning: { effort: "medium", max_tokens: 2048 },
      },
      revision: 1,
      updated_at: "2026-08-04T00:00:00Z",
    }];
    state.workspaceV2.providerRegistry = {
      registry_version: 1,
      items: [{
        registry_version: 1,
        kind: "qwen",
        id: "qwen",
        display_name: "Qwen",
        protocol: "open_ai_chat_completions",
        default_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        endpoint_policy: "exact_official",
        auth_kind: "bearer",
        model_discovery: "manual_only",
        request_adapter: "qwen",
        capabilities: { streaming: true, tool_calls: true, json_output: true, reasoning: true, vision: true },
        reasoning: { can_disable: true, supported_efforts: ["medium"], supports_token_budget: true },
        docs_url: "https://help.aliyun.com/",
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
        capabilities: { streaming: true, tool_calls: true, json_output: true, reasoning: true, vision: true },
        reasoning: { can_disable: true, supported_efforts: ["low", "medium", "high"], supports_token_budget: false },
        docs_url: "https://docs.ollama.com/",
      }],
    };
    const diagnostic = vi.spyOn(api, "providerDiagnostics").mockResolvedValue({
      ...(snapshot.provider as ProviderDiagnostic),
      provider: "qwen-main",
      model: "qwen-max",
      status: "smoke_passed",
      connection_checked: true,
      connection_ok: true,
      model_available: true,
      smoke_checked: true,
      smoke_ok: true,
    });
    mountDashboard(root, { api, snapshot: state });

    const selector = root.querySelector<HTMLSelectElement>("[data-provider-selector]");
    if (!selector) throw new Error("overview provider selector");
    selector.value = "qwen-main";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    expect(root.querySelector("[data-provider-selected-name]")?.textContent).toBe("Qwen Main");
    expect(root.querySelector("[data-provider-selected-model]")?.textContent).toContain("qwen-max");
    expect(root.querySelector("[data-provider-command]")?.textContent)
      .toBe("restorkd provider configure qwen");
    expect(root.querySelector<HTMLButtonElement>('[data-provider-diagnostic="web_search"]')?.hidden)
      .toBe(true);

    root.querySelector<HTMLButtonElement>('[data-provider-diagnostic="smoke"]')?.click();
    await vi.waitFor(() => expect(diagnostic)
      .toHaveBeenCalledWith(true, "primary", "qwen-main"));
    expect(root.querySelector("#provider-diagnostic-result")?.textContent).toContain("qwen-max");

    selector.value = "setup:ollama";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    expect(root.querySelector("[data-provider-command]")?.textContent).toBe("ollama serve");
    expect(root.querySelector<HTMLButtonElement>('[data-provider-diagnostic="smoke"]')?.disabled)
      .toBe(true);
  });

  it("shows the bound provider and exact model in the new-conversation selector", () => {
    const root = document.createElement("main");
    const state = workspaceSnapshot();
    if (!state.workspaceV2) throw new Error("workspace fixture");
    state.workspaceV2.providers = [{
      provider: {
        profile_id: "qwen-main",
        version: 1,
        display_name: "Qwen Main",
        kind: "qwen",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-max",
        secret_ref: "keychain:restork/provider/qwen",
        fallback: "disabled",
        reasoning: { effort: "medium", max_tokens: 2048 },
      },
      revision: 1,
      updated_at: "2026-08-04T00:00:00Z",
    }];
    const profile = state.workspaceV2.profiles?.[0];
    if (!profile) throw new Error("configuration profile fixture");
    profile.profile.provider_profile_id = "qwen-main";
    mountDashboard(root, { api: fakeApi(), snapshot: state });

    const option = root.querySelector<HTMLOptionElement>(
      '#session-profile option[value="research-cloud"]',
    );
    expect(option?.textContent).toContain("Research Cloud / Qwen Main / qwen-max / personal");
  });

  it("searches only the active session's frozen tool catalog and previews the real call", async () => {
    const root = document.createElement("main");
    const api = fakeApi();
    const state = workspaceSnapshot();
    state.workspaceV2?.sessions.push({
      session_id: "session-tools",
      title: "Tool review",
      profile_id: "safe-mode",
      status: "active",
      version: 1,
      locale: "en",
      created_at: "2026-08-02T12:00:00Z",
      updated_at: "2026-08-02T12:00:00Z",
      archived_at: null,
    });
    api.sessionMessages = vi.fn(async () => []);
    api.searchSessionTools = vi.fn(async () => ({
      session_id: "session-tools",
      catalog_fingerprint: "c".repeat(64),
      items: [{
        tool_id: "tool.synthetic",
        name: "Synthetic <script>alert(1)</script>",
        score: 42,
      }],
    }));
    api.previewSessionToolCall = vi.fn(async () => ({
      state: "review_required" as const,
      execution_started: false as const,
      output_is_untrusted: true as const,
      call_digest: "d".repeat(64),
      resolved_call: {
        real_tool_id: "server.synthetic.read",
        package_id: "plugin.synthetic",
        package_version: "1.0.0",
        server_id: "server.synthetic",
        required_permissions: ["network:example.com"],
        input: {},
      },
    }));
    mountDashboard(root, { api, snapshot: state });
    await vi.waitFor(() => expect(root.querySelector("#conversation-messages")?.textContent)
      .toContain("ready for its first message"));

    const form = root.querySelector<HTMLFormElement>("#tool-search-form");
    const query = form?.elements.namedItem("query");
    if (form && query instanceof HTMLInputElement) {
      query.value = "synthetic";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
    await vi.waitFor(() => expect(root.querySelector('[data-tool-preview="tool.synthetic"]'))
      .not.toBeNull());
    expect(root.querySelector("script")).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-tool-preview="tool.synthetic"]')?.click();
    await vi.waitFor(() => expect(root.textContent).toContain("server.synthetic.read"));
    expect(api.searchSessionTools).toHaveBeenCalledWith("session-tools", "synthetic");
    expect(api.previewSessionToolCall).toHaveBeenCalledWith(
      "session-tools",
      "tool.synthetic",
      {},
    );
    expect(root.textContent).toContain("Execution has not started");
  });
});
