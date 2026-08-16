import type { WeatherSnapshot } from "../api/types";

/**
 * Circular sky instrument for the dashboard weather card — a canvas port of
 * the v4 design's animated sky: time-of-day sun/moon arc, drifting cloud
 * cover, precipitation particles, and a small pointer-tilt parallax.
 *
 * Teardown discipline (learned from the CI flake): the rAF loop stops as soon
 * as the canvas leaves the document, and never touches `window` when the
 * global is already gone (vitest can tear down jsdom with a frame queued).
 */

type Rgb = [number, number, number];

const SIZE = 192;

// Cover fraction per group; groups 3–6 also draw precipitation (5 = snow).
const COVER = [0.02, 0.48, 0.74, 0.58, 0.72, 0.7, 0.84, 0.5];

function groupFromCondition(condition: string): number {
  const text = condition.toLowerCase();
  if (/snow|sleet|blizzard|雪/.test(text)) return 5;
  if (/thunder|storm|雷/.test(text)) return 6;
  if (/drizzle|毛毛雨/.test(text)) return 3;
  if (/rain|shower|雨/.test(text)) return 4;
  if (/fog|mist|haze|雾|霾/.test(text)) return 7;
  if (/overcast|阴/.test(text)) return 2;
  if (/cloud|云/.test(text)) return 1;
  return 0;
}

function parseCssColor(host: HTMLElement, name: string, fallback: Rgb): Rgb {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  host.appendChild(probe);
  const raw = getComputedStyle(probe).color;
  probe.remove();
  const match = raw.match(/[\d.]+/g);
  if (!match || match.length < 3) return fallback;
  return [Number(match[0]), Number(match[1]), Number(match[2])];
}

function rgbCss(value: Rgb): string {
  return `rgb(${Math.round(value[0])},${Math.round(value[1])},${Math.round(value[2])})`;
}

export function startSky(root: HTMLElement, weather: WeatherSnapshot | null | undefined): void {
  const host = root.querySelector<HTMLElement>("[data-sky]");
  const canvas = host?.querySelector<HTMLCanvasElement>("canvas");
  if (!host || !canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (!weather?.configured || weather.temperature_c === null) return;

  const reduce = typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const group = groupFromCondition(weather.condition ?? "");
  const cover = COVER[group] ?? 0.4;
  const t0 = Date.now();
  const tilt = { x: 0, y: 0, tx: 0, ty: 0 };

  const colors = {
    sun: rgbCss(parseCssColor(host, "--sun", [226, 164, 60])),
    moon: rgbCss(parseCssColor(host, "--moon", [148, 165, 203])),
    sky: rgbCss(parseCssColor(host, "--info-ink", [70, 110, 160])),
    skyDeep: rgbCss(parseCssColor(host, "--bg", [250, 247, 240])),
    cloud: rgbCss(parseCssColor(host, "--surface", [255, 255, 255])),
    cloudStroke: rgbCss(parseCssColor(host, "--fg-muted", [140, 130, 115])),
  };

  const drawCloud = (x: number, y: number, scale: number): void => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.ellipse(0, 8, 34, 14, 0, 0, Math.PI * 2);
    ctx.ellipse(-20, 2, 14, 12, 0, 0, Math.PI * 2);
    ctx.ellipse(18, 0, 16, 13, 0, 0, Math.PI * 2);
    ctx.ellipse(-2, -6, 15, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  const paint = (): void => {
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const isDay = weather.is_day ?? (hour >= 6 && hour < 18);
    const R = SIZE / 2 - 4;
    const tsec = (Date.now() - t0) / 1000;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.translate(SIZE / 2 + tilt.y * 10, SIZE / 2 + tilt.x * 8);
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.clip();

    const gradient = ctx.createRadialGradient(-R * 0.3, -R * 0.35, R * 0.06, 0, 0, R);
    if (isDay) {
      gradient.addColorStop(0, colors.sun);
      gradient.addColorStop(0.18, "rgba(255,252,245,0.92)");
      gradient.addColorStop(0.55, colors.sky);
      gradient.addColorStop(1, colors.skyDeep);
    } else {
      gradient.addColorStop(0, colors.moon);
      gradient.addColorStop(0.42, colors.skyDeep);
      gradient.addColorStop(1, colors.skyDeep);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(-R, -R, R * 2, R * 2);

    // Sun/moon travels an arc across the disc as the day progresses.
    let span = isDay ? (hour - 6) / 12 : ((hour < 6 ? hour + 6 : hour - 18) / 12);
    span = Math.min(1, Math.max(0, span));
    const angle = Math.PI * (1 - span);
    const reach = R * 0.5;
    const bx = Math.cos(angle) * reach;
    const by = -Math.sin(angle) * reach * 0.86;

    const glow = ctx.createRadialGradient(bx, by, 2, bx, by, R * 0.45);
    glow.addColorStop(0, isDay ? "rgba(255,210,110,0.9)" : "rgba(230,236,255,0.55)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(bx, by, R * 0.45, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = isDay ? colors.sun : colors.moon;
    ctx.beginPath();
    ctx.arc(bx, by, isDay ? 12 : 10, 0, Math.PI * 2);
    ctx.fill();

    if (isDay) {
      ctx.strokeStyle = colors.sun;
      ctx.lineWidth = 1.7;
      ctx.lineCap = "round";
      for (let i = 0; i < 8; i += 1) {
        const a = (i * Math.PI) / 4;
        ctx.beginPath();
        ctx.moveTo(bx + Math.cos(a) * 17, by + Math.sin(a) * 17);
        ctx.lineTo(bx + Math.cos(a) * 24, by + Math.sin(a) * 24);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath(); ctx.arc(-R * 0.42, -R * 0.38, 1.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(R * 0.3, -R * 0.5, 1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(R * 0.48, -R * 0.12, 0.8, 0, Math.PI * 2); ctx.fill();
    }

    if (cover > 0.05) {
      const drift = reduce ? 0 : Math.sin(tsec * 0.25) * 10;
      ctx.globalAlpha = 0.5 + cover * 0.4;
      ctx.fillStyle = colors.cloud;
      ctx.strokeStyle = colors.cloudStroke;
      ctx.lineWidth = 1.5;
      drawCloud(-14 + drift, 10, 1);
      if (cover > 0.35) drawCloud(16 + drift * 0.5, 22, 0.78);
      if (cover > 0.65) drawCloud(-4 + drift * 0.3, 34, 0.62);
      ctx.globalAlpha = 1;
    }

    if (group >= 3 && group <= 6) {
      ctx.strokeStyle = group === 5 ? colors.cloudStroke : colors.sky;
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      for (let k = 0; k < 9; k += 1) {
        const y = 28 + ((k * 13 + (reduce ? 0 : tsec * (group === 5 ? 18 : 46))) % 50);
        ctx.beginPath();
        ctx.moveTo(-36 + k * 9, y);
        ctx.lineTo(-32 + k * 9, y + (group === 5 ? 4 : 10));
        ctx.stroke();
      }
    }

    const shade = ctx.createRadialGradient(-R * 0.28, -R * 0.32, R * 0.12, R * 0.2, R * 0.28, R * 1.05);
    shade.addColorStop(0, "rgba(255,255,255,0.28)");
    shade.addColorStop(0.42, "rgba(255,255,255,0)");
    shade.addColorStop(1, isDay ? "rgba(40,30,18,0.28)" : "rgba(0,0,0,0.42)");
    ctx.fillStyle = shade;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    ctx.restore();
    host.classList.add("is-live");
  };

  const loop = (): void => {
    if (typeof window === "undefined" || !canvas.isConnected) return;
    tilt.x += (tilt.tx - tilt.x) * 0.14;
    tilt.y += (tilt.ty - tilt.y) * 0.14;
    paint();
    if (!reduce) window.requestAnimationFrame(loop);
  };

  canvas.addEventListener("pointermove", (event) => {
    if (reduce) return;
    const box = canvas.getBoundingClientRect();
    tilt.ty = (event.clientX - box.left) / box.width - 0.5;
    tilt.tx = (event.clientY - box.top) / box.height - 0.5;
  });
  canvas.addEventListener("pointerleave", () => {
    tilt.tx = 0;
    tilt.ty = 0;
  });

  paint();
  if (!reduce && typeof window !== "undefined" && canvas.isConnected) {
    window.requestAnimationFrame(loop);
  }
}
