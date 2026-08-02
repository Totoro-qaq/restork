import type { LocalSession } from "./api/client";

type DesktopSession =
  | { kind: "pairing"; pairing_code: string }
  | { kind: "token"; access_token: string; expires_at: string };

export interface DesktopRecoveryArtifact {
  version: string;
  target: string;
  filename: string;
  sha256: string;
  verified_at_unix: number;
}

type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke?: NativeInvoke;
      };
    };
  }
}

export interface DesktopBridge {
  session(): Promise<DesktopSession>;
  store(session: LocalSession): Promise<void>;
  recovery(): Promise<DesktopRecoveryArtifact[]>;
}

export function detectDesktopBridge(
  location: Pick<Location, "protocol" | "hostname" | "port"> = window.location,
  tauri: Window["__TAURI__"] = window.__TAURI__,
): DesktopBridge | null {
  const invoke = tauri?.core?.invoke;
  if (
    typeof invoke !== "function"
    || location.protocol !== "http:"
    || location.hostname !== "127.0.0.1"
    || !location.port
  ) {
    return null;
  }
  return {
    async session(): Promise<DesktopSession> {
      const value = await invoke<unknown>("desktop_session");
      if (!isRecord(value) || (value.kind !== "pairing" && value.kind !== "token")) {
        throw new Error("The native session bridge returned an invalid response");
      }
      if (value.kind === "pairing" && typeof value.pairing_code === "string") {
        return { kind: "pairing", pairing_code: value.pairing_code };
      }
      if (
        value.kind === "token"
        && typeof value.access_token === "string"
        && typeof value.expires_at === "string"
      ) {
        return {
          kind: "token",
          access_token: value.access_token,
          expires_at: value.expires_at,
        };
      }
      throw new Error("The native session bridge returned an invalid response");
    },
    async store(session: LocalSession): Promise<void> {
      await invoke("desktop_store_session", {
        session: {
          accessToken: session.accessToken,
          expiresAt: session.expiresAt,
        },
      });
    },
    async recovery(): Promise<DesktopRecoveryArtifact[]> {
      const value = await invoke<unknown>("desktop_update_recovery");
      if (!Array.isArray(value) || !value.every(isRecoveryArtifact)) {
        throw new Error("The native recovery bridge returned an invalid response");
      }
      return value;
    },
  };
}

function isRecoveryArtifact(value: unknown): value is DesktopRecoveryArtifact {
  return isRecord(value)
    && typeof value.version === "string"
    && typeof value.target === "string"
    && typeof value.filename === "string"
    && typeof value.sha256 === "string"
    && value.sha256.length === 64
    && typeof value.verified_at_unix === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
