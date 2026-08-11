import type { PresentationTemplateRecordV2 } from "../api/types";

export interface BuiltinRenderTheme {
  id: string;
  nameEn: string;
  nameZh: string;
  descriptionEn: string;
  descriptionZh: string;
  background: string;
  foreground: string;
  accent: string;
  accentSecondary: string;
  layout: "editorial" | "minimal" | "spotlight" | "research" | "narrative" | "blueprint";
}

/**
 * This catalog mirrors the renderer-owned, zero-runtime theme catalog.
 * A contract test keeps the ids aligned with the Rust catalog; colors here
 * are used only for safe in-app previews, never as renderer authority.
 */
export const BUILTIN_RENDER_THEMES: readonly BuiltinRenderTheme[] = [
  {
    id: "restork-print", nameEn: "Letterpress", nameZh: "打字纸",
    descriptionEn: "Warm editorial slides for reviews.", descriptionZh: "暖色纸张与编辑式标题，适合复盘与汇报。",
    background: "#fbf7ef", foreground: "#302a21", accent: "#6657d9", accentSecondary: "#e84d8a", layout: "editorial",
  },
  {
    id: "restork-clarity", nameEn: "Clarity", nameZh: "清晰简报",
    descriptionEn: "Clean white canvas for formal updates.", descriptionZh: "留白清楚、钴蓝强调，适合正式简报。",
    background: "#f8fafc", foreground: "#172033", accent: "#2563eb", accentSecondary: "#06b6d4", layout: "minimal",
  },
  {
    id: "restork-midnight", nameEn: "Midnight", nameZh: "深夜演示",
    descriptionEn: "A dark stage for talks and demos.", descriptionZh: "深色舞台配紫青高光，适合演讲与展示。",
    background: "#11131a", foreground: "#f8fafc", accent: "#a78bfa", accentSecondary: "#22d3ee", layout: "spotlight",
  },
  {
    id: "restork-ocean", nameEn: "Ocean Lab", nameZh: "海盐研究",
    descriptionEn: "A cool palette for research evidence.", descriptionZh: "清冷研究配色，适合证据、论文与技术叙事。",
    background: "#ecfeff", foreground: "#164e63", accent: "#0891b2", accentSecondary: "#0f766e", layout: "research",
  },
  {
    id: "restork-ember", nameEn: "Ember", nameZh: "暖色复盘",
    descriptionEn: "Warm emphasis for stories and retrospectives.", descriptionZh: "奶油底色配暖橙重点，适合故事与阶段复盘。",
    background: "#fff7ed", foreground: "#431407", accent: "#ea580c", accentSecondary: "#e11d48", layout: "narrative",
  },
  {
    id: "restork-blueprint", nameEn: "Blueprint", nameZh: "数据蓝图",
    descriptionEn: "Structured navy for architecture and plans.", descriptionZh: "深蓝结构化画布，适合架构、数据与计划。",
    background: "#eaf2ff", foreground: "#102a56", accent: "#1d4ed8", accentSecondary: "#7c3aed", layout: "blueprint",
  },
] as const;

export function builtinRenderTheme(themeId: unknown): BuiltinRenderTheme {
  return BUILTIN_RENDER_THEMES.find((theme) => theme.id === themeId) ?? BUILTIN_RENDER_THEMES[0];
}

export function templateRenderTheme(record: PresentationTemplateRecordV2): BuiltinRenderTheme {
  const theme = record.template.theme;
  return {
    id: record.template_id,
    nameEn: theme.name,
    nameZh: theme.name,
    descriptionEn: sourceDescription(record, "en-US"),
    descriptionZh: sourceDescription(record, "zh-CN"),
    background: cssColor(theme.background),
    foreground: cssColor(theme.foreground),
    accent: cssColor(theme.accent),
    accentSecondary: cssColor(theme.accent_secondary),
    layout: theme.layout,
  };
}

export function cssColor(value: string): string {
  const normalized = value.trim().replace(/^#/, "");
  return /^[0-9A-Fa-f]{6}$/.test(normalized) ? `#${normalized}` : "#000000";
}

export function sourceDescription(
  record: PresentationTemplateRecordV2,
  locale: "en-US" | "zh-CN",
): string {
  const source = record.template.source;
  const label = source.label?.trim();
  if (source.kind === "pptx") {
    return locale === "zh-CN"
      ? `从 PPTX 转换${label ? ` · ${label}` : ""}`
      : `Converted from PPTX${label ? ` · ${label}` : ""}`;
  }
  if (source.kind === "image") {
    return locale === "zh-CN"
      ? `从图片取色${label ? ` · ${label}` : ""}`
      : `Palette from image${label ? ` · ${label}` : ""}`;
  }
  return locale === "zh-CN" ? "在本机创建" : "Created on this device";
}

const RECENT_THEME_KEY = "restork.presentation-theme.recent.v1";

export interface RecentPresentationTheme {
  id: string;
  usedAt: string | null;
}

export function recentPresentationTheme(): RecentPresentationTheme | null {
  try {
    const stored = window.localStorage.getItem(RECENT_THEME_KEY);
    if (!stored) return null;
    if (!stored.startsWith("{")) return { id: stored, usedAt: null };
    const parsed = JSON.parse(stored) as { id?: unknown; usedAt?: unknown };
    return typeof parsed.id === "string" && parsed.id
      ? { id: parsed.id, usedAt: typeof parsed.usedAt === "string" ? parsed.usedAt : null }
      : null;
  } catch {
    return null;
  }
}

export function recentPresentationThemeId(): string | null {
  return recentPresentationTheme()?.id ?? null;
}

export function rememberPresentationThemeId(themeId: string): void {
  try {
    window.localStorage.setItem(RECENT_THEME_KEY, JSON.stringify({ id: themeId, usedAt: new Date().toISOString() }));
  } catch {
    // The template still works when browser storage is unavailable.
  }
}
