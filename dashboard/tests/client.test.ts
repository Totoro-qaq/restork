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
