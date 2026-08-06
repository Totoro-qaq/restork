#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const executableName = process.platform === "win32" ? "restorkd.exe" : "restorkd";
const coreBinary = join(projectRoot, "dist", "desktop-runtime", executableName);

if (!existsSync(coreBinary)) {
  process.stderr.write(`Frozen Core is missing: ${coreBinary}\n`);
  process.exit(2);
}

const smokeRoot = await mkdtemp(join(projectRoot, ".restork-core-smoke-"));
const configDirectory = join(smokeRoot, "config");
const dataDirectory = join(smokeRoot, "data");
const cacheDirectory = join(smokeRoot, "cache");
await Promise.all([
  mkdir(configDirectory, { recursive: true, mode: 0o700 }),
  mkdir(dataDirectory, { recursive: true, mode: 0o700 }),
  mkdir(cacheDirectory, { recursive: true, mode: 0o700 }),
]);

const child = spawn(coreBinary, [
  "--json",
  "serve",
  "--port",
  "0",
  "--state-db",
  join(dataDirectory, "restork.db"),
], {
  env: {
    RESTORK_CONFIG_DIR: configDirectory,
    RESTORK_DATA_DIR: dataDirectory,
    RESTORK_CACHE_DIR: cacheDirectory,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  if (stderr.length < 16_384) stderr += chunk;
});

const timeout = AbortSignal.timeout(10_000);

try {
  const ready = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const fail = () => reject(new Error("Core exited before readiness"));
    child.once("exit", fail);
    timeout.addEventListener("abort", () => reject(new Error("Core readiness timed out")), {
      once: true,
    });
    lines.once("line", (line) => {
      child.off("exit", fail);
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error("Core readiness record was not JSON"));
      }
    });
  });
  if (
    ready.event !== "ready"
    || ready.schema !== "v1"
    || ready.pid !== child.pid
    || !Number.isInteger(ready.port)
    || ready.port < 1
    || ready.port > 65_535
    || ready.base_url !== `http://127.0.0.1:${ready.port}`
    || typeof ready.pairing_code !== "string"
    || ready.pairing_code.length < 16
  ) {
    throw new Error("Core readiness contract was invalid");
  }
  const response = await fetch(`${ready.base_url}/v1/readiness`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: timeout,
  });
  const health = await response.json();
  if (!response.ok || health.status !== "ready" || health.schema !== "v1") {
    throw new Error("Core readiness endpoint failed");
  }
  process.stdout.write("Cross-platform Rust desktop runtime smoke test passed.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (stderr) process.stderr.write(stderr.slice(-4_096));
  process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", resolve);
  });
  await rm(smokeRoot, { recursive: true, force: true });
}
