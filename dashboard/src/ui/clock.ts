import { localeOf } from "../i18n";

const cleanups = new WeakMap<HTMLElement, () => void>();

export function startClock(root: HTMLElement): void {
  cleanups.get(root)?.();
  const hour = root.querySelector<SVGElement>("[data-clock-hour]");
  const minute = root.querySelector<SVGElement>("[data-clock-minute]");
  const second = root.querySelector<SVGElement>("[data-clock-second]");
  const text = root.querySelector<HTMLTimeElement>("#clock-text");
  if (!hour || !minute || !second || !text) return;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  // Read the active locale rather than hardcoding one: an English user was
  // shown a Chinese-formatted date under the clock.
  const formatter = new Intl.DateTimeFormat(localeOf(root), {
    dateStyle: "full",
    timeStyle: "medium",
  });

  const update = (): void => {
    const now = new Date();
    const seconds = now.getSeconds();
    const minutes = now.getMinutes() + seconds / 60;
    const hours = (now.getHours() % 12) + minutes / 60;
    hour.setAttribute("transform", `rotate(${hours * 30} 50 50)`);
    minute.setAttribute("transform", `rotate(${minutes * 6} 50 50)`);
    second.setAttribute("transform", `rotate(${seconds * 6} 50 50)`);
    text.dateTime = now.toISOString();
    text.textContent = formatter.format(now);
  };
  update();
  // A workspace render replaces the clock, and tests frequently remove the
  // whole root. A repeating interval would keep updating detached elements and
  // keep the test worker alive. Schedule one tick at a time so a detached root
  // tears itself down instead of leaving an open handle behind.
  let timer: number | null = null;
  let disposed = false;
  const stop = (): void => {
    disposed = true;
    if (timer != null && typeof window !== "undefined") window.clearTimeout(timer);
    timer = null;
    if (cleanups.get(root) === stop) cleanups.delete(root);
  };
  const tick = (): void => {
    // Vitest can tear down the jsdom global while a tick is still queued on
    // the worker's event loop; touching `window` then throws ReferenceError.
    if (typeof window === "undefined") {
      disposed = true;
      timer = null;
      return;
    }
    if (disposed || !root.isConnected) {
      stop();
      return;
    }
    update();
    timer = window.setTimeout(tick, reduced ? 60_000 : 1_000);
  };
  cleanups.set(root, stop);
  if (root.isConnected) timer = window.setTimeout(tick, reduced ? 60_000 : 1_000);
}
