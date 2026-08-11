import type { DashboardApi, DashboardSnapshot } from "../api/types";
import { localeOf, tr } from "../i18n";
import type { Locale } from "../i18n";
import { errorText } from "../ui/render";

export interface DailyEffects {
  error(message: string): void;
  refresh(): Promise<void>;
  renderRadar(): void;
  status(message: string): void;
}

export function configureWeather(root: HTMLElement, api: DashboardApi, effects: DailyEffects): void {
  bindSettingsDialog(root, "#weather-settings-dialog", "[data-weather-open]");
  const form = root.querySelector<HTMLFormElement>("#weather-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveWeather(root, api, effects, form);
  });
  form?.querySelector<HTMLButtonElement>("[data-weather-disable]")?.addEventListener(
    "click",
    () => void disableWeather(root, api, effects, form),
  );
  form?.querySelector<HTMLButtonElement>("[data-weather-locate]")?.addEventListener(
    "click",
    () => void locateWeather(root, api, effects, form),
  );
}

export function bindRadarConfig(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  effects: DailyEffects,
): void {
  const form = root.querySelector<HTMLFormElement>("#radar-config-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveRadarConfig(root, api, snapshot, effects, form);
  });
}

async function saveRadarConfig(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  effects: DailyEffects,
  form: HTMLFormElement,
): Promise<void> {
  const data = new FormData(form);
  const githubDiscovery = data.get("github_discovery") === "1";
  const hackerNews = data.get("hacker_news") === "1";
  const status = form.querySelector<HTMLElement>("#radar-config-status");
  if (!githubDiscovery && !hackerNews) {
    if (status) {
      status.textContent = tr(
        localeOf(root),
        "Enable at least one source: public GitHub AI/Agent projects or Hacker News.",
        "至少启用一个来源：GitHub 公开 AI/Agent 项目或 Hacker News。",
      );
    }
    return;
  }
  if (status) status.textContent = tr(localeOf(root), "Saving sources and fetching…", "正在保存来源并拉取…");
  try {
    await api.configureRadar({
      enabled: true,
      github_discovery: githubDiscovery,
      hacker_news: hackerNews,
    });
    await refreshRadarPanel(root, api, snapshot, effects);
    effects.status(tr(localeOf(root), "Radar sources saved.", "Radar 来源已保存。"));
  } catch (error) {
    if (status) status.textContent = errorText(error, localeOf(root));
  }
}

export async function refreshRadarPanel(
  root: HTMLElement,
  api: DashboardApi,
  snapshot: DashboardSnapshot,
  effects: DailyEffects,
): Promise<void> {
  if (!api.loadPage) return;
  const panel = root.querySelector<HTMLElement>('[data-view-panel="radar"]');
  if (!panel || panel.dataset.loading === "true") return;
  panel.dataset.loading = "true";
  panel.setAttribute("aria-busy", "true");
  try {
    const page = await api.loadPage("radar", "");
    if (page.kind !== "radar") return;
    snapshot.radar = {
      configured: page.configured,
      items: page.items,
    };
    snapshot.pagination ??= {};
    snapshot.pagination.radar = page.page;
    effects.renderRadar();
  } catch (error) {
    effects.error(errorText(error, localeOf(root)));
  } finally {
    panel.dataset.loading = "false";
    panel.removeAttribute("aria-busy");
  }
}

async function saveWeather(
  root: HTMLElement,
  api: DashboardApi,
  effects: DailyEffects,
  form: HTMLFormElement,
): Promise<void> {
  const data = new FormData(form);
  const query = String(data.get("query") ?? "").trim();
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api.configureWeather({
      enabled: true,
      mode: "query",
      query,
      language: localeOf(root) === "zh-CN" ? "zh" : "en",
    });
    form.reset();
    await effects.refresh();
    effects.status(tr(
      localeOf(root),
      `Weather enabled for ${result.location_label}.`,
      `已为 ${result.location_label} 启用天气。`,
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    effects.error(errorText(error, localeOf(root)));
  }
}

async function locateWeather(
  root: HTMLElement,
  api: DashboardApi,
  effects: DailyEffects,
  form: HTMLFormElement,
): Promise<void> {
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  effects.status(tr(
    localeOf(root),
    "Waiting for browser location permission…",
    "正在等待浏览器定位授权…",
  ));
  try {
    const position = await currentPosition();
    await api.configureWeather({
      enabled: true,
      mode: "coordinates",
      label: tr(localeOf(root), "Current location", "当前位置"),
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    });
    form.reset();
    await effects.refresh();
    effects.status(tr(
      localeOf(root),
      "Weather enabled from the location you approved.",
      "已使用你授权的位置启用天气。",
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    effects.error(geolocationError(error, localeOf(root)));
  }
}

async function disableWeather(
  root: HTMLElement,
  api: DashboardApi,
  effects: DailyEffects,
  form: HTMLFormElement,
): Promise<void> {
  const buttons = form.querySelectorAll<HTMLButtonElement>("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await api.configureWeather({ enabled: false });
    form.reset();
    await effects.refresh();
    effects.status(tr(
      localeOf(root),
      "Weather disabled and its saved location cleared.",
      "天气已停用，保存的位置也已清除。",
    ));
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    effects.error(errorText(error, localeOf(root)));
  }
}

function bindSettingsDialog(
  root: HTMLElement,
  dialogSelector: string,
  triggerSelector: string,
): void {
  const dialog = root.querySelector<HTMLDialogElement>(dialogSelector);
  const trigger = root.querySelector<HTMLButtonElement>(triggerSelector);
  trigger?.addEventListener("click", () => {
    if (dialog && !dialog.open) dialog.showModal();
  });
  dialog?.querySelector<HTMLButtonElement>("[data-settings-close]")?.addEventListener(
    "click",
    () => dialog.close(),
  );
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Browser location is unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      maximumAge: 10 * 60 * 1000,
      timeout: 15_000,
    });
  });
}

function geolocationError(error: unknown, locale: Locale): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? Number((error as { code: unknown }).code)
    : 0;
  if (code === 1) {
    return tr(
      locale,
      "Location permission was not granted. You can still enter a city.",
      "未授予定位权限，你仍可直接输入城市。",
    );
  }
  return tr(
    locale,
    "Current location is unavailable. You can still enter a city.",
    "无法获取当前位置，你仍可直接输入城市。",
  );
}
