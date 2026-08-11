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

export interface DesktopVaultConfig {
  status: "configured" | "unconfigured" | "environment";
  grantId?: string;
  label?: string;
  mutable: boolean;
}

export type DesktopVaultCandidate =
  | { status: "cancelled" }
  | {
      status: "selected";
      candidateId: string;
      label: string;
      sameAsActive: boolean;
    };

export interface DesktopVaultApplyResult {
  status: "switching" | "unchanged";
  label: string;
}

export type DesktopSecretResult =
  | { status: "cancelled" }
  | { status: "saved"; secretRef: string };

export type DesktopWorkspaceGrant =
  | { status: "cancelled" }
  | { status: "selected"; grantId: string; label: string };

export interface DesktopOnboardingState {
  version: 1;
  dismissed: boolean;
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
  vaultConfig(): Promise<DesktopVaultConfig>;
  chooseVault(): Promise<DesktopVaultCandidate>;
  applyVault(candidateId: string): Promise<DesktopVaultApplyResult>;
  chooseWorkspace(): Promise<DesktopWorkspaceGrant>;
  configureProviderSecret(providerKind: string): Promise<DesktopSecretResult>;
  onboardingState(): Promise<DesktopOnboardingState>;
  setOnboardingDismissed(dismissed: boolean): Promise<DesktopOnboardingState>;
  openExternal(url: string): Promise<void>;
}

const externalLinkHandlers = new WeakMap<HTMLElement, EventListener>();

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
    async vaultConfig(): Promise<DesktopVaultConfig> {
      const value = await invoke<unknown>("desktop_vault_config");
      if (!isVaultConfig(value)) {
        throw new Error("The native vault bridge returned an invalid response");
      }
      return {
        status: value.status,
        grantId: value.grant_id,
        label: value.label,
        mutable: value.mutable,
      };
    },
    async chooseVault(): Promise<DesktopVaultCandidate> {
      const value = await invoke<unknown>("desktop_choose_vault");
      if (!isVaultCandidate(value)) {
        throw new Error("The native vault bridge returned an invalid response");
      }
      if (value.status === "cancelled") return value;
      return {
        status: "selected",
        candidateId: value.candidate_id,
        label: value.label,
        sameAsActive: value.same_as_active,
      };
    },
    async applyVault(candidateId: string): Promise<DesktopVaultApplyResult> {
      const value = await invoke<unknown>("desktop_apply_vault", { candidateId });
      if (!isVaultApplyResult(value)) {
        throw new Error("The native vault bridge returned an invalid response");
      }
      return { status: value.status, label: value.label };
    },
    async chooseWorkspace(): Promise<DesktopWorkspaceGrant> {
      const value = await invoke<unknown>("desktop_choose_workspace");
      if (!isWorkspaceGrant(value)) {
        throw new Error("The native workspace bridge returned an invalid response");
      }
      if (value.status === "cancelled") return { status: "cancelled" };
      return {
        status: "selected",
        grantId: value.grant_id,
        label: value.label,
      };
    },
    async configureProviderSecret(providerKind: string): Promise<DesktopSecretResult> {
      const value = await invoke<unknown>("desktop_configure_provider_secret", { providerKind });
      if (!isSecretResult(value)) {
        throw new Error("The native credential bridge returned an invalid response");
      }
      if (value.status === "cancelled") return value;
      return { status: "saved", secretRef: value.secret_ref };
    },
    async onboardingState(): Promise<DesktopOnboardingState> {
      const value = await invoke<unknown>("desktop_onboarding_state");
      if (!isOnboardingState(value)) {
        throw new Error("The native onboarding bridge returned an invalid response");
      }
      return value;
    },
    async setOnboardingDismissed(dismissed: boolean): Promise<DesktopOnboardingState> {
      const value = await invoke<unknown>("desktop_set_onboarding_dismissed", { dismissed });
      if (!isOnboardingState(value)) {
        throw new Error("The native onboarding bridge returned an invalid response");
      }
      return value;
    },
    async openExternal(url: string): Promise<void> {
      await invoke("desktop_open_external", { url });
    },
  };
}

/**
 * A loopback Dashboard runs inside a Tauri WebView, where target=_blank does
 * not create a useful browser tab. Delegate only public HTTPS links to the
 * native shell; the ordinary Web build keeps the browser's normal behavior.
 */
export function bindDesktopExternalLinks(
  root: HTMLElement,
  bridge: DesktopBridge | null,
  onError: (error: unknown) => void = () => undefined,
): void {
  const previous = externalLinkHandlers.get(root);
  if (previous) root.removeEventListener("click", previous);
  externalLinkHandlers.delete(root);
  if (!bridge) return;

  const handler: EventListener = (event) => {
    if (!(event instanceof MouseEvent) || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!target || !root.contains(target) || target.hasAttribute("download")) return;
    let url: URL;
    try {
      url = new URL(target.href);
    } catch {
      return;
    }
    if (url.protocol !== "https:") return;
    event.preventDefault();
    void bridge.openExternal(url.toString()).catch(onError);
  };
  externalLinkHandlers.set(root, handler);
  root.addEventListener("click", handler);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isVaultConfig(value: unknown): value is {
  status: DesktopVaultConfig["status"];
  grant_id?: string;
  label?: string;
  mutable: boolean;
} {
  if (!isRecord(value) || !hasOnlyKeys(value, ["status", "grant_id", "label", "mutable"])) {
    return false;
  }
  if (!(["configured", "unconfigured", "environment"] as unknown[]).includes(value.status)) {
    return false;
  }
  if (typeof value.mutable !== "boolean") return false;
  if (value.status === "unconfigured") {
    return value.grant_id === undefined && value.label === undefined;
  }
  return typeof value.grant_id === "string"
    && value.grant_id.length > 0
    && value.grant_id.length <= 128
    && typeof value.label === "string"
    && value.label.length > 0
    && value.label.length <= 256;
}

type WorkspaceGrantWire =
  | { status: "cancelled" }
  | { status: "selected"; grant_id: string; label: string };

function isWorkspaceGrant(value: unknown): value is WorkspaceGrantWire {
  if (!isRecord(value) || !hasOnlyKeys(value, ["status", "grant_id", "label"])) return false;
  if (value.status === "cancelled") return hasOnlyKeys(value, ["status"]);
  return value.status === "selected"
    && typeof value.grant_id === "string"
    && /^[a-f0-9]{32}$/.test(value.grant_id)
    && typeof value.label === "string"
    && value.label.length > 0
    && value.label.length <= 255;
}

type VaultCandidateWire =
  | { status: "cancelled" }
  | { status: "selected"; candidate_id: string; label: string; same_as_active: boolean };

function isVaultCandidate(value: unknown): value is VaultCandidateWire {
  if (!isRecord(value)) return false;
  if (value.status === "cancelled") return hasOnlyKeys(value, ["status"]);
  return value.status === "selected"
    && hasOnlyKeys(value, ["status", "candidate_id", "label", "same_as_active"])
    && typeof value.candidate_id === "string"
    && value.candidate_id.length > 0
    && value.candidate_id.length <= 128
    && typeof value.label === "string"
    && value.label.length > 0
    && value.label.length <= 256
    && typeof value.same_as_active === "boolean";
}

function isVaultApplyResult(value: unknown): value is {
  status: DesktopVaultApplyResult["status"];
  label: string;
} {
  return isRecord(value)
    && hasOnlyKeys(value, ["status", "label"])
    && (value.status === "switching" || value.status === "unchanged")
    && typeof value.label === "string"
    && value.label.length > 0
    && value.label.length <= 256;
}

type SecretResultWire =
  | { status: "cancelled" }
  | { status: "saved"; secret_ref: string };

function isSecretResult(value: unknown): value is SecretResultWire {
  if (!isRecord(value)) return false;
  if (value.status === "cancelled") return hasOnlyKeys(value, ["status"]);
  return value.status === "saved"
    && hasOnlyKeys(value, ["status", "secret_ref"])
    && typeof value.secret_ref === "string"
    && /^(keychain|credential-manager|secret-service):[A-Za-z0-9._\-/]+$/.test(value.secret_ref)
    && value.secret_ref.length <= 256;
}

function isOnboardingState(value: unknown): value is DesktopOnboardingState {
  return isRecord(value)
    && hasOnlyKeys(value, ["version", "dismissed"])
    && value.version === 1
    && typeof value.dismissed === "boolean";
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
