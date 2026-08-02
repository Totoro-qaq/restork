const detail = document.querySelector("#loader-detail");
const actions = document.querySelector("#loader-actions");
const retry = document.querySelector("#retry");
const quit = document.querySelector("#quit");

function invoke(command, args) {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) return Promise.reject(new Error("native_bridge_unavailable"));
  return tauri.core.invoke(command, args);
}

async function refreshStatus() {
  try {
    const status = await invoke("desktop_status");
    if (status.phase === "failed") {
      detail.textContent = status.message || "Restork Core could not start.";
      actions.hidden = false;
      return;
    }
    detail.textContent = status.message || "Preparing the private local workspace…";
    window.setTimeout(refreshStatus, 250);
  } catch {
    detail.textContent = "The native supervisor is unavailable.";
    actions.hidden = false;
  }
}

retry?.addEventListener("click", async () => {
  actions.hidden = true;
  detail.textContent = "Retrying with a new private local port…";
  try {
    await invoke("desktop_retry");
    window.setTimeout(refreshStatus, 100);
  } catch {
    detail.textContent = "Restork Core could not be restarted.";
    actions.hidden = false;
  }
});

quit?.addEventListener("click", () => void invoke("desktop_quit"));
void refreshStatus();
