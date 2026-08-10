#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const WINDOWS_MSVC_HOST = /^(?:x86_64|aarch64)-pc-windows-msvc$/u;
const WINDOWS_GNU_TARGET = /(?:pc-windows-gnu|pc-windows-gnullvm)/iu;

export function inspectWindowsToolchain({ rustcVerbose, cargoBuildTarget = "" }) {
  const host = rustcVerbose
    .split(/\r?\n/u)
    .find((line) => line.startsWith("host: "))
    ?.slice("host: ".length)
    .trim() ?? "";
  const configuredTarget = cargoBuildTarget.trim();
  const targetLooksGnu = WINDOWS_GNU_TARGET.test(configuredTarget);
  const hostIsMsvc = WINDOWS_MSVC_HOST.test(host);

  return {
    ok: hostIsMsvc && !targetLooksGnu,
    host,
    configuredTarget,
    reason: targetLooksGnu
      ? "cargo_build_target_is_gnu"
      : hostIsMsvc
        ? "ready"
        : host
          ? "rust_host_is_not_msvc"
          : "rust_host_missing",
  };
}

export function windowsToolchainHelp(status) {
  const detected = status.configuredTarget
    ? `CARGO_BUILD_TARGET=${status.configuredTarget}`
    : status.host
      ? `Rust host=${status.host}`
      : "Rust host=unknown";
  return [
    "Restork stopped before compiling because Windows is not using the MSVC Rust toolchain.",
    "Restork 已在编译前停止：Windows 当前没有使用 MSVC Rust 工具链。",
    `Detected / 检测到：${detected}`,
    "Do not install as.exe, dlltool, MinGW, or the GNU Rust target for Restork.",
    "不要继续安装 as.exe、dlltool、MinGW 或 Rust GNU target。",
    "Run these commands in PowerShell, then open a new terminal:",
    "请在 PowerShell 执行以下命令，然后重新打开终端：",
    "  rustup toolchain install 1.97.1-x86_64-pc-windows-msvc --profile minimal",
    "  rustup default 1.97.1-x86_64-pc-windows-msvc",
    "  rustup override unset",
    "  Remove-Item Env:CARGO_BUILD_TARGET -ErrorAction SilentlyContinue",
    "Ordinary users should download the prebuilt MSI or EXE instead of building from source.",
    "普通用户应下载预编译 MSI 或 EXE，不需要安装任何编译工具。",
  ].join("\n");
}

export function requireWindowsMsvc({
  platform = process.platform,
  environment = process.env,
  runRustc = () => spawnSync("rustc", ["-vV"], { encoding: "utf8", windowsHide: true }),
} = {}) {
  if (platform !== "win32") return;

  const result = runRustc();
  if (result.error) {
    throw new Error(
      "Rust is unavailable. Install rustup with the x86_64-pc-windows-msvc toolchain before building Restork.\n"
      + "未找到 Rust。请先通过 rustup 安装 x86_64-pc-windows-msvc 工具链。",
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new Error(
      "rustc -vV failed; repair the MSVC Rust toolchain before building Restork.\n"
      + "rustc -vV 执行失败，请先修复 MSVC Rust 工具链。",
    );
  }

  const status = inspectWindowsToolchain({
    rustcVerbose: result.stdout ?? "",
    cargoBuildTarget: environment.CARGO_BUILD_TARGET ?? "",
  });
  if (!status.ok) throw new Error(windowsToolchainHelp(status));
}

function main() {
  try {
    requireWindowsMsvc();
    if (process.platform === "win32") {
      process.stdout.write("Windows MSVC Rust toolchain is ready.\n");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
