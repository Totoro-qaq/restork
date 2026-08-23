/**
 * The daily music panel: source configuration, playlist refresh and the
 * optional online research pass. Owned here so `main.ts` stays a composition
 * root rather than a feature dumping ground.
 */
import type { DashboardApi } from "../api/types";
import type { Locale } from "../i18n";
import { localeOf, tr } from "../i18n";
import { bindSettingsDialog } from "../ui/dom";
import { announceError, announceStatus } from "../ui/notices";
import { errorText } from "../ui/render";

/**
 * Repainting the workspace belongs to the composition root; the panel only
 * asks for it once a local change has been stored.
 */
export type RefreshWorkspace = (root: HTMLElement, api: DashboardApi) => Promise<void>;

const coverUrls = new WeakMap<HTMLElement, string>();

export function configureMusic(
  root: HTMLElement,
  api: DashboardApi,
  refresh: RefreshWorkspace,
): void {
  bindSettingsDialog(root, "#music-settings-dialog", "[data-music-open]");
  const form = root.querySelector<HTMLFormElement>("#music-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void syncMusicSource(root, api, form, refresh);
  });
  form?.querySelector<HTMLSelectElement>("#music-source")?.addEventListener(
    "change",
    () => updateMusicSourceHelp(root, form),
  );
  if (form) updateMusicSourceHelp(root, form);
  form?.querySelector<HTMLButtonElement>("[data-music-file]")?.addEventListener(
    "click",
    () => void saveMusicFile(root, api, form, refresh),
  );
  form?.querySelector<HTMLButtonElement>("[data-music-refresh]")?.addEventListener(
    "click",
    () => void refreshMusic(root, api, form, refresh),
  );
  form?.querySelector<HTMLButtonElement>("[data-music-disable]")?.addEventListener(
    "click",
    () => void disableMusic(root, api, form, refresh),
  );
  root.querySelector<HTMLButtonElement>("[data-music-research]")?.addEventListener(
    "click",
    (event) => void researchMusic(
      root,
      api,
      event.currentTarget as HTMLButtonElement,
      refresh,
    ),
  );
  const button = root.querySelector<HTMLButtonElement>("[data-music-toggle]");
  const disc = root.querySelector<HTMLElement>("[data-music-disc]");
  if (!button || !disc) return;
  button.addEventListener("click", () => {
    const playing = disc.classList.toggle("is-playing");
    button.setAttribute("aria-pressed", String(playing));
    button.textContent = playing
      ? tr(localeOf(root), "Pause CD", "暂停唱片")
      : tr(localeOf(root), "Rotate CD", "转动唱片");
  });
}

function updateMusicSourceHelp(root: HTMLElement, form: HTMLFormElement): void {
  const select = form.querySelector<HTMLSelectElement>("#music-source");
  const target = form.querySelector<HTMLElement>("[data-music-source-help]");
  const option = select?.selectedOptions[0];
  if (!select || !target || !option) return;
  const source = select.value;
  target.textContent = source === "apple-music"
    ? option.dataset.status === "ready"
      ? tr(localeOf(root), "Official Apple Music API credential is ready.", "Apple Music 官方 API 凭据已就绪。")
      : tr(
        localeOf(root),
        `Native setup required: ${option.dataset.setup || "restorkd music apple configure"}`,
        `需要先配置系统凭据：${option.dataset.setup || "restorkd music apple configure"}`,
      )
    : tr(localeOf(root), "Experimental, credential-free and read-only; only public playlist metadata is read.", "实验性、无需凭据且只读；仅获取公开歌单元数据。");
}

async function syncMusicSource(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
  refresh: RefreshWorkspace,
): Promise<void> {
  if (!api.configureMusic) return;
  const data = new FormData(form);
  const shareUrl = String(data.get("share_url") ?? "").trim();
  const source = String(data.get("source") ?? "qqmusic");
  try {
    if (!(["qqmusic", "netease", "apple-music"] as string[]).includes(source)) {
      throw new Error(tr(localeOf(root), "Choose a supported music source.", "请选择受支持的音乐来源。"));
    }
    const selected = form.querySelector<HTMLSelectElement>("#music-source")?.selectedOptions[0];
    if (source === "apple-music" && selected?.dataset.status !== "ready") {
      const command = selected?.dataset.setup || "restorkd music apple configure";
      throw new Error(tr(
        localeOf(root),
        `Configure the Apple Music developer token in native credential storage first: ${command}`,
        `请先把 Apple Music developer token 配置到系统凭据库：${command}`,
      ));
    }
    const parsed = new URL(shareUrl);
    const hosts: Record<string, string[]> = {
      qqmusic: ["i2.y.qq.com", "y.qq.com", "www.y.qq.com"],
      netease: ["music.163.com", "www.music.163.com", "y.music.163.com"],
      "apple-music": ["music.apple.com"],
    };
    if (parsed.protocol !== "https:" || !hosts[source].includes(parsed.hostname)) {
      throw new Error(tr(
        localeOf(root),
        "Paste an HTTPS playlist link from the selected source.",
        "请粘贴来自所选来源的 HTTPS 歌单链接。",
      ));
    }
    setMusicBusy(form, true, tr(
      localeOf(root),
      source === "qqmusic"
        ? "Syncing the private snapshot and checking current Cantonese chart candidates…"
        : "Syncing and validating a private local playlist snapshot…",
      source === "qqmusic"
        ? "正在同步私有快照，并检查当前粤语榜单候选……"
        : "正在同步并校验本地私有歌单快照……",
    ));
    await api.configureMusic({
      enabled: true,
      source: source as "qqmusic" | "netease" | "apple-music",
      share_url: shareUrl,
      local_date: localDate(),
    });
    form.reset();
    await refresh(root, api);
    announceStatus(root, tr(
      localeOf(root),
      source === "qqmusic"
        ? "QQ Music connected. Daily analysis and current chart discoveries are ready."
        : "Music source connected. The private daily snapshot is ready.",
      source === "qqmusic"
        ? "QQ 音乐已连接，今日分析和当前榜单发现已经就绪。"
        : "音乐来源已连接，私有每日快照已经就绪。",
    ));
  } catch (error) {
    setMusicBusy(form, false, errorText(error, localeOf(root)));
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function saveMusicFile(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
  refresh: RefreshWorkspace,
): Promise<void> {
  const file = form.querySelector<HTMLInputElement>('input[type="file"]')?.files?.[0];
  if (!file || !api.configureMusic) return;
  try {
    if (!/\.(json|csv)$/i.test(file.name) || file.size > 2_000_000) {
      throw new Error(tr(
        localeOf(root),
        "Select a JSON or CSV playlist no larger than 2 MB.",
        "请选择不超过 2 MB 的 JSON 或 CSV 歌单。",
      ));
    }
    setMusicBusy(form, true, tr(
      localeOf(root),
      "Importing the local private snapshot…",
      "正在导入本地私有快照……",
    ));
    await api.configureMusic({
      enabled: true,
      source: "file",
      filename: file.name,
      content: await file.text(),
      local_date: localDate(),
    });
    form.reset();
    await refresh(root, api);
    announceStatus(root, tr(
      localeOf(root),
      "Private playlist imported. Today's track is ready.",
      "私有歌单已导入，今日推荐已就绪。",
    ));
  } catch (error) {
    setMusicBusy(form, false, errorText(error, localeOf(root)));
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function refreshMusic(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
  refresh: RefreshWorkspace,
): Promise<void> {
  if (!api.refreshMusic) return;
  try {
    setMusicBusy(form, true, tr(
      localeOf(root),
      "Refreshing the playlist, song details, and Cantonese chart evidence…",
      "正在刷新歌单、歌曲资料和粤语榜单信息……",
    ));
    await api.refreshMusic(localDate());
    await refresh(root, api);
    announceStatus(root, tr(
      localeOf(root),
      "Music snapshot refreshed. Your previous snapshot would have been kept on failure.",
      "音乐快照已刷新；如果刷新失败，旧快照会继续保留。",
    ));
  } catch (error) {
    setMusicBusy(form, false, errorText(error, localeOf(root)));
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function disableMusic(
  root: HTMLElement,
  api: DashboardApi,
  form: HTMLFormElement,
  refresh: RefreshWorkspace,
): Promise<void> {
  if (!api.configureMusic) return;
  try {
    setMusicBusy(form, true, tr(
      localeOf(root),
      "Disconnecting and deleting only Restork's managed copy…",
      "正在断开连接，并仅删除 Restork 管理的副本……",
    ));
    await api.configureMusic({ enabled: false, local_date: localDate() });
    form.reset();
    await refresh(root, api);
    announceStatus(root, tr(
      localeOf(root),
      "Daily track disabled and the imported playlist deleted.",
      "每日一曲已停用，导入的歌单也已删除。",
    ));
  } catch (error) {
    setMusicBusy(form, false, errorText(error, localeOf(root)));
    announceError(root, errorText(error, localeOf(root)));
  }
}

async function researchMusic(
  root: HTMLElement,
  api: DashboardApi,
  button: HTMLButtonElement,
  refresh: RefreshWorkspace,
): Promise<void> {
  if (!api.researchMusic) return;
  const original = button.textContent ?? "";
  const status = root.querySelector<HTMLElement>("#music-research-consent");
  button.disabled = true;
  button.classList.add("is-busy");
  button.setAttribute("aria-busy", "true");
  button.textContent = tr(localeOf(root), "SEARCHING SOURCES…", "正在检索来源……");
  if (status) {
    status.classList.add("is-busy");
    status.textContent = tr(
      localeOf(root),
      "V4 Flash is searching, cross-checking and preparing bilingual notes…",
      "V4 Flash 正在检索、交叉核验并生成双语解读……",
    );
  }
  try {
    await api.researchMusic(localDate());
    await refresh(root, api);
    announceStatus(root, tr(
      localeOf(root),
      "Online song research completed and its sources were cached locally.",
      "歌曲联网分析已完成，来源与结果已缓存在本地。",
    ));
  } catch (error) {
    const message = musicResearchErrorText(error, localeOf(root));
    if (root.contains(button)) {
      button.disabled = false;
      button.classList.remove("is-busy");
      button.removeAttribute("aria-busy");
      button.textContent = original;
    }
    if (status && root.contains(status)) {
      status.classList.remove("is-busy");
      status.textContent = message;
    }
    announceError(root, message);
  }
}

function musicResearchErrorText(error: unknown, locale: Locale): string {
  const detail = error instanceof Error ? error.message : errorText(error, locale);
  const match = /song web research failed:\s*([a-z_]+)/i.exec(detail);
  if (!match) return detail;
  const messages: Record<string, [string, string]> = {
    timeout: [
      "Online analysis exceeded the 180-second limit. The previous result is still shown; retry when ready.",
      "联网分析超过 180 秒；仍显示上次结果，你可以稍后手动重试。",
    ],
    invalid_response: [
      "The model returned an unreadable result. The previous result is still shown; retry when ready.",
      "模型返回的结果无法读取；仍显示上次结果，你可以稍后手动重试。",
    ],
    provider_unavailable: [
      "The model service is temporarily unavailable. The previous result is still shown.",
      "模型服务暂时不可用；仍显示上次结果。",
    ],
    sources_missing: [
      "The search finished without public sources that could be verified. The previous result is still shown.",
      "联网检索没有找到能够核对的公开来源；仍显示上次结果。",
    ],
    structured_output_invalid: [
      "The researched result was incomplete. The previous result is still shown.",
      "联网分析结果不完整；仍显示上次结果。",
    ],
  };
  const copy = messages[match[1].toLowerCase()];
  return copy ? tr(locale, copy[0], copy[1]) : tr(
    locale,
    "Online analysis failed. The previous result is still shown; retry when ready.",
    "联网分析未完成；仍显示上次结果，你可以稍后手动重试。",
  );
}

function setMusicBusy(form: HTMLFormElement, busy: boolean, message: string): void {
  form.setAttribute("aria-busy", String(busy));
  form.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = busy;
  });
  const status = form.querySelector<HTMLElement>("[data-music-sync-status]");
  if (status) {
    status.textContent = message;
    status.classList.toggle("is-busy", busy);
  }
}

function localDate(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function loadMusicCover(root: HTMLElement, api: DashboardApi): Promise<void> {
  try {
    const blob = await api.musicCover();
    const image = root.querySelector<HTMLImageElement>("#music-cover");
    if (!blob || !image || typeof URL.createObjectURL !== "function") return;
    releaseCover(root);
    const url = URL.createObjectURL(blob);
    coverUrls.set(root, url);
    image.addEventListener("error", () => {
      image.hidden = true;
      releaseCover(root);
    }, { once: true });
    image.src = url;
    image.hidden = false;
  } catch (error) {
    announceError(root, errorText(error, localeOf(root)));
  }
}

export function releaseCover(root: HTMLElement): void {
  const previous = coverUrls.get(root);
  if (previous) URL.revokeObjectURL(previous);
  coverUrls.delete(root);
}
