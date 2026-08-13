import { afterEach, describe, expect, it, vi } from "vitest";

import { bindDesktopExternalLinks, detectDesktopBridge } from "../src/desktop";

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
      if (command === "desktop_choose_workspace") {
        return {
          status: "selected",
          grant_id: "0123456789abcdef0123456789abcdef",
          label: "restork",
        } as T;
      }
      if (command === "desktop_import_skill_folder") {
        return {
          status: "selected",
          candidate_id: "a".repeat(32),
          label: "ppt-master",
          file_count: 2,
          total_bytes: 120,
        } as T;
      }
      if (command === "desktop_preview_skill_import") {
        return {
          preview_digest: "b".repeat(64),
          preview: {
            imported: [{ kind: "instructions", name: "SKILL.md", bytes: 54, sha256: "c".repeat(64) }],
            stripped: [{ kind: "script", name: "scripts/render.mjs", reason: "script_execution_unsupported" }],
            notice: "Scripts are not executed.",
            discourage: true,
          },
        } as T;
      }
      if (command === "desktop_install_skill_import") {
        return {
          status: "installed",
          package_id: "skill.ppt-master",
          state: "installed",
          manifest_hash: "d".repeat(64),
        } as T;
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
      if (command === "desktop_open_external") return undefined as T;
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
    await expect(bridge.chooseWorkspace()).resolves.toEqual({
      status: "selected",
      grantId: "0123456789abcdef0123456789abcdef",
      label: "restork",
    });
    await expect(bridge.importSkillFolder()).resolves.toEqual({
      status: "selected",
      candidateId: "a".repeat(32),
      label: "ppt-master",
      fileCount: 2,
      totalBytes: 120,
    });
    await expect(bridge.previewSkillImport("a".repeat(32))).resolves.toMatchObject({
      previewDigest: "b".repeat(64),
      preview: { discourage: true },
    });
    await expect(bridge.installSkillImport("a".repeat(32), "b".repeat(64))).resolves.toEqual({
      status: "installed",
      packageId: "skill.ppt-master",
      state: "installed",
      manifestHash: "d".repeat(64),
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
    await expect(bridge.openExternal("https://github.com/Totoro-qaq/restork"))
      .resolves.toBeUndefined();

    expect(invoke).toHaveBeenCalledWith("desktop_vault_config");
    expect(invoke).toHaveBeenCalledWith("desktop_choose_vault");
    expect(invoke).toHaveBeenCalledWith("desktop_apply_vault", {
      candidateId: "candidate-42",
    });
    expect(invoke).toHaveBeenCalledWith("desktop_choose_workspace");
    expect(invoke).toHaveBeenCalledWith("desktop_import_skill_folder");
    expect(invoke).toHaveBeenCalledWith("desktop_preview_skill_import", {
      candidateId: "a".repeat(32),
    });
    expect(invoke).toHaveBeenCalledWith("desktop_install_skill_import", {
      candidateId: "a".repeat(32),
      previewDigest: "b".repeat(64),
    });
    expect(invoke).toHaveBeenCalledWith("desktop_configure_provider_secret", {
      providerKind: "deepseek",
    });
    expect(invoke).toHaveBeenCalledWith("desktop_onboarding_state");
    expect(invoke).toHaveBeenCalledWith("desktop_set_onboarding_dismissed", { dismissed: true });
    expect(invoke).toHaveBeenCalledWith("desktop_open_external", {
      url: "https://github.com/Totoro-qaq/restork",
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("/Users/");
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("sk-test-secret");
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("Write slides");
  });

  it("opens public links in the system browser only in the desktop shell", async () => {
    const openExternal = vi.fn(async () => undefined);
    const root = document.createElement("main");
    root.innerHTML = `
      <a id="public" href="https://github.com/Graphify-Labs/graphify" target="_blank">Graphify</a>
      <a id="local" href="http://127.0.0.1:49152/v1/health">Local</a>`;
    const bridge = { openExternal } as unknown as ReturnType<typeof detectDesktopBridge>;
    if (!bridge) throw new Error("desktop bridge");

    bindDesktopExternalLinks(root, bridge);
    root.querySelector<HTMLAnchorElement>("#public")?.click();
    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith("https://github.com/Graphify-Labs/graphify");
    });

    const local = root.querySelector<HTMLAnchorElement>("#local");
    local?.addEventListener("click", (event) => event.preventDefault());
    local?.click();
    expect(openExternal).toHaveBeenCalledTimes(1);
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
