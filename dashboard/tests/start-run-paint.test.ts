import { describe, expect, it } from "vitest";

import { paintStartRunEvent, prepareStartRunFeedback } from "../src/features/startRunPaint";
import type { RunEvent } from "../src/api/types";

function surface(): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = `
    <span data-run-status></span>
    <button type="button" data-start-cancel hidden></button>
    <section data-start-output hidden><pre data-start-output-text></pre></section>
  `;
  return host;
}

function delta(id: number, content: string): RunEvent {
  return { id, type: "assistant.delta", data: { content } } as RunEvent;
}

function completed(id: number): RunEvent {
  return { id, type: "run.completed", data: {} } as RunEvent;
}

describe("start run output painting", () => {
  it("streams prose answers live and keeps them after completion", () => {
    const root = surface();
    prepareStartRunFeedback(root, "run-1");
    paintStartRunEvent(root, delta(1, "这是一段"), "zh-CN");
    paintStartRunEvent(root, delta(2, "普通回答。"), "zh-CN");
    const output = root.querySelector<HTMLElement>("[data-start-output]")!;
    expect(output.hidden).toBe(false);
    paintStartRunEvent(root, completed(3), "zh-CN");
    expect(root.textContent).toContain("这是一段普通回答。");
  });

  it("never shows raw question JSON while streaming or after completion", () => {
    const root = surface();
    prepareStartRunFeedback(root, "run-2");
    paintStartRunEvent(root, delta(1, "{\"questions\":[{\"prompt\":\""), "zh-CN");
    paintStartRunEvent(root, delta(2, "问题一\"}]}"), "zh-CN");
    const output = root.querySelector<HTMLElement>("[data-start-output]")!;
    expect(output.hidden).toBe(true);
    paintStartRunEvent(root, completed(3), "zh-CN");
    // 完成后升级为就绪提示卡，而不是原始 JSON
    expect(root.textContent).toContain("学习诊断 · 1 个问题已就绪");
    expect(root.querySelector<HTMLElement>("[data-start-output]")!.hidden).toBe(false);
    expect(root.querySelector("pre[data-start-output-text]")).toBeNull();
  });

  it("hides unrecognised structured payloads instead of dumping raw JSON", () => {
    const root = surface();
    prepareStartRunFeedback(root, "run-3");
    paintStartRunEvent(root, delta(1, "{\"unexpected\":true}"), "zh-CN");
    const output = root.querySelector<HTMLElement>("[data-start-output]")!;
    expect(output.hidden).toBe(true);
    paintStartRunEvent(root, completed(2), "zh-CN");
    expect(output.hidden).toBe(true);
    expect(root.textContent).not.toContain("unexpected");
  });

  it("suppresses any raw stream in study mode even if it does not look like JSON", () => {
    const root = surface();
    prepareStartRunFeedback(root, "run-4");
    paintStartRunEvent(root, delta(1, "好的，以下是问题："), "zh-CN", undefined, "run-4", "study");
    const output = root.querySelector<HTMLElement>("[data-start-output]")!;
    expect(output.hidden).toBe(true);
    paintStartRunEvent(root, completed(2), "zh-CN", undefined, "run-4", "study");
    expect(output.hidden).toBe(true);
    expect(root.textContent).not.toContain("好的，以下是问题：");
  });

  it("resets structured detection between runs", () => {
    const root = surface();
    prepareStartRunFeedback(root, "run-5");
    paintStartRunEvent(root, delta(1, "{\"questions\":[{\"prompt\":\"x\"}]}"), "zh-CN");
    prepareStartRunFeedback(root, "run-6");
    paintStartRunEvent(root, delta(2, "新的普通回答"), "zh-CN");
    expect(root.querySelector<HTMLElement>("[data-start-output]")!.hidden).toBe(false);
  });
});
