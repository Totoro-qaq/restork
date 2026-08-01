import type { RunEvent } from "./types";

export class EventCursor {
  readonly #seen = new Set<string>();
  #cursor = 0;

  get cursor(): number {
    return this.#cursor;
  }

  accept(payload: string): RunEvent[] {
    const events = parseEventStream(payload);
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

export function parseEventStream(payload: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const frame of payload.split(/\n\n+/)) {
    if (!frame.trim()) continue;
    let id: number | null = null;
    let type = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("id:")) id = Number(line.slice(3).trim());
      else if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
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
    events.push({ id, type, data: parsed });
  }
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
