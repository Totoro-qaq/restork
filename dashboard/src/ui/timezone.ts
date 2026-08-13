import type { Locale } from "../i18n";
import { tr } from "../i18n";
import { escapeMarkup } from "./dom";

/** Filterable zone list. Blank still means "follow this device". */
export function timeZoneOptions(savedTimeZone: string | undefined, locale: Locale): string {
  let systemTimeZone = "UTC";
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof resolved === "string" && resolved.length > 0 && resolved.length <= 128) {
      systemTimeZone = resolved;
    }
  } catch {
    // UTC remains the deterministic fallback when the runtime cannot expose a zone.
  }
  const saved = savedTimeZone?.trim();
  const selectedTimeZone = saved || systemTimeZone;
  const followsSystem = !saved;
  let supportedTimeZones: string[] = [];
  try {
    const supportedValuesOf = Reflect.get(Intl, "supportedValuesOf");
    if (typeof supportedValuesOf === "function") {
      const values = Reflect.apply(supportedValuesOf, Intl, ["timeZone"]);
      if (Array.isArray(values)) {
        supportedTimeZones = values.filter((value): value is string => (
          typeof value === "string" && value.length > 0 && value.length <= 128
        ));
      }
    }
  } catch {
    // Older WebViews use the common bounded fallback below.
  }
  const availableTimeZones = [
    selectedTimeZone,
    "UTC",
    "Asia/Shanghai",
    "Asia/Hong_Kong",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Europe/London",
    "Europe/Paris",
    "America/New_York",
    "America/Los_Angeles",
    ...supportedTimeZones,
  ].filter((value, index, values) => values.indexOf(value) === index);
  const systemLabel = tr(
    locale,
    `Follow this device (${systemTimeZone})`,
    `跟随这台设备（${systemTimeZone}）`,
  );
  return `<input name="timezone" list="timezone-options" maxlength="128"
      autocomplete="off" spellcheck="false" value="${followsSystem ? "" : escapeMarkup(selectedTimeZone)}"
      placeholder="${escapeMarkup(systemLabel)}" aria-describedby="timezone-hint">
    <datalist id="timezone-options">${availableTimeZones.map((timeZone) => (
      `<option value="${escapeMarkup(timeZone)}"></option>`
    )).join("")}</datalist>
    <small id="timezone-hint">${tr(
      locale,
      "Start typing to filter. Leave it blank to follow this device.",
      "输入几个字母即可筛选；留空就跟随这台设备。",
    )}</small>`;
}
