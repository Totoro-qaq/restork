const TERMINAL_RUN_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "retryable",
]);

/**
 * A retryable run is durable but no longer advancing. It becomes active again
 * only after the user explicitly asks Core to advance it.
 */
export function isRunActive(state: string): boolean {
  return !TERMINAL_RUN_STATES.has(state);
}

export function canRetryRun(state: string): boolean {
  return state === "retryable";
}
