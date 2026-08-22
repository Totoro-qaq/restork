import { describe, expect, it } from "vitest";

import { paintStartRunEvent, prepareStartRunFeedback, setStartRunBusy } from "../src/features/startRunPaint";
import type { RunEvent } from "../src/api/types";

function surface(): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = `
    <form id="start-run-form"><button type="submit" data-start-submit>开始任务</button></form>
    <span data-run-status></span>
    <button type="button" data-start-cancel hidden></button>
    <section data-start-output hidden>
      <details open data-start-output-details>
        <summary><span>任务输出</span></summary>
        <div class="start-output-scroll" data-start-output-body><div class="markdown-body" data-start-output-text></div></div>
      </details>
    </section>
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
  it("streams prose answers as rendered markdown and keeps them after completion", () => {
    const root = surface();
    prepareStartRunFeedback(root, "run-1");
    paintStartRunEvent(root, delta(1, "# 这是标题\n"), "zh-CN");
    paintStartRunEvent(root, delta(2, "普通回答。"), "zh-CN");
    const output = root.querySelector<HTMLElement>("[data-start-output]")!;
    expect(output.hidden).toBe(false);
    // 实时渲染成标题元素，而不是裸露的 # 号
    expect(root.querySelector("[data-start-output-text] h2")?.textContent).toBe("这是标题");
    expect(root.textContent).not.toContain("# 这是标题");
    paintStartRunEvent(root, completed(3), "zh-CN");
    expect(root.textContent).toContain("普通回答。");
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
    // 结构化负载不再出现在普通产品界面；原始事件仅在运行页的开发者诊断中保留。
    expect(root.querySelector("[data-start-output-text] details > summary")).toBeNull();
    expect(root.querySelector("[data-start-output-text]")?.textContent).not.toContain("questions");
    // 升级后的卡片留在滚动容器内部，渲染宿主本身不能被替换掉
    expect(root.querySelector("[data-start-output-body] [data-start-output-text]")).not.toBeNull();
  });

  it("keeps painting the run after a completed run upgraded the output", () => {
    const root = surface();
    prepareStartRunFeedback(root, "run-2a");
    paintStartRunEvent(root, delta(1, "第一次回答。"), "zh-CN");
    paintStartRunEvent(root, completed(2), "zh-CN");
    prepareStartRunFeedback(root, "run-2b");
    paintStartRunEvent(root, delta(3, "## 第二次标题"), "zh-CN");
    const output = root.querySelector<HTMLElement>("[data-start-output]")!;
    expect(output.hidden).toBe(false);
    expect(root.querySelector("[data-start-output-text] h3")?.textContent).toBe("第二次标题");
    expect(root.textContent).not.toContain("第一次回答。");
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

  it("releases the start page when a retryable run stops", () => {
    const root = surface();
    prepareStartRunFeedback(root, "run-7");
    setStartRunBusy(root, true);

    paintStartRunEvent(root, {
      id: 4,
      type: "run.stopped",
      data: { state: "retryable", stop_reason: "provider_unavailable" },
    }, "zh-CN");

    const form = root.querySelector<HTMLFormElement>("#start-run-form")!;
    expect(form.dataset.runBusy).toBe("false");
    expect(root.querySelector<HTMLButtonElement>("[data-start-submit]")!.disabled).toBe(false);
    expect(root.querySelector<HTMLButtonElement>("[data-start-cancel]")!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-run-status]")!.textContent)
      .toContain("任务已暂停");
  });
});
