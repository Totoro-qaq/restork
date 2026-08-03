import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalApiClient, systemTimeZone } from "../src/api/client";

function jsonResponse(payload: object): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
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
  it("requests daily context using the browser system timezone", async () => {
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse({ runs: [] }),
      jsonResponse({ approvals: [] }),
      jsonResponse({ configured: false, tasks: [] }),
      jsonResponse({ configured: false, items: [] }),
      jsonResponse({ records: [], counts: {}, architecture: [] }),
      jsonResponse({
        weather: { configured: false, status: "not_configured" },
        calendar: { configured: false, status: "not_configured", events: [], message: "" },
        music: { configured: false, status: "not_configured", recommendation: null },
      }),
      jsonResponse({ status: "ready" }),
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

    const dailyPath = fetchMock.mock.calls
      .map(([path]) => String(path))
      .find((path) => path.startsWith("/v1/daily?"));
    expect(dailyPath).toBe(`/v1/daily?timezone=${encodeURIComponent(systemTimeZone())}`);
  });
});

describe("LocalApiClient provider diagnostics", () => {
  it("posts only the smoke choice through the paired local Core", async () => {
    const report = {
      schema_version: 1,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      status: "smoke_passed",
    };
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse(report),
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

    expect(fetchMock.mock.calls[1][0]).toBe("/v1/providers/deepseek/diagnostics");
    const init = fetchMock.mock.calls[1][1];
    expect(JSON.parse(String(init?.body))).toEqual({ smoke: true });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer paired-token");
    expect(String(init?.body)).not.toMatch(/api.?key|secret/i);
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
});

describe("LocalApiClient governed Step 12-17 endpoints", () => {
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
