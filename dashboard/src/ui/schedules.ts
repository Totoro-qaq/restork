import {
  MAX_SCHEDULE_INTERVAL_DAYS,
  MIN_SCHEDULE_INTERVAL_DAYS,
} from "../limits";
import type { Locale } from "../i18n";
import { tr } from "../i18n";

/** Cadence is intent, so it takes a free number inside honest bounds. */
export function scheduleIntervalField(locale: Locale, value: number, hidden: boolean): string {
  return `<label data-schedule-interval-field ${hidden ? "hidden" : ""}>${tr(locale, "Run every … days", "每隔几天运行")}
    <input name="interval_days" type="number" inputmode="numeric"
      min="${MIN_SCHEDULE_INTERVAL_DAYS}" max="${MAX_SCHEDULE_INTERVAL_DAYS}" step="1" value="${value}">
    <small>${tr(
      locale,
      `Any number from ${MIN_SCHEDULE_INTERVAL_DAYS} to ${MAX_SCHEDULE_INTERVAL_DAYS}. Counting starts today.`,
      `${MIN_SCHEDULE_INTERVAL_DAYS} 到 ${MAX_SCHEDULE_INTERVAL_DAYS} 之间任意天数，从今天开始算。`,
    )}</small></label>`;
}
