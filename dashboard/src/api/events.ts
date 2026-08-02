import type { RunEvent } from "./types";

export class EventCursor {
  readonly #seen = new Set<string>();
  #cursor = 0;

  get cursor(): number {
    return this.#cursor;
  }

  accept(payload: string): RunEvent[] {
    return this.acceptEvents(parseEventStream(payload));
  }

  acceptEvents(events: RunEvent[]): RunEvent[] {
    const accepted: RunEvent[] = [];
    for (const event of events) {
      const identity = `${event.id}:${event.type}`;
      if (this.#seen.has(identity)) continue;
      this.#seen.add(identity);
      this.#cursor = Math.max(this.#cursor, event.id);
      accepted.push(event);
    }
    return accepted;
  }
}

export class EventStreamDecoder {
  #buffer = "";

  push(chunk: string): RunEvent[] {
    this.#buffer += chunk;
    const events: RunEvent[] = [];
    let boundary = frameBoundary(this.#buffer);
    while (boundary) {
      const frame = this.#buffer.slice(0, boundary.index);
      this.#buffer = this.#buffer.slice(boundary.index + boundary.length);
      const event = parseFrame(frame);
      if (event) events.push(event);
      boundary = frameBoundary(this.#buffer);
    }
    return events;
  }

  finish(): RunEvent[] {
    const frame = this.#buffer;
    this.#buffer = "";
    if (!frame.trim()) return [];
    const event = parseFrame(frame);
    return event ? [event] : [];
  }
}

export function parseEventStream(payload: string): RunEvent[] {
  const decoder = new EventStreamDecoder();
  return [...decoder.push(payload), ...decoder.finish()];
}

function parseFrame(frame: string): RunEvent | null {
  let id: number | null = null;
  let type = "message";
  const data: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = Number(line.slice(3).trim());
    else if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (id === null && data.length === 0) return null;
  if (id === null || !Number.isSafeInteger(id) || id < 0) {
    throw new Error("Core returned an invalid event cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    throw new Error("Core returned invalid event data");
  }
  if (!isRecord(parsed)) throw new Error("Core returned a non-object event");
  return { id, type, data: parsed };
}

function frameBoundary(value: string): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
