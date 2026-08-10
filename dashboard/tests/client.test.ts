import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalApiClient, systemTimeZone } from "../src/api/client";
import type { RunEvent } from "../src/api/types";

function jsonResponse(payload: object): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LocalApiClient session recovery", () => {
  it("resumes a refreshed loopback page without exposing a token to web storage", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      access_token: "resumed-token",
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();

    await expect(client.resumeSession()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/v1/token/resume");
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe("same-origin");
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it("rotates an expired desktop token through the bounded recovery route", async () => {
    const onSession = vi.fn(async () => undefined);
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({
      access_token: "fresh-token",
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient({ onSession });

    await expect(client.resumeSession({
      accessToken: "sleep-expired-token",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })).resolves.toBe(true);

    expect(fetchMock.mock.calls[0][0]).toBe("/v1/token/rotate");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization"))
      .toBe("Bearer sleep-expired-token");
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe("same-origin");
    expect(onSession).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "fresh-token" }));
  });

  it("falls back to pairing when no protected browser resume exists", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ detail: "local session is unavailable" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    )));
    const client = new LocalApiClient();

    await expect(client.resumeSession()).resolves.toBe(false);
  });
});

describe("LocalApiClient weather configuration", () => {
  it("sends a manual city only through the paired Core configuration endpoint", async () => {
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse({
        configured: true,
        location_label: "Guangzhou, Guangdong, China",
        latitude: 23.13,
        longitude: 113.26,
      }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();

    await client.pair("pairing-code");
    await client.configureWeather({
      enabled: true,
      mode: "query",
      query: "Guangzhou",
      language: "en",
    });

    expect(fetchMock.mock.calls[1][0]).toBe("/v1/daily/weather");
    const request = fetchMock.mock.calls[1][1];
    expect(JSON.parse(String(request?.body))).toEqual({
      enabled: true,
      mode: "query",
      query: "Guangzhou",
      language: "en",
    });
    const headers = new Headers(request?.headers);
    expect(headers.get("Authorization")).toBe("Bearer paired-token");
    expect(headers.get("Idempotency-Key")).toMatch(/^dashboard-weather-/);
  });
});

describe("LocalApiClient calendar configuration", () => {
  it("imports ICS content through the paired local Core", async () => {
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse({ configured: true, status: "ready", events: [], message: "" }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();

    await client.pair("pairing-code");
    await client.configureCalendar({
      enabled: true,
      filename: "calendar.ics",
      content: "BEGIN:VCALENDAR\nEND:VCALENDAR\n",
      timezone: "Asia/Shanghai",
    });

    expect(fetchMock.mock.calls[1][0]).toBe("/v1/daily/calendar");
    const request = fetchMock.mock.calls[1][1];
    expect(JSON.parse(String(request?.body))).toEqual({
      enabled: true,
      filename: "calendar.ics",
      content: "BEGIN:VCALENDAR\nEND:VCALENDAR\n",
      timezone: "Asia/Shanghai",
    });
    expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer paired-token");
  });
});

describe("LocalApiClient private mail awareness", () => {
  it("connects explicitly and streams only the validated unread-count snapshot", async () => {
    const mail = {
      configured: true,
      status: "fresh",
      provider: "macos-mail",
      unread_count: 4,
      observed_at: "2026-08-05T12:00:00Z",
      message: "Aggregate only",
    };
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse(mail),
      new Response(
        `id: 1\nevent: mail.snapshot\ndata: ${JSON.stringify({ ...mail, unread_count: 5 })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();

    await client.pair("pairing-code");
    await client.connectNativeMail();
    const controller = new AbortController();
    let unread: number | null = null;
    await client.streamMail((snapshot) => {
      unread = snapshot.unread_count;
      controller.abort();
    }, controller.signal);

    expect(fetchMock.mock.calls[1][0]).toBe("/v1/daily/mail/native/connect");
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("Idempotency-Key"))
      .toMatch(/^dashboard-native-mail-/);
    expect(fetchMock.mock.calls[2][0]).toBe("/v1/daily/mail/events");
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("Authorization"))
      .toBe("Bearer paired-token");
    expect(unread).toBe(5);
  });
});

describe("LocalApiClient Vault browser", () => {
  it("uses authenticated relative-path APIs and reconnectable SSE events", async () => {
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse({
        configured: true,
        items: [{ relative_path: "Notes/A B.md", byte_count: 12, modified_unix_ms: 1 }],
        total: 1,
        page: { limit: 100, has_more: false, next_cursor: null },
      }),
      jsonResponse({
        items: [{ relative_path: "Notes/A B.md", excerpt: "bounded", sha256: "a".repeat(64) }],
      }),
      jsonResponse({
        relative_path: "Notes/A B.md",
        content: "# Bounded",
        sha256: "a".repeat(64),
        byte_count: 9,
        output_is_untrusted: true,
      }),
      new Response(
        "id: 1\nevent: vault.changed\ndata: {\"changed_count\":1,\"modified\":[\"Notes/A B.md\"]}\n\n",
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();
    await client.pair("pairing-code");

    await client.listVaultNotes();
    await client.searchVaultNotes("bounded loop");
    await client.readVaultNote("Notes/A B.md");
    const controller = new AbortController();
    let changed = 0;
    await client.streamVaultEvents((event) => {
      changed = event.data.changed_count ?? 0;
      controller.abort();
    }, controller.signal);

    expect(fetchMock.mock.calls[1][0]).toBe("/v1/vault/files?limit=100");
    expect(fetchMock.mock.calls[2][0]).toBe("/v1/vault/search?q=bounded%20loop&limit=50");
    expect(fetchMock.mock.calls[3][0]).toBe("/v1/vault/note?path=Notes%2FA%20B.md");
    expect(fetchMock.mock.calls[4][0]).toBe("/v1/vault/events");
    expect(new Headers(fetchMock.mock.calls[4][1]?.headers).get("Authorization"))
      .toBe("Bearer paired-token");
    expect(changed).toBe(1);
  });
});

describe("LocalApiClient conversation model branches", () => {
  it("sends an explicit bounded fork request without provider credentials", async () => {
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse({
        session: {
          session_id: "session-branch",
          title: "Research · deepseek",
          profile_id: "deepseek",
          status: "active",
          version: 1,
          locale: "en",
          created_at: "2026-08-05T12:00:00Z",
          updated_at: "2026-08-05T12:00:00Z",
          archived_at: null,
        },
        source_session_id: "session-source",
        copied_messages: 2,
        omitted_messages: 0,
        copied_bytes: 42,
        profile_id: "deepseek",
      }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();

    await client.pair("pairing-code");
    await client.forkSession(
      "session-source",
      "Research · deepseek",
      "deepseek",
      "2026-08-05T11:59:00Z",
    );

    expect(fetchMock.mock.calls[1][0]).toBe("/v1/sessions/session-source/fork");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      title: "Research · deepseek",
      profile_id: "deepseek",
      expected_updated_at: "2026-08-05T11:59:00Z",
      copy_limit: 24,
    });
    expect(String(fetchMock.mock.calls[1][1]?.body)).not.toMatch(/api.?key|credential|secret/i);
  });
});

describe("LocalApiClient reviewed extension installation", () => {
  it("keeps preview and installation as two explicit requests bound to one digest", async () => {
    const digest = "a".repeat(64);
    const manifest = { schema_version: 1, id: "skill.reviewed", version: "1.0.0" };
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse({
        state: "review_required",
        installation_started: false,
        preview_digest: digest,
        preview: { package_kind: "skill", manifest },
      }),
      jsonResponse({
        package_id: "skill.reviewed",
        package_kind: "skill",
        state: "quarantined",
        manifest_hash: digest,
        manifest,
        updated_at: "2026-08-05T12:00:00Z",
      }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();

    await client.pair("pairing-code");
    const preview = await client.previewExtensionInstall("skill", manifest);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      package_kind: "skill",
      manifest,
    });

    await client.installExtension("skill", manifest, preview.preview_digest);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      package_kind: "skill",
      manifest,
      approved_preview_digest: digest,
    });
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("Authorization"))
      .toBe("Bearer paired-token");
  });
});

describe("LocalApiClient private playlist configuration", () => {
  it("imports playlist content only through the paired local Core", async () => {
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse({ configured: true, status: "ready", recommendation: null, message: "" }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();

    await client.pair("pairing-code");
    await client.configureMusic({
      enabled: true,
      source: "file",
      filename: "playlist.csv",
      content: "title,artist\nSynthetic Song,Fixture\n",
      local_date: "2026-08-02",
    });

    expect(fetchMock.mock.calls[1][0]).toBe("/v1/daily/music");
    const request = fetchMock.mock.calls[1][1];
    expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer paired-token");
    expect(new Headers(request?.headers).get("Idempotency-Key")).toMatch(/^dashboard-music-/);
    expect(String(request?.body)).not.toContain("api_key");
  });
});

describe("LocalApiClient daily timezone", () => {
  it("loads the complete workspace through one timezone-aware bootstrap request", async () => {
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse({
        runs: [],
        approvals: [],
        taskBoard: { configured: false, tasks: [] },
        radar: { configured: false, items: [] },
        memory: null,
        daily: null,
        provider: null,
        domains: { daily: { state: "ready" } },
      }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();

    await client.pair("pairing-code");
    await client.loadDashboard();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `/v1/bootstrap?timezone=${encodeURIComponent(systemTimeZone())}`,
    );
  });
});

describe("LocalApiClient local Todo lifecycle", () => {
  it("uses paired Core routes for edit, soft delete, restore, and deleted pagination", async () => {
    const record = {
      task_id: "todo-1",
      title: "Review results",
      details: "",
      priority: "P1",
      due_at: null,
      status: "open",
      origin: "user",
      created_at: "2026-08-08T10:00:00Z",
      updated_at: "2026-08-08T10:00:00Z",
      deleted_at: null,
    };
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse(record),
      jsonResponse({ ...record, title: "Review final results" }),
      new Response(null, { status: 204 }),
      jsonResponse(record),
      jsonResponse({ tasks: [{ ...record, deleted_at: record.updated_at }], page: { limit: 12, has_more: false, next_cursor: null } }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();
    await client.pair("pairing-code");

    await client.createLocalTodo({
      title: record.title,
      details: "",
      priority: "P1",
      due_at: null,
      completed: false,
      origin: "user",
    });
    await client.updateLocalTodo("todo-1", {
      title: "Review final results",
      details: "",
      priority: "P1",
      due_at: null,
      completed: false,
      origin: "user",
      expected_updated_at: record.updated_at,
    });
    await client.deleteLocalTodo("todo-1", record.updated_at);
    await client.restoreLocalTodo("todo-1", record.updated_at);
    await client.loadDeletedTodos("12");

    expect(fetchMock.mock.calls[1][0]).toBe("/v1/tasks/local");
    expect(fetchMock.mock.calls[2][0]).toBe("/v1/tasks/local/todo-1");
    expect(fetchMock.mock.calls[3][1]?.method).toBe("DELETE");
    expect(fetchMock.mock.calls[4][0]).toBe("/v1/tasks/local/todo-1/restore");
    expect(fetchMock.mock.calls[5][0]).toBe("/v1/tasks/local/deleted?limit=12&cursor=12");
  });
});

describe("LocalApiClient provider diagnostics", () => {
  it("posts explicit per-model diagnostic targets through the paired local Core", async () => {
    const report = {
      schema_version: 1,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      status: "smoke_passed",
    };
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse(report),
      jsonResponse({ ...report, model: "deepseek-v4-flash" }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();

    await client.pair("pairing-code");
    await client.providerDiagnostics(true);
    await client.providerDiagnostics(true, "web_search", "flash-research");

    expect(fetchMock.mock.calls[1][0]).toBe("/v1/providers/deepseek/diagnostics");
    const init = fetchMock.mock.calls[1][1];
    expect(JSON.parse(String(init?.body))).toEqual({ smoke: true });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer paired-token");
    expect(String(init?.body)).not.toMatch(/api.?key|secret/i);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      smoke: true,
      target: "web_search",
    });
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/v1/providers/flash-research/diagnostics",
    );
  });

  it("rotates a resumed near-expiry session before running the check", async () => {
    const responses = [
      jsonResponse({
        access_token: "sleeping-token",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
      jsonResponse({
        access_token: "recovered-token",
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      }),
      jsonResponse({
        schema_version: 1,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        status: "connected",
      }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();

    await client.pair("pairing-code");
    await client.providerDiagnostics(false);

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/v1/pair",
      "/v1/token/rotate",
      "/v1/providers/deepseek/diagnostics",
    ]);
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("Authorization"))
      .toBe("Bearer recovered-token");
  });

  it("retries one transient loopback transport failure and does not loop", async () => {
    const report = {
      schema_version: 1,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      status: "connected",
    };
    let diagnosticAttempts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (path) => {
      if (path === "/v1/pair") return jsonResponse({ access_token: "paired-token" });
      diagnosticAttempts += 1;
      if (diagnosticAttempts === 1) throw new TypeError("temporary loopback disconnect");
      return jsonResponse(report);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();

    await client.pair("pairing-code");
    await expect(client.providerDiagnostics(false)).resolves.toMatchObject(report);

    expect(diagnosticAttempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("LocalApiClient authenticated SSE", () => {
  it("decodes UTF-8 chunks and stops after a durable terminal event", async () => {
    const payload = [
      "id: 5",
      "event: model.started",
      'data: {"label":"推理中"}',
      "",
      ": restork-heartbeat",
      "",
      "id: 6",
      "event: run.completed",
      'data: {"state":"completed"}',
      "",
    ].join("\r\n");
    const bytes = new TextEncoder().encode(payload);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 5) {
          controller.enqueue(bytes.slice(index, index + 5));
        }
        controller.close();
      },
    });
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected reconnect");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();
    const delivered: Array<{ id: number; type: string }> = [];

    await client.pair("pairing-code");
    await client.streamEvents(
      "run-1",
      4,
      (event) => delivered.push({ id: event.id, type: event.type }),
      new AbortController().signal,
    );

    expect(delivered).toEqual([
      { id: 5, type: "model.started" },
      { id: 6, type: "run.completed" },
    ]);
    expect(fetchMock.mock.calls[1][0]).toBe("/v1/runs/run-1/events?follow=true");
    const streamHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(streamHeaders.get("Authorization")).toBe("Bearer paired-token");
    expect(streamHeaders.get("Last-Event-ID")).toBe("4");
  });

  it("rotates auth independently and resumes one run from its last durable event", async () => {
    vi.useFakeTimers();
    let now = Date.parse("2026-08-10T05:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const streamBody = (text: string): Response => new Response(text, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const first = [
      "id: 5",
      "event: model.started",
      'data: {"label":"working"}',
      "",
      "",
    ].join("\n");
    const resumed = [
      "id: 5",
      "event: model.started",
      'data: {"label":"duplicate"}',
      "",
      "id: 6",
      "event: run.completed",
      'data: {"state":"completed"}',
      "",
      "",
    ].join("\n");
    let streamAttempt = 0;
    const fetchMock = vi.fn<typeof fetch>(async (path) => {
      if (path === "/v1/pair") {
        return jsonResponse({
          access_token: "before-sleep-token",
          expires_at: new Date(now + 300_000).toISOString(),
        });
      }
      if (path === "/v1/token/rotate") {
        return jsonResponse({
          access_token: "after-sleep-token",
          expires_at: new Date(now + 300_000).toISOString(),
        });
      }
      streamAttempt += 1;
      if (streamAttempt === 1) {
        now += 400_000;
        return streamBody(first);
      }
      return streamBody(resumed);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();
    const delivered: Array<{ id: number; type: string }> = [];

    await client.pair("pairing-code");
    const streaming = client.streamEvents(
      "run-stable",
      4,
      (event) => delivered.push({ id: event.id, type: event.type }),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(750);
    await streaming;

    expect(delivered).toEqual([
      { id: 5, type: "model.started" },
      { id: 6, type: "run.completed" },
    ]);
    const streamCalls = fetchMock.mock.calls.filter(([path]) =>
      String(path).includes("/v1/runs/run-stable/events"));
    expect(streamCalls).toHaveLength(2);
    expect(new Headers(streamCalls[0][1]?.headers).get("Last-Event-ID")).toBe("4");
    expect(new Headers(streamCalls[0][1]?.headers).get("Authorization"))
      .toBe("Bearer before-sleep-token");
    expect(new Headers(streamCalls[1][1]?.headers).get("Last-Event-ID")).toBe("5");
    expect(new Headers(streamCalls[1][1]?.headers).get("Authorization"))
      .toBe("Bearer after-sleep-token");
    expect(streamCalls[0][0]).toBe(streamCalls[1][0]);
  });

  it("reconnects a dropped SSE transport without changing the run identity", async () => {
    vi.useFakeTimers();
    let streamAttempts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (path) => {
      if (path === "/v1/pair") return jsonResponse({ access_token: "paired-token" });
      streamAttempts += 1;
      if (streamAttempts === 1) throw new TypeError("socket dropped");
      return new Response([
        "id: 1",
        "event: run.completed",
        'data: {"state":"completed"}',
        "",
        "",
      ].join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();
    const delivered: RunEvent[] = [];

    await client.pair("pairing-code");
    const streaming = client.streamEvents(
      "run-one-identity",
      0,
      (event) => delivered.push(event),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(750);
    await streaming;

    expect(streamAttempts).toBe(2);
    expect(delivered.map((event) => event.id)).toEqual([1]);
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[2][0]);
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("Last-Event-ID")).toBe("0");
  });
});

describe("LocalApiClient Step 12-17 endpoints", () => {
  it("uses paired Core routes for frozen tools, deliverables, and idempotent schedules", async () => {
    const responses: Response[] = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse({
        session_id: "session-1",
        catalog_fingerprint: "a".repeat(64),
        items: [{ tool_id: "tool.read", name: "Read", score: 10 }],
      }),
      jsonResponse({
        state: "review_required",
        execution_started: false,
        output_is_untrusted: true,
        resolved_call: {
          real_tool_id: "server.read",
          package_id: "plugin.fixture",
          package_version: "1.0.0",
          server_id: "server.fixture",
          required_permissions: ["read:fixture"],
          input: {},
        },
      }),
      jsonResponse({
        deliverable_id: "report-1",
        kind: "daily_report",
        state: "draft",
        revision: 1,
        updated_at: "2026-08-02T12:00:00Z",
      }),
      jsonResponse({
        schedule_id: "schedule-1",
        period_key: "manual:fixture",
        run_id: null,
        result: { external_effect: false },
        created_at: "2026-08-02T12:00:00Z",
        replayed: false,
      }),
      new Response(null, { status: 204 }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LocalApiClient();

    await client.pair("pairing-code");
    await client.searchSessionTools("session-1", "read fixture");
    await client.previewSessionToolCall("session-1", "tool.read", {});
    await client.composeManualReport({
      report_id: "report-1",
      revision: 1,
      kind: "daily",
      title: "Daily report",
      language: "en-US",
      timezone: "Asia/Shanghai",
      entries: [{ section: "completed", text: "Synthetic task completed." }],
    });
    await client.runScheduleNow("schedule-1");
    await client.deleteSchedule("schedule-1", 2);

    expect(fetchMock.mock.calls[1][0]).toBe(
      "/v1/sessions/session-1/tools/search?q=read%20fixture&limit=20",
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/v1/sessions/session-1/tool-call-preview",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      tool_id: "tool.read",
      input: {},
    });
    expect(fetchMock.mock.calls[3][0]).toBe("/v1/deliverables/reports/manual");
    expect(fetchMock.mock.calls[4][0]).toBe("/v1/schedules/schedule-1/run");
    expect(new Headers(fetchMock.mock.calls[4][1]?.headers).get("Idempotency-Key"))
      .toMatch(/^dashboard-schedule-/);
    expect(fetchMock.mock.calls[5][0]).toBe(
      "/v1/schedules/schedule-1?expected_revision=2",
    );
    expect(fetchMock.mock.calls[5][1]?.method).toBe("DELETE");
    expect(fetchMock.mock.calls.map(([, init]) => String(init?.body ?? "")).join(""))
      .not.toMatch(/api.?key|credential|secret_value/i);
  });
});
