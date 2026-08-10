import type {
  DashboardApi,
  VaultNoteMetadataV2,
  VaultSearchHitV2,
} from "../api/types";
import { localeOf, tr } from "../i18n";
import { activeView, bindRovingFocus, escapeMarkup } from "../ui/dom";
import {
  errorText,
  vaultFileListMarkup,
  vaultNotePreviewMarkup,
} from "../ui/render";

const vaultStreams = new WeakMap<HTMLElement, AbortController>();
const vaultPreviewRequests = new WeakMap<HTMLElement, number>();
const vaultStates = new WeakMap<HTMLElement, {
  items: VaultNoteMetadataV2[];
  nextCursor: string | null;
  total: number;
  selectedPath: string | null;
  query: string;
}>();

/** Bind search and reset controls for the local, read-only Vault browser. */
export function configureVaultBrowser(root: HTMLElement, api: DashboardApi): void {
  const form = root.querySelector<HTMLFormElement>("#vault-search-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = String(new FormData(form).get("query") ?? "").trim();
    if (query) void searchVaultWorkspace(root, api, query);
  });
  root.querySelector<HTMLButtonElement>("[data-vault-clear]")?.addEventListener("click", () => {
    form?.reset();
    void loadVaultIndex(root, api);
  });
}

/** Load the granted Vault and start its bounded live-update stream. */
export async function openVaultWorkspace(root: HTMLElement, api: DashboardApi): Promise<void> {
  if (!api.listVaultNotes || !api.readVaultNote || !api.searchVaultNotes) {
    setVaultStatus(
      root,
      tr(
        localeOf(root),
        "This Core predates the Vault browser. Update and restart Restork.",
        "当前 Core 版本尚未提供 Vault 浏览器，请更新并重启 Restork。",
      ),
      "error",
    );
    return;
  }
  const configured = await loadVaultIndex(root, api);
  if (configured) startVaultStream(root, api);
}

/** Stop the active Vault stream when its view is replaced or hidden. */
export function stopVaultStream(root: HTMLElement): void {
  vaultStreams.get(root)?.abort();
  vaultStreams.delete(root);
}

async function loadVaultIndex(
  root: HTMLElement,
  api: DashboardApi,
  cursor?: string,
  append = false,
): Promise<boolean> {
  if (!api.listVaultNotes) return false;
  const browser = root.querySelector<HTMLElement>(".vault-browser");
  browser?.setAttribute("aria-busy", "true");
  setVaultStatus(
    root,
    append
      ? tr(localeOf(root), "Loading more local notes…", "正在加载更多本地笔记……")
      : tr(localeOf(root), "Reading the safe local file index…", "正在读取安全的本地文件索引……"),
    "loading",
  );
  try {
    const page = await api.listVaultNotes(cursor);
    const previous = vaultStates.get(root);
    const items = append ? [...(previous?.items ?? []), ...page.items] : page.items;
    const state = {
      items,
      nextCursor: page.page.next_cursor,
      total: page.total,
      selectedPath: previous?.selectedPath ?? null,
      query: "",
    };
    vaultStates.set(root, state);
    renderVaultFiles(root, api, items, page.total, page.page.has_more, "");
    const count = root.querySelector<HTMLElement>("#vault-file-count");
    if (count) count.textContent = String(page.total);
    browser?.setAttribute("aria-busy", "false");
    if (!page.configured) {
      setVaultStatus(
        root,
        tr(localeOf(root), "No Vault is configured. Choose one in Settings.", "尚未配置 Vault，请先在设置中选择知识库。"),
        "off",
      );
      return false;
    }
    setVaultStatus(
      root,
      tr(localeOf(root), `${page.total} notes ready · watching for changes`, `${page.total} 篇笔记已就绪 · 正在监听变化`),
      "live",
    );
    if (state.selectedPath && items.some((item) => item.relative_path === state.selectedPath)) {
      void readVaultPreview(root, api, state.selectedPath);
    }
    return true;
  } catch (error) {
    browser?.setAttribute("aria-busy", "false");
    setVaultStatus(root, errorText(error, localeOf(root)), "error");
    return false;
  }
}

async function searchVaultWorkspace(
  root: HTMLElement,
  api: DashboardApi,
  query: string,
): Promise<void> {
  if (!api.searchVaultNotes) return;
  const browser = root.querySelector<HTMLElement>(".vault-browser");
  browser?.setAttribute("aria-busy", "true");
  setVaultStatus(root, tr(localeOf(root), "Searching local Markdown…", "正在搜索本地 Markdown……"), "loading");
  try {
    const hits = await api.searchVaultNotes(query);
    const previous = vaultStates.get(root);
    vaultStates.set(root, {
      items: previous?.items ?? [],
      nextCursor: null,
      total: hits.length,
      selectedPath: previous?.selectedPath ?? null,
      query,
    });
    renderVaultFiles(root, api, hits, hits.length, false, query);
    const count = root.querySelector<HTMLElement>("#vault-file-count");
    if (count) count.textContent = String(hits.length);
    browser?.setAttribute("aria-busy", "false");
    setVaultStatus(
      root,
      tr(localeOf(root), `${hits.length} local matches · live updates remain on`, `${hits.length} 条本地结果 · 实时更新仍在运行`),
      "live",
    );
  } catch (error) {
    browser?.setAttribute("aria-busy", "false");
    setVaultStatus(root, errorText(error, localeOf(root)), "error");
  }
}

function renderVaultFiles(
  root: HTMLElement,
  api: DashboardApi,
  items: Array<VaultNoteMetadataV2 | VaultSearchHitV2>,
  total: number,
  hasMore: boolean,
  query: string,
): void {
  const host = root.querySelector<HTMLElement>("#vault-file-list");
  if (!host) return;
  host.innerHTML = vaultFileListMarkup(items, total, hasMore, localeOf(root), query);
  host.querySelectorAll<HTMLButtonElement>("[data-vault-path]").forEach((button) => {
    button.addEventListener("click", () => {
      const path = button.dataset.vaultPath;
      if (path) void readVaultPreview(root, api, path);
    });
  });
  host.querySelector<HTMLButtonElement>("[data-vault-load-more]")?.addEventListener(
    "click",
    () => {
      const state = vaultStates.get(root);
      if (state?.nextCursor) void loadVaultIndex(root, api, state.nextCursor, true);
    },
  );
  bindRovingFocus(host, "[data-vault-path]");
}

async function readVaultPreview(
  root: HTMLElement,
  api: DashboardApi,
  relativePath: string,
): Promise<void> {
  if (!api.readVaultNote) return;
  const preview = root.querySelector<HTMLElement>("#vault-preview");
  if (!preview) return;
  const requestNumber = (vaultPreviewRequests.get(root) ?? 0) + 1;
  vaultPreviewRequests.set(root, requestNumber);
  const state = vaultStates.get(root);
  if (state) state.selectedPath = relativePath;
  root.querySelectorAll<HTMLElement>("[data-vault-path]").forEach((row) => {
    row.classList.toggle("is-active", row.dataset.vaultPath === relativePath);
  });
  preview.setAttribute("aria-busy", "true");
  preview.innerHTML = `<div class="vault-preview-empty">
    <span class="agent-wait-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <h3>${tr(localeOf(root), "Reading the local note…", "正在读取本地笔记……")}</h3>
  </div>`;
  try {
    const note = await api.readVaultNote(relativePath);
    if (vaultPreviewRequests.get(root) !== requestNumber) return;
    preview.innerHTML = vaultNotePreviewMarkup(note, localeOf(root));
    preview.setAttribute("aria-busy", "false");
  } catch (error) {
    if (vaultPreviewRequests.get(root) !== requestNumber) return;
    preview.innerHTML = `<div class="vault-preview-empty">
      <span aria-hidden="true">!</span>
      <h3>${tr(localeOf(root), "Preview unavailable", "无法预览")}</h3>
      <p>${escapeMarkup(errorText(error, localeOf(root)))}</p>
    </div>`;
    preview.setAttribute("aria-busy", "false");
  }
}

function startVaultStream(root: HTMLElement, api: DashboardApi): void {
  if (!api.streamVaultEvents) {
    setVaultStatus(
      root,
      tr(localeOf(root), "Files are ready · use Refresh after external edits", "文件已就绪 · 外部修改后请手动刷新"),
      "off",
    );
    return;
  }
  stopVaultStream(root);
  const controller = new AbortController();
  vaultStreams.set(root, controller);
  void api.streamVaultEvents((event) => {
    if (controller.signal.aborted || activeView(root) !== "vault") return;
    if (event.type === "vault.ready") {
      setVaultStatus(root, tr(localeOf(root), "Live Vault updates connected", "Vault 实时更新已连接"), "live");
      return;
    }
    if (event.type === "vault.unavailable") {
      setVaultStatus(
        root,
        tr(localeOf(root), "Vault temporarily unavailable · reconnecting", "Vault 暂时不可用 · 正在重连"),
        "error",
      );
      return;
    }
    const changed = event.data.changed_count ?? 1;
    setVaultStatus(
      root,
      tr(localeOf(root), `${changed} note changes detected · updating`, `检测到 ${changed} 项笔记变化 · 正在更新`),
      "loading",
    );
    const state = vaultStates.get(root);
    const selectedPath = state?.selectedPath;
    void (async () => {
      if (state?.query) await searchVaultWorkspace(root, api, state.query);
      else await loadVaultIndex(root, api);
      if (state?.query && selectedPath && !(event.data.removed ?? []).includes(selectedPath)) {
        await readVaultPreview(root, api, selectedPath);
      }
    })();
  }, controller.signal).catch((error: unknown) => {
    if (controller.signal.aborted) return;
    setVaultStatus(
      root,
      tr(localeOf(root), `Live update stopped: ${errorText(error, localeOf(root))}`, `实时更新已停止：${errorText(error, localeOf(root))}`),
      "error",
    );
  });
}

function setVaultStatus(
  root: HTMLElement,
  message: string,
  state: "live" | "loading" | "off" | "error",
): void {
  const status = root.querySelector<HTMLElement>("#vault-live-status");
  if (status) status.textContent = message;
  const line = root.querySelector<HTMLElement>(".vault-live-line");
  if (line) line.dataset.state = state;
  const badge = root.querySelector<HTMLElement>("#vault-live-badge");
  if (badge) {
    badge.textContent = state === "live"
      ? tr(localeOf(root), "LIVE", "实时")
      : state === "loading"
        ? tr(localeOf(root), "SYNCING", "同步中")
        : state === "error"
          ? tr(localeOf(root), "RETRYING", "重试中")
          : tr(localeOf(root), "MANUAL", "手动");
  }
}
