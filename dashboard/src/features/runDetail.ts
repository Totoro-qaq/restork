import type { ConversationPage, DashboardApi, RunEventPage } from "../api/types";
import { tr, type Locale } from "../i18n";

export type RunDetailTab = "process" | "chat";

/** Mark the chosen run in the list and reset the detail pane for loading. */
export function prepareRunDetail(
  root: HTMLElement,
  detail: HTMLElement,
  button: HTMLButtonElement,
  locale: Locale,
): void {
  root.querySelectorAll<HTMLElement>("[data-run-list] [data-run-id]").forEach((item) => {
    if (item === button) item.setAttribute("aria-current", "true");
    else item.removeAttribute("aria-current");
  });
  detail.classList.remove("detail-placeholder");
  detail.textContent = tr(locale, "Reading local events and conversation…", "读取本地事件与对话…");
}

/** Load the first events page and, when supported, the first conversation page. */
export async function loadRunDetailFirstPage(
  api: DashboardApi,
  runId: string,
): Promise<{ firstPage: RunEventPage; firstConversation: ConversationPage | null }> {
  const [firstPage, firstConversation] = await Promise.all([
    api.eventPage
      ? api.eventPage(runId)
      : api.events(runId, 0).then((events) => ({
          events,
          page: { limit: 50, has_more: false, next_cursor: null },
        })),
    api.conversationPage
      ? api.conversationPage(runId).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { firstPage, firstConversation };
}

/** Wire the process/conversation tabs inside the run detail card. */
export function bindRunDetailTabs(detail: HTMLElement, onSwitch: (tab: RunDetailTab) => void): void {
  detail.querySelectorAll<HTMLButtonElement>("[data-rd-tab]").forEach((tabButton) => {
    tabButton.addEventListener("click", () => {
      const tab: RunDetailTab = tabButton.dataset.rdTab === "chat" ? "chat" : "process";
      detail.querySelectorAll<HTMLElement>("[data-rd-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.rdPanel !== tab;
      });
      detail.querySelectorAll<HTMLButtonElement>("[data-rd-tab]").forEach((peer) => {
        peer.setAttribute("aria-pressed", String(peer === tabButton));
      });
      onSwitch(tab);
    });
  });
}
