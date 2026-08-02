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

    expect(invoke).toHaveBeenLastCalledWith("desktop_store_session", {
      session: {
        accessToken: "replacement-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    });
  });
});
