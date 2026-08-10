import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectWindowsToolchain,
  requireWindowsMsvc,
  windowsToolchainHelp,
} from "../windows-toolchain.mjs";

test("accepts the supported Windows MSVC host", () => {
  assert.deepEqual(
    inspectWindowsToolchain({
      rustcVerbose: "rustc 1.97.1\nhost: x86_64-pc-windows-msvc\n",
    }),
    {
      ok: true,
      host: "x86_64-pc-windows-msvc",
      configuredTarget: "",
      reason: "ready",
    },
  );
});

test("rejects the GNU host before the build starts", () => {
  const status = inspectWindowsToolchain({
    rustcVerbose: "rustc 1.97.1\nhost: x86_64-pc-windows-gnu\n",
  });
  assert.equal(status.ok, false);
  assert.equal(status.reason, "rust_host_is_not_msvc");
  assert.match(windowsToolchainHelp(status), /Do not install as\.exe, dlltool/u);
  assert.match(windowsToolchainHelp(status), /不要继续安装/u);
});

test("rejects a GNU CARGO_BUILD_TARGET even with an MSVC default host", () => {
  const status = inspectWindowsToolchain({
    rustcVerbose: "host: x86_64-pc-windows-msvc\n",
    cargoBuildTarget: "x86_64-pc-windows-gnu",
  });
  assert.equal(status.ok, false);
  assert.equal(status.reason, "cargo_build_target_is_gnu");
});

test("the executable guard is a no-op off Windows", () => {
  assert.doesNotThrow(() => requireWindowsMsvc({
    platform: "linux",
    runRustc: () => {
      throw new Error("must not run");
    },
  }));
});

test("the executable guard reports actionable commands on Windows GNU", () => {
  assert.throws(
    () => requireWindowsMsvc({
      platform: "win32",
      environment: {},
      runRustc: () => ({
        status: 0,
        stdout: "host: x86_64-pc-windows-gnu\n",
      }),
    }),
    /rustup default 1\.97\.1-x86_64-pc-windows-msvc/u,
  );
});
