import { describe, expect, it } from "vitest";

import { EventCursor, parseEventStream } from "../src/api/events";

const FRAME = [
  "id: 7",
  "event: run.updated",
  'data: {"state":"running"}',
  "",
  "id: 8",
  "event: artifact.ready",
  'data: {"artifact_id":"artifact-1"}',
  "",
].join("\n");

describe("Core event stream", () => {
  it("parses typed event envelopes", () => {
    expect(parseEventStream(FRAME)).toEqual([
      { id: 7, type: "run.updated", data: { state: "running" } },
      { id: 8, type: "artifact.ready", data: { artifact_id: "artifact-1" } },
    ]);
  });

  it("deduplicates reconnect replays and advances the cursor", () => {
    const cursor = new EventCursor();

    expect(cursor.accept(FRAME)).toHaveLength(2);
    expect(cursor.accept(FRAME)).toEqual([]);
    expect(cursor.cursor).toBe(8);
  });

  it("rejects malformed cursors and non-object data", () => {
    expect(() => parseEventStream('id: nope\ndata: {"ok":true}\n')).toThrow(
      "invalid event cursor",
    );
    expect(() => parseEventStream("id: 1\ndata: []\n")).toThrow("non-object event");
  });
});
