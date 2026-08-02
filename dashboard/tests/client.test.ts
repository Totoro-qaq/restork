import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalApiClient } from "../src/api/client";
import type { MemoryRecord } from "../src/api/types";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function profileRecord(memoryId: string, contentHash: string): MemoryRecord {
  return {
    memory_id: memoryId,
    layer: "profile",
    kind: memoryId.split(".").at(-1) ?? "profile",
    summary: "",
    provenance: "user",
    data_class: "personal",
    retention_class: "durable",
    updated_at: "2026-08-02T00:00:00Z",
    content_hash: contentHash,
  };
}

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
  it("disables the provider before changing coordinates and reenables it last", async () => {
    const provider = profileRecord("profile:daily.weather_provider", HASH_A);
    const location = profileRecord("profile:daily.weather_location", HASH_B);
    const responses = [
      jsonResponse({ access_token: "paired-token" }),
      jsonResponse({ records: [provider, location] }),
      jsonResponse({ ...provider, content_hash: HASH_C }),
      jsonResponse({ ...location, content_hash: HASH_C }),
      jsonResponse({ ...provider, content_hash: HASH_B }),
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
      label: "Home",
      latitude: 31.2304,
      longitude: 121.4737,
    });

    const requests = fetchMock.mock.calls.slice(2).map(([, init]) => {
      if (!init) throw new Error("missing request options");
      return {
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        headers: new Headers(init.headers),
      };
    });
    expect(requests.map(({ body }) => body.value)).toEqual([
      "",
      "Home|31.2304,121.4737",
      "open-meteo",
    ]);
    expect(requests[2].body.expected_content_hash).toBe(HASH_C);
    expect(requests.every(({ headers }) => headers.get("Authorization") === "Bearer paired-token"))
      .toBe(true);
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
