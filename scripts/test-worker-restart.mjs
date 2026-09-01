import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { terminateProcessTree } = require("../electron/worker.cjs");
const executable = path.join(root, "dist-worker", process.platform === "win32" ? "noizzzy-worker.exe" : "noizzzy-worker");
if (!existsSync(executable)) throw new Error(`Packaged worker not found: ${executable}`);

const port = 35593;
const url = `http://127.0.0.1:${port}/health`;
const temporary = mkdtempSync(path.join(os.tmpdir(), "noizzzy-worker-restart-"));

function launch(label) {
  const child = spawn(executable, [], {
    cwd: temporary,
    env: {
      ...process.env,
      NOIZZZY_API_PORT: String(port),
      VOICE_DATA_DIR: path.join(temporary, `data-${label}`),
      VOICE_MODEL_DIR: path.join(temporary, "models"),
      PYTHONUTF8: "1"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-6000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-6000); });
  return { child, output: () => output };
}

async function waitForHealth(instance, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(750) });
      if (response.ok && (await response.json()).status === "ok") return;
    } catch {}
    if (instance.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Worker did not become healthy.\n${instance.output()}`);
}

async function waitForPortRelease(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Packaged worker did not release port ${port}`);
}

let active;
try {
  active = launch("first");
  await waitForHealth(active);
  await terminateProcessTree(active.child);
  await waitForPortRelease();

  active = launch("second");
  await waitForHealth(active);
  process.stdout.write("Packaged worker stopped cleanly and rebound its port after restart.\n");
} finally {
  if (active?.child?.exitCode === null) await terminateProcessTree(active.child).catch(() => {});
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
