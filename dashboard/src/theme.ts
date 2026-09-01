import type { DashboardSnapshot } from "./api/types";

export const DEFAULT_DASHBOARD_THEME = "cyberpunk";

const DASHBOARD_THEMES = new Set(["system", "light", "dark", "cyberpunk"]);

export function resolveDashboardTheme(
  theme: string | undefined,
  fallback = DEFAULT_DASHBOARD_THEME,
): string {
  if (theme && DASHBOARD_THEMES.has(theme)) return theme;
  return DASHBOARD_THEMES.has(fallback) ? fallback : DEFAULT_DASHBOARD_THEME;
}

/**
 * A Core refresh can be partially successful and omit personal settings. Keep
 * the appearance already on screen in that case; an explicit stored theme in
 * the refreshed snapshot still wins.
 */
export function retainDashboardTheme(
  snapshot: DashboardSnapshot,
  fallback: string | undefined,
): DashboardSnapshot {
  const workspace = snapshot.workspaceV2;
  if (!workspace) return snapshot;
  const personal = workspace.personal;
  const storedTheme = personal?.settings.theme;
  if (storedTheme && DASHBOARD_THEMES.has(storedTheme)) return snapshot;

  return {
    ...snapshot,
    workspaceV2: {
      ...workspace,
      personal: {
        settings: {
          ...(personal?.settings ?? {}),
          theme: resolveDashboardTheme(undefined, fallback),
        },
        version: personal?.version ?? 0,
        updated_at: personal?.updated_at ?? null,
      },
    },
  };
}
