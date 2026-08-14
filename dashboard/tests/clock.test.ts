import { afterEach, describe, expect, it, vi } from "vitest";

import { startClock } from "../src/ui/clock";

function clockRoot(): HTMLElement {
  const root = document.createElement("main");
  root.innerHTML = `<svg>
      <line data-clock-hour></line>
      <line data-clock-minute></line>
      <line data-clock-second></line>
    </svg>
    <time id="clock-text"></time>`;
  return root;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("dashboard clock", () => {
  it("does not start a background timer for a detached render", () => {
    vi.useFakeTimers();
    startClock(clockRoot());

    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops scheduling after its workspace is removed", () => {
    vi.useFakeTimers();
    const root = clockRoot();
    document.body.append(root);
    startClock(root);
    expect(vi.getTimerCount()).toBe(1);

    root.remove();
    vi.advanceTimersByTime(1_000);

    expect(vi.getTimerCount()).toBe(0);
  });
});
