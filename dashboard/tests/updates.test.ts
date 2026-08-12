import { describe, expect, it, vi } from "vitest";

import type { DesktopBridge, DesktopUpdateStatus } from "../src/desktop";
import { configureUpdates } from "../src/features/updates";

const available: DesktopUpdateStatus = {
  phase: "available",
  currentVersion: "0.1.2",
  availableVersion: "0.1.3",
  owner: "restork",
  installSource: "website_dmg",
  canSelfUpdate: true,
  preferences: { channel: "stable", automaticChecks: true },
  notificationDismissed: false,
};

function fixture(): HTMLElement {
  const root = document.createElement("main");
  root.lang = "zh-CN";
  root.innerHTML = `
    <aside data-update-notice hidden>
      <span data-update-notice-copy></span>
      <button data-update-notice-open>查看更新</button>
      <button data-update-notice-dismiss>本版本不再提醒</button>
    </aside>
    <section data-desktop-updates>
      <span data-update-current></span><p data-update-owner></p>
      <select name="update_channel"><option value="stable">stable</option></select>
      <input name="automatic_checks" type="checkbox">
      <button data-update-check></button><button data-update-download hidden></button>
      <button data-update-cancel hidden></button><div data-update-schedule-actions hidden></div>
      <progress data-update-progress max="100" value="0" hidden></progress>
      <p data-update-message></p>
    </section>`;
  return root;
}

describe("desktop update notice", () => {
  it("shows a new version globally and keeps dismissal scoped to that version", async () => {
    const root = fixture();
    const dismissUpdate = vi.fn(async () => ({ ...available, notificationDismissed: true }));
    const bridge = {
      updateStatus: vi.fn(async () => available),
      dismissUpdate,
      subscribeUpdates: vi.fn(async () => () => undefined),
    } as unknown as DesktopBridge;

    configureUpdates(root, bridge);
    await vi.waitFor(() => {
      expect(root.querySelector<HTMLElement>("[data-update-notice]")?.hidden).toBe(false);
    });
    expect(root.querySelector("[data-update-notice-copy]")?.textContent).toContain("v0.1.3");

    root.querySelector<HTMLButtonElement>("[data-update-notice-dismiss]")?.click();
    await vi.waitFor(() => expect(dismissUpdate).toHaveBeenCalledWith("0.1.3"));
    await vi.waitFor(() => {
      expect(root.querySelector<HTMLElement>("[data-update-notice]")?.hidden).toBe(true);
    });
  });
});
