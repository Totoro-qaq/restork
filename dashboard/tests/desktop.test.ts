import { afterEach, describe, expect, it, vi } from "vitest";

import { detectDesktopBridge } from "../src/desktop";

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__TAURI__;
});

describe("desktop session bridge", () => {
  it("stays disabled in an ordinary browser", () => {
    expect(detectDesktopBridge()).toBeNull();
  });

  it("restores and updates a native in-memory session on the exact loopback host", async () => {
    const invoke = vi.fn(async function invoke<T>(command: string): Promise<T> {
      if (command === "desktop_session") {
        return {
          kind: "token",
          access_token: "desktop-token",
          expires_at: "2099-01-01T00:00:00Z",
        } as T;
      }
      if (command === "desktop_update_recovery") {
        return [{
          version: "0.1.3",
          target: "darwin-aarch64",
          filename: "/private/recovery/Restork.app.tar.gz",
          sha256: "a".repeat(64),
          verified_at_unix: 1785700000,
        }] as T;
      }
      return undefined as T;
    });

    const bridge = detectDesktopBridge(
      { protocol: "http:", hostname: "127.0.0.1", port: "49152" },
      {
        core: {
          invoke: invoke as unknown as <T>(
            command: string,
            args?: Record<string, unknown>,
          ) => Promise<T>,
        },
      },
    );
    expect(bridge).not.toBeNull();
    await expect(bridge?.session()).resolves.toEqual({
      kind: "token",
      access_token: "desktop-token",
      expires_at: "2099-01-01T00:00:00Z",
    });
    await bridge?.store({ accessToken: "replacement-token", expiresAt: "2099-01-01T00:00:00.000Z" });
    await expect(bridge?.recovery()).resolves.toEqual([
      expect.objectContaining({ version: "0.1.3", target: "darwin-aarch64" }),
    ]);

    expect(invoke).toHaveBeenCalledWith("desktop_store_session", {
      session: {
        accessToken: "replacement-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    });
    expect(invoke).toHaveBeenLastCalledWith("desktop_update_recovery");
  });

  it("keeps vault paths and API keys behind narrow native commands", async () => {
    const invoke = vi.fn(async function invoke<T>(
      command: string,
    ): Promise<T> {
      if (command === "desktop_vault_config") {
        return {
          status: "configured",
          grant_id: "vault-7ee0fca2",
          label: "Research Notes",
          mutable: true,
        } as T;
      }
      if (command === "desktop_choose_vault") {
        return {
          status: "selected",
          candidate_id: "candidate-42",
          label: "Work Notes",
          same_as_active: false,
        } as T;
      }
      if (command === "desktop_apply_vault") {
        return { status: "switching", label: "Work Notes" } as T;
      }
      if (command === "desktop_configure_provider_secret") {
        return {
          status: "saved",
          secret_ref: "keychain:restork/provider/deepseek",
        } as T;
      }
      if (command === "desktop_onboarding_state") {
        return { version: 1, dismissed: false } as T;
      }
      if (command === "desktop_set_onboarding_dismissed") {
        return { version: 1, dismissed: true } as T;
      }
      return undefined as T;
    });
    const bridge = detectDesktopBridge(
      { protocol: "http:", hostname: "127.0.0.1", port: "49152" },
      {
        core: {
          invoke: invoke as unknown as <T>(
            command: string,
            args?: Record<string, unknown>,
          ) => Promise<T>,
        },
      },
    );
    if (!bridge) throw new Error("desktop bridge");

    await expect(bridge.vaultConfig()).resolves.toEqual({
      status: "configured",
      grantId: "vault-7ee0fca2",
      label: "Research Notes",
      mutable: true,
    });
    await expect(bridge.chooseVault()).resolves.toEqual({
      status: "selected",
      candidateId: "candidate-42",
      label: "Work Notes",
      sameAsActive: false,
    });
    await expect(bridge.applyVault("candidate-42")).resolves.toEqual({
      status: "switching",
      label: "Work Notes",
    });
    await expect(bridge.configureProviderSecret("deepseek")).resolves.toEqual({
      status: "saved",
      secretRef: "keychain:restork/provider/deepseek",
    });
    await expect(bridge.onboardingState()).resolves.toEqual({ version: 1, dismissed: false });
    await expect(bridge.setOnboardingDismissed(true)).resolves.toEqual({
      version: 1,
      dismissed: true,
    });

    expect(invoke).toHaveBeenCalledWith("desktop_vault_config");
    expect(invoke).toHaveBeenCalledWith("desktop_choose_vault");
    expect(invoke).toHaveBeenCalledWith("desktop_apply_vault", {
      candidateId: "candidate-42",
    });
    expect(invoke).toHaveBeenCalledWith("desktop_configure_provider_secret", {
      providerKind: "deepseek",
    });
    expect(invoke).toHaveBeenCalledWith("desktop_onboarding_state");
    expect(invoke).toHaveBeenCalledWith("desktop_set_onboarding_dismissed", { dismissed: true });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("/Users/");
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("sk-test-secret");
  });

  it("rejects native setup responses that expose paths or secret values", async () => {
    const invoke = vi.fn(async function invoke<T>(command: string): Promise<T> {
      if (command === "desktop_vault_config") {
        return {
          status: "configured",
          grant_id: "vault-7ee0fca2",
          label: "Research Notes",
          mutable: true,
          path: "/synthetic-private-fixtures/vault",
        } as T;
      }
      return {
        status: "saved",
        secret_ref: "keychain:restork/provider/deepseek",
        api_key: "sk-test-secret",
      } as T;
    });
    const bridge = detectDesktopBridge(
      { protocol: "http:", hostname: "127.0.0.1", port: "49152" },
      {
        core: {
          invoke: invoke as unknown as <T>(
            command: string,
            args?: Record<string, unknown>,
          ) => Promise<T>,
        },
      },
    );
    if (!bridge) throw new Error("desktop bridge");

    await expect(bridge.vaultConfig()).rejects.toThrow("invalid response");
    await expect(bridge.configureProviderSecret("deepseek"))
      .rejects.toThrow("invalid response");
  });
});
