import type { ConversationPage, DashboardApi, RunEventPage } from "../api/types";
import { tr, type Locale } from "../i18n";

export type RunDetailTab = "result" | "process" | "chat";

const boundScrollDetails = new WeakSet<HTMLElement>();

/** Keep the cyber run-detail rail visible and in sync with the native scroller. */
export function syncRunDetailScrollbar(detail: HTMLElement): void {
  const shell = detail.closest<HTMLElement>(".run-detail-shell");
  const rail = shell?.querySelector<HTMLElement>("[data-run-detail-scrollbar]");
  const thumb = rail?.querySelector<HTMLElement>("[data-run-detail-scroll-thumb]");
  if (!rail || !thumb) return;
  const maxScroll = Math.max(0, detail.scrollHeight - detail.clientHeight);
  rail.hidden = maxScroll < 2;
  if (rail.hidden) return;
  const railHeight = rail.clientHeight || Math.max(1, detail.clientHeight - 16);
  const thumbHeight = Math.max(52, Math.round(railHeight * detail.clientHeight / detail.scrollHeight));
  const travel = Math.max(0, railHeight - thumbHeight);
  const progress = maxScroll ? Math.min(1, Math.max(0, detail.scrollTop / maxScroll)) : 0;
  thumb.style.height = `${Math.min(railHeight, thumbHeight)}px`;
  thumb.style.transform = `translate3d(0, ${Math.round(travel * progress)}px, 0)`;
}

/** Bind once; native wheel/keyboard scrolling remains the source of truth. */
export function bindRunDetailScrollbar(detail: HTMLElement): void {
  if (boundScrollDetails.has(detail)) {
    syncRunDetailScrollbar(detail);
    return;
  }
  const shell = detail.closest<HTMLElement>(".run-detail-shell");
  const rail = shell?.querySelector<HTMLElement>("[data-run-detail-scrollbar]");
  const thumb = rail?.querySelector<HTMLElement>("[data-run-detail-scroll-thumb]");
  if (!rail || !thumb) return;
  boundScrollDetails.add(detail);
  let frame = 0;
  const schedule = (): void => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      syncRunDetailScrollbar(detail);
    });
  };
  detail.addEventListener("scroll", schedule, { passive: true });
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  resize?.observe(detail);
  const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
  mutation?.observe(detail, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "open"] });

  let dragStartY = 0;
  let dragStartScroll = 0;
  const drag = (event: PointerEvent): void => {
    if (!thumb.hasPointerCapture(event.pointerId)) return;
    const maxScroll = Math.max(0, detail.scrollHeight - detail.clientHeight);
    const travel = Math.max(1, rail.clientHeight - thumb.offsetHeight);
    detail.scrollTop = dragStartScroll + (event.clientY - dragStartY) / travel * maxScroll;
  };
  thumb.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragStartY = event.clientY;
    dragStartScroll = detail.scrollTop;
    thumb.setPointerCapture(event.pointerId);
  });
  thumb.addEventListener("pointermove", drag);
  rail.addEventListener("pointerdown", (event) => {
    if (event.target === thumb) return;
    const bounds = rail.getBoundingClientRect();
    const maxScroll = Math.max(0, detail.scrollHeight - detail.clientHeight);
    const travel = Math.max(1, rail.clientHeight - thumb.offsetHeight);
    const target = Math.min(travel, Math.max(0, event.clientY - bounds.top - thumb.offsetHeight / 2));
    detail.scrollTop = target / travel * maxScroll;
  });
  schedule();
}

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
  detail.scrollTop = 0;
  syncRunDetailScrollbar(detail);
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
      const tab: RunDetailTab = tabButton.dataset.rdTab === "result"
        ? "result"
        : tabButton.dataset.rdTab === "chat"
          ? "chat"
          : "process";
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
