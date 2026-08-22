import type { CatalogCursorV2, MailSnapshot } from "./types";

/**
 * LocalApiClient 的纯工具函数与错误类型。独立成模块是为了让 client.ts
 * 专注端点方法，并守住架构行数预算。
 */

export interface LocalSession {
  accessToken: string;
  expiresAt: string;
}

export function normalizeSession(
  accessToken: string,
  expiresAt: string,
  allowExpired = false,
): LocalSession {
  const expiry = Date.parse(expiresAt);
  if (
    !accessToken
    || accessToken.length > 512
    || /\s/.test(accessToken)
    || !Number.isFinite(expiry)
    || (!allowExpired && expiry <= Date.now())
  ) {
    throw new Error("Core returned an invalid local session");
  }
  return { accessToken, expiresAt: new Date(expiry).toISOString() };
}

export function sessionCredentialPath(path: string): boolean {
  return ["/v1/pair", "/v1/token/rotate", "/v1/token/revoke"].includes(path);
}

export function mailSnapshot(value: Record<string, unknown>): MailSnapshot | null {
  const unread = value.unread_count;
  const statuses = new Set<MailSnapshot["status"]>([
    "not_configured",
    "ready",
    "fresh",
    "stale",
    "denied",
    "restricted",
    "unsupported",
    "error",
  ]);
  if (
    typeof value.configured !== "boolean"
    || typeof value.status !== "string"
    || !statuses.has(value.status as MailSnapshot["status"])
    || typeof value.provider !== "string"
    || (unread !== null && (!Number.isSafeInteger(unread) || Number(unread) < 0))
    || (value.observed_at !== null && typeof value.observed_at !== "string")
    || typeof value.message !== "string"
  ) return null;
  return {
    configured: value.configured,
    status: value.status as MailSnapshot["status"],
    provider: value.provider,
    unread_count: unread === null ? null : Number(unread),
    observed_at: value.observed_at as string | null,
    message: value.message,
  };
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchWithTransientRetry(
  path: string,
  init: RequestInit,
  enabled: boolean,
): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch (error) {
    if (!enabled || !(error instanceof TypeError) || init.signal?.aborted) throw error;
    if (init.signal) {
      await abortableDelay(180, init.signal);
    } else {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 180));
    }
    return fetch(path, init);
  }
}

export function systemTimeZone(): string {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timezone && timezone.length <= 128 ? timezone : "UTC";
  } catch {
    return "UTC";
  }
}

export function schedulePagePath(path: string, cursor?: string): string {
  const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
  return `${path}?limit=20${suffix}`;
}

export function presentationTemplatePagePath(path: string, cursor?: CatalogCursorV2): string {
  const query = new URLSearchParams({ limit: "6" });
  if (cursor) {
    query.set("after_time", cursor.updated_at);
    query.set("after_id", cursor.id);
    query.set("after_version", String(cursor.version));
  }
  return `${path}?${query.toString()}`;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiError(response: Response): Promise<ApiError> {
  let detail = `Core returned HTTP ${response.status}`;
  try {
    const payload = (await response.json()) as { detail?: unknown };
    if (typeof payload.detail === "string") detail = payload.detail;
  } catch {
    // Do not include arbitrary response bodies in the error surface.
  }
  return new ApiError(detail, response.status);
}
