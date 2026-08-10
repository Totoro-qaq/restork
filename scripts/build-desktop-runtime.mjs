#!/usr/bin/env node

import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requireWindowsMsvc } from "./windows-toolchain.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const executableName = process.platform === "win32" ? "restorkd.exe" : "restorkd";
const outputDirectory = join(projectRoot, "dist", "desktop-runtime");

try {
  requireWindowsMsvc();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

if (process.env.RESTORK_DESKTOP_RUNTIME_READY === "1") {
  const frozenCore = join(outputDirectory, executableName);
  const embeddedDashboard = join(projectRoot, "rust", "crates", "restork-api", "web", "index.html");
  if (!existsSync(frozenCore) || !existsSync(embeddedDashboard)) {
    process.stderr.write(
      "RESTORK_DESKTOP_RUNTIME_READY was set, but the frozen Core or Dashboard is missing.\n",
    );
    process.exit(2);
  }
  process.stdout.write(`Reusing verified desktop runtime: ${frozenCore}\n`);
  process.exit(0);
}

function run(command, args, environment = process.env, workingDirectory = projectRoot) {
  const result = spawnSync(command, args, {
    cwd: workingDirectory,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform === "win32") {
  // Windows cannot execute a .cmd shim directly without cmd.exe. The command
  // is deliberately constant: no path, model, or user input reaches the shell.
  run("cmd.exe", [
    "/d",
    "/s",
    "/c",
    "npm --prefix dashboard run build",
  ]);
} else {
  run("npm", ["--prefix", "dashboard", "run", "build"]);
}
run("cargo", [
  "build",
  "--manifest-path",
  join(projectRoot, "rust", "Cargo.toml"),
  "--release",
  "--locked",
  "-p",
  "restorkd",
], process.env, join(projectRoot, "rust"));

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const source = join(projectRoot, "rust", "target", "release", executableName);
const destination = join(outputDirectory, executableName);
await copyFile(source, destination);
if (process.platform !== "win32") await chmod(destination, 0o755);
process.stdout.write(`${destination}\n`);
