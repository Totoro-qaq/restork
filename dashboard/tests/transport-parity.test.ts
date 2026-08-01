import { describe, expect, it } from "vitest";

import payload from "./fixtures/transport-event.sse?raw";
import { parseEventStream } from "../src/api/events";
import { runEventsMarkup } from "../src/ui/render";

describe("CLI and Dashboard transport/rendering parity", () => {
  it("preserves event values and escapes markup only at the HTML boundary", () => {
    const [event] = parseEventStream(payload);

    expect(event).toEqual({
      id: 42,
      type: "artifact.ready",
      data: {
        title: "研究 <script> — café",
        summary: "line one\n第二行",
        refs: ["source-a", "笔记-b"],
      },
    });

    const root = document.createElement("div");
    root.innerHTML = runEventsMarkup({
      summary: {
        run_id: "run-parity",
        task_id: "task-parity",
        mode: "research",
        state: "running",
        state_version: 1,
        stop_reason: null,
        created_at: "2026-08-02T00:00:00Z",
        updated_at: "2026-08-02T00:00:00Z",
      },
      task: null,
      budget: null,
    }, [event]);
    expect(root.querySelector("script")).toBeNull();
    expect(root.textContent).toContain("研究 <script> — café");
    expect(root.textContent).toContain("第二行");
  });
});
