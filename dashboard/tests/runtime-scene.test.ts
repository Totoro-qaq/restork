import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunEvent } from "../src/api/types";
import { configureRuntimeScene } from "../src/features/runtimeScene";
import { agentWaitMarkup, runtimeActivityForEvent } from "../src/ui/runtimeScene";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("runtime scene", () => {
  it("shows only source and tool names reported by the event stream", () => {
    const sourceEvent: RunEvent = {
      id: 1,
      type: "research.source_completed",
      data: { source_name: "OpenAlex paper index" },
    };
    const toolEvent: RunEvent = {
      id: 2,
      type: "tool.completed",
      data: { tool: "vault_search" },
    };
    const activity = runtimeActivityForEvent(
      runtimeActivityForEvent({}, sourceEvent),
      toolEvent,
    );
    const markup = agentWaitMarkup("model", "en", { activity, cancellable: true });

    expect(markup).toContain('data-runtime-active="true"');
    expect(markup).toContain("OpenAlex paper index");
    expect(markup).toContain("vault_search");
    expect(markup).toContain("data-runtime-elapsed");
    expect(markup).toContain("data-runtime-stop");
  });

  it("returns to a quiet review state after the task stops", () => {
    const markup = agentWaitMarkup("complete", "zh-CN");

    expect(markup).toContain('data-runtime-active="false"');
    expect(markup).toContain("完成了，结果可以查看");
    expect(markup).not.toContain("data-runtime-stop");
    expect(markup).not.toContain("runtime-facts");
  });

  it("renders cancellation as a terminal state instead of an active task", () => {
    const markup = agentWaitMarkup("cancelled", "zh-CN", { cancellable: true });

    expect(markup).toContain('data-runtime-active="false"');
    expect(markup).toContain("已停止，这项任务不再运行");
    expect(markup).not.toContain("任务进行中");
    expect(markup).not.toContain("data-runtime-stop");
    expect(markup).not.toContain("data-runtime-elapsed");
  });

  it("shows cancellation as pending until Core reports the terminal event", () => {
    const markup = agentWaitMarkup("cancelling", "zh-CN", { cancellable: true });

    expect(markup).toContain('data-runtime-active="true"');
    expect(markup).toContain("正在停止任务，等待 Core 确认");
    expect(markup).not.toContain("data-runtime-stop");
  });

  it("does not promise cancellation for a generic wait scene", () => {
    const markup = agentWaitMarkup("sources", "en");

    expect(markup).toContain('data-runtime-active="true"');
    expect(markup).not.toContain("data-runtime-stop");
  });

  it("mirrors the existing cancel action and keeps elapsed time visible", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T08:01:05Z"));
    const root = document.createElement("main");
    root.innerHTML = `<button type="button" data-start-cancel>Cancel</button>
      <div data-run-wait data-runtime-started-at="${Date.parse("2026-08-14T08:00:00Z")}">
        ${agentWaitMarkup("model", "en", { cancellable: true })}
      </div>`;
    document.body.append(root);
    const original = root.querySelector<HTMLButtonElement>("[data-start-cancel]")!;
    const onCancel = vi.fn();
    original.addEventListener("click", onCancel);

    const cleanup = configureRuntimeScene(root);
    expect(original.hidden).toBe(true);
    expect(root.querySelector("[data-runtime-elapsed]")?.textContent).toBe("1:05");

    root.querySelector<HTMLButtonElement>("[data-runtime-stop]")?.click();
    expect(onCancel).toHaveBeenCalledOnce();
    cleanup();
    expect(original.hidden).toBe(false);
  });

  it("stops its elapsed-time timer after the workspace is removed", () => {
    vi.useFakeTimers();
    const root = document.createElement("main");
    root.innerHTML = `<button type="button" data-start-cancel>Cancel</button>
      <div data-run-wait>
        ${agentWaitMarkup("model", "en", { cancellable: true })}
      </div>`;
    document.body.append(root);

    configureRuntimeScene(root);
    expect(vi.getTimerCount()).toBe(1);

    root.remove();
    vi.advanceTimersByTime(1_000);

    expect(vi.getTimerCount()).toBe(0);
  });
});
