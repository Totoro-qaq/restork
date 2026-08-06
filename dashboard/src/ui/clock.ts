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
  const timer = window.setInterval(update, reduced ? 60_000 : 1_000);
  cleanups.set(root, () => window.clearInterval(timer));
}
