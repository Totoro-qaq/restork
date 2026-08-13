/**
 * Intent limits shared with Core. Keep these numbers identical to
 * `contracts/intent-limits.json`; `scripts/check_intent_limits.py` locks both
 * ends so a menu cannot drift away from the renderer.
 */
export const MIN_SLIDE_COUNT = 1;
export const MAX_SLIDE_COUNT = 60;
export const MIN_SCHEDULE_INTERVAL_DAYS = 2;
export const MAX_SCHEDULE_INTERVAL_DAYS = 365;
export const MAX_SKILL_IDS_PER_RUN = 8;

export type ParsedIntentCount =
  | { ok: true; value: number | undefined }
  | { ok: false };

/** Blank is auto. Out-of-range is a visible error, never a silent clamp. */
export function parseIntentCount(raw: unknown, min: number, max: number): ParsedIntentCount {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, value: undefined };
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) return { ok: false };
  return { ok: true, value };
}
