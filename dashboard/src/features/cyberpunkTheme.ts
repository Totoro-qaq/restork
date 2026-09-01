/**
 * GSAP is loaded on demand. It is only ever needed by this theme, so a static
 * import would put roughly 70 KB of timeline engine in the bundle every reader
 * downloads, including the ones who never leave the light theme.
 */
type GsapApi = typeof import("gsap")["gsap"];
type CyberMatchMedia = ReturnType<GsapApi["matchMedia"]>;

let motion: GsapApi | null = null;
let bootSeenThisPage = false;

async function loadMotion(): Promise<GsapApi> {
  motion ??= (await import("gsap")).gsap;
  return motion;
}

export type CyberChannel = "neon" | "magenta" | "acid";
export type CyberFxLevel = "full" | "lite" | "off";

const CHANNEL_KEY = "restork.cyber.channel.v1";
const FX_KEY = "restork.cyber.fx.v1";
const CHANNELS = new Set<CyberChannel>(["neon", "magenta", "acid"]);
const FX_LEVELS = new Set<CyberFxLevel>(["full", "lite", "off"]);

function stored<T extends string>(key: string, allowed: Set<T>, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key) as T | null;
    return value && allowed.has(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Appearance remains usable for the current session when storage is blocked.
  }
}

export function applyCyberpunkPreferences(): { channel: CyberChannel; fx: CyberFxLevel } {
  const channel = stored(CHANNEL_KEY, CHANNELS, "neon");
  const fx = stored(FX_KEY, FX_LEVELS, "full");
  document.documentElement.dataset.cyberChannel = channel;
  document.documentElement.dataset.cyberFx = fx;
  return { channel, fx };
}

function fxMarkup(): string {
  return `<div class="cyber-fx cyber-fx-back" aria-hidden="true">
      <div class="cyber-aurora"></div>
      <div class="cyber-grid"></div>
      <canvas class="cyber-net"></canvas>
      <div class="cyber-spot"></div>
    </div>
    <div class="cyber-fx cyber-fx-front" aria-hidden="true">
      <div class="cyber-scan"></div>
      <div class="cyber-lines"></div>
      <div class="cyber-noise"></div>
      <div class="cyber-vignette"></div>
      <div class="cyber-flash"></div>
    </div>
    <section class="cyber-boot" role="status" aria-label="Restork cyber shell boot sequence">
      <strong class="cyber-boot-mark" data-text="RESTORK">RESTORK</strong>
      <div class="cyber-boot-log">
        <p><b>SHELL</b> / CYBER NEON <span>ONLINE</span></p>
        <p><b>CHANNEL</b> / LOCAL WORKSPACE <span>BOUND</span></p>
        <p><b>MOTION</b> / GSAP 3 <span>READY</span></p>
        <p><b>INTERFACE</b> / RESTORK <span>OPEN</span></p>
      </div>
      <div class="cyber-boot-bar"><i></i></div>
      <small>点击任意位置进入 · Esc 跳过</small>
    </section>`;
}

function replayBoot(gsap: GsapApi, root: HTMLElement, reduceMotion: boolean): void {
  const boot = root.querySelector<HTMLElement>(".cyber-boot");
  const mark = boot?.querySelector<HTMLElement>(".cyber-boot-mark");
  const lines = boot?.querySelectorAll<HTMLElement>(".cyber-boot-log p");
  const bar = boot?.querySelector<HTMLElement>(".cyber-boot-bar i");
  if (!boot || !mark || !lines || !bar) return;
  boot.hidden = false;
  if (reduceMotion) {
    boot.hidden = true;
    return;
  }
  gsap.killTweensOf([boot, mark, bar, ...lines]);
  gsap.set(boot, { autoAlpha: 1, scale: 1 });
  gsap.set(lines, { autoAlpha: 0, x: -14 });
  gsap.set(bar, { scaleX: 0, transformOrigin: "left center" });
  gsap.timeline({ defaults: { ease: "power3.out" } })
    .fromTo(mark, { autoAlpha: 0, x: -24, skewX: -8 }, { autoAlpha: 1, x: 0, skewX: 0, duration: 0.45 })
    .to(lines, { autoAlpha: 1, x: 0, duration: 0.26, stagger: 0.16 }, "-=0.08")
    .to(bar, { scaleX: 1, duration: 0.9, ease: "power2.inOut" }, "-=0.34")
    .to(boot, { autoAlpha: 0, scale: 1.035, duration: 0.42, ease: "power2.in", onComplete: () => { boot.hidden = true; } }, "+=0.18");
}

function animateShell(gsap: GsapApi, root: HTMLElement, reduceMotion: boolean): CyberMatchMedia | null {
  if (reduceMotion) return null;
  const media = gsap.matchMedia();
  media.add("(prefers-reduced-motion: no-preference)", () => {
    const nav = root.querySelectorAll<HTMLElement>(".nav-item");
    const cards = root.querySelectorAll<HTMLElement>(".view.is-visible .paper-card, .view:not([hidden]) .paper-card");
    gsap.fromTo(nav, { autoAlpha: 0, x: -18 }, {
      autoAlpha: 1, x: 0, duration: 0.42, stagger: 0.035, ease: "power3.out",
      clearProps: "transform,opacity,visibility",
    });
    gsap.fromTo(cards, { autoAlpha: 0, y: 20, scale: 0.985 }, {
      autoAlpha: 1, y: 0, scale: 1, duration: 0.54, stagger: 0.055, ease: "power3.out",
      clearProps: "transform,opacity,visibility",
    });
  }, root);
  return media;
}

function installParticleNetwork(
  canvas: HTMLCanvasElement,
  level: () => CyberFxLevel,
): () => void {
  if (navigator.userAgent.includes("jsdom")) return () => undefined;
  const context = canvas.getContext("2d");
  if (!context) return () => undefined;
  type Mote = {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    hot: boolean;
    shape: 0 | 1 | 2;
    angle: number;
    spin: number;
  };
  type GlyphColumn = { x: number; y: number; speed: number; length: number; step: number };
  const glyphs = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾅﾆﾇﾈﾊﾋﾌﾍﾎﾐﾑﾒﾓﾗﾘﾙﾚﾛ0123456789";
  let motes: Mote[] = [];
  let columns: GlyphColumn[] = [];
  let width = 0;
  let height = 0;
  let frame = 0;
  let lastPaint = 0;
  let lastMotion = 0;
  let paletteReadAt = 0;
  let cleared = false;
  const pointer = { x: -999, y: -999 };

  const colors = (): [string, string] => {
    const style = getComputedStyle(document.documentElement);
    return [style.getPropertyValue("--brand").trim(), style.getPropertyValue("--danger").trim()];
  };
  const resize = (): void => {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    // Below roughly one mote per 15k px² the field never reaches the 152px link
    // radius, so the network reads as scattered dust instead of a network.
    const count = Math.min(110, Math.max(42, Math.floor((width * height) / 15_000)));
    motes = Array.from({ length: count }, (_, index) => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      radius: 0.7 + Math.random() * 1.6,
      hot: index % 7 === 0,
      shape: index % 11 === 0 ? 2 : index % 6 === 0 ? 1 : 0,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.018,
    }));
    const columnCount = Math.min(20, Math.max(9, Math.round(width / 104)));
    columns = Array.from({ length: columnCount }, () => ({
      x: Math.round(Math.random() * width),
      y: Math.random() * height * 1.2 - height * 0.15,
      speed: 34 + Math.random() * 54,
      length: 12 + Math.round(Math.random() * 14),
      step: 16,
    }));
  };
  const draw = (timestamp: number): void => {
    frame = window.requestAnimationFrame(draw);
    const fx = level();
    if (fx === "off" || document.hidden) {
      // Leaving the last frame painted reads as a frozen background, so the
      // canvas is cleared once and then left alone.
      if (!cleared) {
        context.clearRect(0, 0, width, height);
        cleared = true;
      }
      lastPaint = timestamp;
      lastMotion = timestamp;
      return;
    }
    cleared = false;
    const density = fx === "lite" ? 0.45 : 1;
    // The network is atmospheric, not an interaction surface. Capping its own
    // paint loop at 30 fps leaves the compositor budget to scrolling and text.
    if (timestamp - lastPaint < 32) return;
    const delta = lastMotion ? Math.min(2, (timestamp - lastMotion) / 16.67) : 1;
    lastPaint = timestamp;
    lastMotion = timestamp;
    context.clearRect(0, 0, width, height);
    if (!paletteReadAt || timestamp - paletteReadAt > 2_000) {
      cachedColors = colors();
      paletteReadAt = timestamp;
    }
    const [primary, secondary] = cachedColors;
    const deltaSeconds = delta * 16.67 / 1_000;
    context.font = '13px ui-monospace, "SFMono-Regular", Consolas, monospace';
    context.textBaseline = "top";
    const columnLimit = Math.max(4, Math.round(columns.length * density));
    for (let index = 0; index < columnLimit; index += 1) {
      const column = columns[index];
      column.y += column.speed * deltaSeconds;
      if (column.y - column.length * column.step > height) {
        column.y = -Math.random() * height * 0.65 - 24;
        column.x = Math.round(Math.random() * width);
      }
      for (let step = 0; step < column.length; step += 1) {
        const y = column.y - step * column.step;
        if (y < -20 || y > height) continue;
        const fade = 1 - step / column.length;
        context.globalAlpha = 0.11 + fade * 0.38;
        context.fillStyle = step === 0 ? secondary : primary;
        const glyphIndex = Math.abs(Math.floor(column.x + step * 7 + column.y / 26)) % glyphs.length;
        context.fillText(glyphs.charAt(glyphIndex), column.x, y);
        // The leading glyph is the only lit one; painting it twice gives it a
        // hot core without paying for a shadow blur every frame.
        if (step === 0) context.fillText(glyphs.charAt(glyphIndex), column.x, y);
      }
    }
    const moteLimit = Math.max(16, Math.round(motes.length * density));
    for (let left = 0; left < moteLimit; left += 1) {
      const a = motes[left];
      for (let right = left + 1; right < moteLimit; right += 1) {
        const b = motes[right];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > 23_104) continue;
        const distance = Math.sqrt(distanceSquared);
        context.globalAlpha = (1 - distance / 152) * 0.32;
        context.strokeStyle = primary;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }
    }
    for (let index = 0; index < moteLimit; index += 1) {
      const mote = motes[index];
      mote.x = (mote.x + mote.vx * delta + width) % width;
      mote.y = (mote.y + mote.vy * delta + height) % height;
      mote.angle += mote.spin * delta;
      const distance = Math.hypot(mote.x - pointer.x, mote.y - pointer.y);
      const near = distance < 170 ? 1 - distance / 170 : 0;
      const tone = mote.hot ? secondary : primary;
      if (mote.shape === 0) {
        context.globalAlpha = 0.55 + near * 0.42;
        context.fillStyle = tone;
        context.beginPath();
        context.arc(mote.x, mote.y, mote.radius + near * 1.4, 0, Math.PI * 2);
        context.fill();
      } else {
        const size = 6 + mote.radius * 3.2 + near * 2;
        const sides = mote.shape === 1 ? 3 : 4;
        context.save();
        context.translate(mote.x, mote.y);
        context.rotate(mote.angle);
        context.globalAlpha = 0.4 + near * 0.34;
        context.strokeStyle = tone;
        context.lineWidth = 1;
        context.beginPath();
        for (let side = 0; side < sides; side += 1) {
          const angle = -Math.PI / 2 + side * Math.PI * 2 / sides;
          const x = Math.cos(angle) * size;
          const y = Math.sin(angle) * size;
          if (side === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.closePath();
        context.stroke();
        context.restore();
      }
    }
    context.globalAlpha = 1;
  };
  const onPointer = (event: PointerEvent): void => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  };
  const onLeave = (): void => { pointer.x = -999; pointer.y = -999; };
  let cachedColors = colors();
  resize();
  frame = window.requestAnimationFrame(draw);
  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("pointerleave", onLeave, { passive: true });
  return () => {
    window.cancelAnimationFrame(frame);
    window.removeEventListener("resize", resize);
    window.removeEventListener("pointermove", onPointer);
    window.removeEventListener("pointerleave", onLeave);
  };
}

export function configureCyberpunkTheme(root: HTMLElement, theme: string | undefined): () => void {
  const { channel, fx } = applyCyberpunkPreferences();
  const controls = root.querySelector<HTMLElement>("[data-cyberpunk-controls]");
  const themePicker = root.querySelector<HTMLSelectElement>('select[name="theme"]');
  const channelPicker = root.querySelector<HTMLSelectElement>("[data-cyber-channel]");
  const fxPicker = root.querySelector<HTMLSelectElement>("[data-cyber-fx]");
  if (controls) controls.hidden = themePicker?.value !== "cyberpunk";
  if (channelPicker) channelPicker.value = channel;
  if (fxPicker) fxPicker.value = fx;

  const listeners: Array<() => void> = [];
  const bind = (
    target: EventTarget,
    type: string,
    listener: EventListener,
  ): void => {
    target.addEventListener(type, listener);
    listeners.push(() => target.removeEventListener(type, listener));
  };
  if (themePicker && controls) {
    bind(themePicker, "change", () => { controls.hidden = themePicker.value !== "cyberpunk"; });
  }
  if (channelPicker) {
    bind(channelPicker, "change", () => {
      const next = channelPicker.value as CyberChannel;
      if (!CHANNELS.has(next)) return;
      persist(CHANNEL_KEY, next);
      document.documentElement.dataset.cyberChannel = next;
      const shell = root.querySelector<HTMLElement>(".dashboard");
      if (shell && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        motion?.fromTo(shell, { x: -3 }, { x: 0, duration: 0.34, ease: "elastic.out(1, 0.3)", clearProps: "transform" });
      }
    });
  }
  if (fxPicker) {
    bind(fxPicker, "change", () => {
      const next = fxPicker.value as CyberFxLevel;
      if (!FX_LEVELS.has(next)) return;
      persist(FX_KEY, next);
      document.documentElement.dataset.cyberFx = next;
    });
  }

  if (theme !== "cyberpunk" || navigator.userAgent.includes("jsdom")) {
    return () => listeners.forEach((remove) => { remove(); });
  }
  root.insertAdjacentHTML("afterbegin", fxMarkup());
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const canvas = root.querySelector<HTMLCanvasElement>(".cyber-net");
  // The ambient field is plain canvas and starts immediately; only the timeline
  // work below waits for the motion engine.
  const stopNetwork = canvas
    ? installParticleNetwork(canvas, () => (reduceMotion
      ? "off"
      : (document.documentElement.dataset.cyberFx as CyberFxLevel | undefined) ?? "full"))
    : () => undefined;

  const brand = root.querySelector<HTMLElement>(".brand h1, .brand strong");
  if (brand) {
    brand.classList.add("cyber-glitch");
    brand.dataset.text = brand.textContent?.trim() || "RESTORK";
  }

  const boot = root.querySelector<HTMLElement>(".cyber-boot");
  const skipBoot = (): void => {
    if (!boot) return;
    motion?.killTweensOf(boot);
    motion?.set(boot, { autoAlpha: 0 });
    boot.hidden = true;
  };
  if (boot) bind(boot, "click", skipBoot);
  const keydown = (event: KeyboardEvent): void => {
    if (!boot || boot.hidden || event.key !== "Escape") return;
    event.preventDefault();
    skipBoot();
  };
  document.addEventListener("keydown", keydown);
  listeners.push(() => document.removeEventListener("keydown", keydown));
  const seen = bootSeenThisPage;
  if (seen || reduceMotion) {
    if (boot) boot.hidden = true;
  } else {
    bootSeenThisPage = true;
  }

  const replay = root.querySelector<HTMLElement>("[data-cyber-replay]");
  if (replay) bind(replay, "click", () => { if (motion) replayBoot(motion, root, reduceMotion); });

  const flash = root.querySelector<HTMLElement>(".cyber-flash");
  const onViewClick = (event: Event): void => {
    const button = (event.target as Element | null)?.closest<HTMLElement>("[data-view]");
    if (!button || reduceMotion) return;
    window.requestAnimationFrame(() => {
      const gsap = motion;
      if (!gsap) return;
      const cards = root.querySelectorAll<HTMLElement>(".view.is-visible .paper-card, .view:not([hidden]) .paper-card");
      gsap.fromTo(cards, { autoAlpha: 0, y: 16, scale: 0.99 }, {
        autoAlpha: 1, y: 0, scale: 1, duration: 0.44, stagger: 0.04, ease: "power3.out",
        clearProps: "transform,opacity,visibility",
      });
      if (flash) gsap.fromTo(flash, { autoAlpha: 0.7 }, { autoAlpha: 0, duration: 0.3, ease: "steps(3)" });
    });
  };
  bind(root, "click", onViewClick);

  let disposed = false;
  let media: CyberMatchMedia | null = null;
  void loadMotion().then((gsap) => {
    if (disposed) return;
    media = animateShell(gsap, root, reduceMotion);
    if (!reduceMotion) {
      const spot = root.querySelector<HTMLElement>(".cyber-spot");
      if (spot) {
        gsap.set(spot, { x: window.innerWidth / 2, y: window.innerHeight * 0.4, force3D: true });
        const moveX = gsap.quickTo(spot, "x", { duration: 0.22, ease: "power2.out" });
        const moveY = gsap.quickTo(spot, "y", { duration: 0.22, ease: "power2.out" });
        bind(window, "pointermove", (event) => {
          if (document.documentElement.dataset.cyberFx !== "full") return;
          const pointer = event as PointerEvent;
          moveX(pointer.clientX);
          moveY(pointer.clientY);
        });
        listeners.push(() => { gsap.killTweensOf(spot); });
      }
      if (!seen) replayBoot(gsap, root, false);
    }
  }).catch(() => {
    // A theme must never hold the interface behind a splash it cannot animate.
    if (boot) boot.hidden = true;
  });

  return () => {
    disposed = true;
    listeners.forEach((remove) => { remove(); });
    stopNetwork();
    media?.revert();
    motion?.killTweensOf(root.querySelectorAll(".cyber-fx, .cyber-boot, .nav-item, .paper-card"));
    root.querySelectorAll(".cyber-fx, .cyber-boot").forEach((node) => { node.remove(); });
  };
}
