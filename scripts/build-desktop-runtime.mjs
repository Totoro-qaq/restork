#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const executableName = process.platform === "win32" ? "restorkd.exe" : "restorkd";
const outputDirectory = join(projectRoot, "dist", "desktop-runtime");
const bundledCargo = join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
const toolchainRoot = join(homedir(), ".rustup", "toolchains");
const toolchainCargo = existsSync(toolchainRoot)
  ? readdirSync(toolchainRoot)
    .filter((name) => name.startsWith("1.97.1-"))
    .map((name) => join(toolchainRoot, name, "bin", process.platform === "win32" ? "cargo.exe" : "cargo"))
    .find(existsSync)
  : undefined;
const cargo = process.env.CARGO
  || (existsSync(bundledCargo) ? bundledCargo : toolchainCargo)
  || "cargo";

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.platform === "win32" ? "npm.cmd" : "npm", [
  "--prefix",
  "dashboard",
  "run",
  "build",
]);
const cargoDirectory = dirname(cargo);
const cargoEnvironment = cargo === "cargo" ? process.env : {
  ...process.env,
  PATH: `${cargoDirectory}${delimiter}${process.env.PATH || ""}`,
  RUSTC: process.env.RUSTC || join(cargoDirectory, process.platform === "win32" ? "rustc.exe" : "rustc"),
};
run(cargo, [
  "build",
  "--manifest-path",
  join(projectRoot, "rust", "Cargo.toml"),
  "--release",
  "--locked",
  "-p",
  "restorkd",
], cargoEnvironment);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const source = join(projectRoot, "rust", "target", "release", executableName);
const destination = join(outputDirectory, executableName);
await copyFile(source, destination);
if (process.platform !== "win32") await chmod(destination, 0o755);
process.stdout.write(`${destination}\n`);
