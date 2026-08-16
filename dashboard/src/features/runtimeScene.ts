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
    if (interval != null && typeof window !== "undefined") window.clearInterval(interval);
    interval = null;
  };
  const paintElapsed = (): void => {
    const raw = Number(waitHost.dataset.runtimeStartedAt);
    const startedAt = Number.isFinite(raw) && raw > 0 ? raw : Date.now();
    if (!waitHost.dataset.runtimeStartedAt) {
      waitHost.dataset.runtimeStartedAt = String(startedAt);
    }
    waitHost.querySelectorAll<HTMLElement>("[data-runtime-elapsed]").forEach((node) => {
      const next = elapsedCopy(startedAt);
      // The observer watches the scene's child list so that it can follow a
      // newly rendered run. Replacing an unchanged text node would otherwise
      // feed that observation straight back into `sync`.
      if (node.textContent !== next) node.textContent = next;
    });
  };
  const sync = (): void => {
    const scene = waitHost.querySelector<HTMLElement>(
      '[data-runtime-scene][data-runtime-active="true"]',
    );
    const inlineStop = scene?.querySelector<HTMLButtonElement>("[data-runtime-stop]") ?? null;
    active = Boolean(scene);
    if (active) {
      // Only write when the visible state changes. Some WebViews still queue
      // an attribute mutation when a boolean DOM property is assigned its
      // current value.
      if (!cancel.hidden) cancel.hidden = true;
      if (inlineStop) {
        inlineStop.disabled = cancel.disabled;
        inlineStop.setAttribute("aria-disabled", String(cancel.disabled));
      }
      paintElapsed();
      if (interval == null && root.isConnected && waitHost.isConnected) {
        interval = window.setInterval(() => {
          // A queued tick may run after the test environment tore down jsdom.
          if (typeof window === "undefined") {
            interval = null;
            return;
          }
          if (!root.isConnected || !waitHost.isConnected) {
            sceneCleanups.get(root)?.();
            return;
          }
          paintElapsed();
        }, 1_000);
      }
    } else {
      stopTimer();
      delete waitHost.dataset.runtimeStartedAt;
    }
  };
  const observer = new MutationObserver(() => {
    if (!root.isConnected || !waitHost.isConnected || !cancel.isConnected) {
      cleanup();
      return;
    }
    sync();
  });
  // Run rendering replaces the direct contents of the wait host. Watching its
  // descendants would also observe elapsed-time text updates owned here.
  observer.observe(waitHost, { childList: true });
  // The scene owns the original button's `hidden` state, so observing that
  // attribute would feed our own write back into `sync`. We only need to
  // mirror disabled/enabled changes made by the existing cancel flow.
  observer.observe(cancel, { attributes: true, attributeFilter: ["disabled"] });
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
    if (sceneCleanups.get(root) === cleanup) sceneCleanups.delete(root);
  };
  sceneCleanups.set(root, cleanup);
  return cleanup;
}
