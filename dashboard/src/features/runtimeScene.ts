const sceneCleanups = new WeakMap<HTMLElement, () => void>();

function elapsedCopy(startedAt: number, now = Date.now()): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Binds the active runtime scene to the existing start-page cancel control.
 * The original cancel button and Core call remain the source of truth; this
 * module only mirrors that action inside the visible progress scene.
 */
export function configureRuntimeScene(root: HTMLElement): () => void {
  sceneCleanups.get(root)?.();

  const waitHost = root.querySelector<HTMLElement>("[data-run-wait]");
  const cancel = root.querySelector<HTMLButtonElement>("[data-start-cancel]");
  if (!waitHost || !cancel) return () => undefined;

  let interval: number | null = null;
  let active = false;

  const stopTimer = (): void => {
    if (interval != null) window.clearInterval(interval);
    interval = null;
  };
  const paintElapsed = (): void => {
    const raw = Number(waitHost.dataset.runtimeStartedAt);
    const startedAt = Number.isFinite(raw) && raw > 0 ? raw : Date.now();
    if (!waitHost.dataset.runtimeStartedAt) {
      waitHost.dataset.runtimeStartedAt = String(startedAt);
    }
    waitHost.querySelectorAll<HTMLElement>("[data-runtime-elapsed]").forEach((node) => {
      node.textContent = elapsedCopy(startedAt);
    });
  };
  const sync = (): void => {
    const scene = waitHost.querySelector<HTMLElement>(
      '[data-runtime-scene][data-runtime-active="true"]',
    );
    const inlineStop = scene?.querySelector<HTMLButtonElement>("[data-runtime-stop]") ?? null;
    active = Boolean(scene);
    if (active) {
      cancel.hidden = true;
      if (inlineStop) {
        inlineStop.disabled = cancel.disabled;
        inlineStop.setAttribute("aria-disabled", String(cancel.disabled));
      }
      paintElapsed();
      if (interval == null) interval = window.setInterval(paintElapsed, 1_000);
    } else {
      stopTimer();
      delete waitHost.dataset.runtimeStartedAt;
    }
  };
  const observer = new MutationObserver(sync);
  observer.observe(waitHost, { childList: true, subtree: true });
  observer.observe(cancel, { attributes: true, attributeFilter: ["disabled", "hidden"] });
  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const inlineStop = target.closest<HTMLButtonElement>("[data-runtime-stop]");
    if (!inlineStop || !waitHost.contains(inlineStop) || inlineStop.disabled) return;
    cancel.click();
    sync();
  };
  waitHost.addEventListener("click", onClick);
  sync();

  const cleanup = (): void => {
    observer.disconnect();
    stopTimer();
    waitHost.removeEventListener("click", onClick);
    if (active && cancel.isConnected) cancel.hidden = false;
    sceneCleanups.delete(root);
  };
  sceneCleanups.set(root, cleanup);
  return cleanup;
}

