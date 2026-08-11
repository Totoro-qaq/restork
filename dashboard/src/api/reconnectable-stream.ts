import { EventCursor, EventStreamDecoder } from "./events";
import type { RunEvent } from "./types";

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

interface ReconnectableStreamOptions {
  after: number;
  cursor: EventCursor;
  open: (lastEventId: number) => Promise<Response>;
  onEvent: (event: RunEvent) => void;
  terminalTypes: ReadonlySet<string>;
  signal: AbortSignal;
  responseError: (response: Response) => Promise<Error>;
  initialRetryMs?: number;
}

export async function streamDurableEvents(
  options: ReconnectableStreamOptions,
): Promise<void> {
  let retryMs = options.initialRetryMs ?? 750;
  let terminal = false;
  while (!options.signal.aborted && !terminal) {
    let response: Response;
    try {
      response = await options.open(Math.max(options.after, options.cursor.cursor));
    } catch (error) {
      if (options.signal.aborted) return;
      if (!isTransportInterruption(error)) throw error;
      await waitForReconnect(retryMs, options.signal);
      retryMs = Math.min(15_000, retryMs * 2);
      continue;
    }
    if (!response.ok) {
      if (!TRANSIENT_STATUSES.has(response.status)) throw await options.responseError(response);
      await waitForReconnect(retryMs, options.signal);
      retryMs = Math.min(15_000, retryMs * 2);
      continue;
    }
    if (!response.body) throw new Error("Core returned an unreadable event stream");

    retryMs = options.initialRetryMs ?? 750;
    const reader = response.body.getReader();
    const utf8 = new TextDecoder();
    const decoder = new EventStreamDecoder();
    let interrupted = false;
    const deliver = (events: RunEvent[]): void => {
      for (const event of options.cursor.acceptEvents(events)) {
        options.onEvent(event);
        if (options.terminalTypes.has(event.type)) terminal = true;
      }
    };
    while (!options.signal.aborted && !terminal) {
      try {
        const { done, value } = await reader.read();
        if (done) break;
        deliver(decoder.push(utf8.decode(value, { stream: true })));
      } catch (error) {
        if (options.signal.aborted) return;
        if (!isTransportInterruption(error)) throw error;
        interrupted = true;
        break;
      }
    }
    if (!interrupted) {
      deliver(decoder.push(utf8.decode()));
      deliver(decoder.finish());
    }
    if (!options.signal.aborted && !terminal) {
      await waitForReconnect(retryMs, options.signal);
      retryMs = Math.min(15_000, retryMs * 2);
    }
  }
}

function isTransportInterruption(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof DOMException && error.name !== "AbortError");
}

function waitForReconnect(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
