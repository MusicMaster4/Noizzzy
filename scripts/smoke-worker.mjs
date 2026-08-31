import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static");
const ffprobe = require("ffprobe-static").path;
const executable = path.join(root, "dist-worker", process.platform === "win32" ? "noizzzy-worker.exe" : "noizzzy-worker");
if (!existsSync(executable)) throw new Error(`Worker empacotado não encontrado: ${executable}`);

const temporary = mkdtempSync(path.join(os.tmpdir(), "noizzzy-worker-smoke-"));
const child = spawn(executable, [], {
  cwd: temporary,
  env: {
    ...process.env,
    NOIZZZY_API_PORT: "35592",
    VOICE_DATA_DIR: path.join(temporary, "data"),
    VOICE_MODEL_DIR: path.join(temporary, "models"),
    VOICE_FFMPEG: ffmpeg,
    VOICE_FFPROBE: ffprobe,
    PYTHONUTF8: "1"
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });

try {
  const deadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:35592/health", { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).status === "ok") {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!healthy) throw new Error(`Worker não respondeu ao health check.\n${output.slice(-6000)}`);
  const input = path.join(temporary, "smoke.wav");
  const generated = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", input], { stdio: "inherit" });
  if (generated.status !== 0) throw new Error("Não foi possível gerar o áudio do smoke test");
  const form = new FormData();
  form.append("file", new Blob([readFileSync(input)], { type: "audio/wav" }), "smoke.wav");
  form.append("profile", "streaming");
  form.append("separate_voice", "false");
  const created = await fetch("http://127.0.0.1:35592/api/jobs", { method: "POST", body: form });
  if (!created.ok) throw new Error(`A API recusou o áudio do smoke test: ${created.status} ${await created.text()}`);
  const job = await created.json();
  const processDeadline = Date.now() + 30000;
  let completed = null;
  while (Date.now() < processDeadline) {
    const response = await fetch(`http://127.0.0.1:35592/api/jobs/${job.id}`);
    completed = await response.json();
    if (["completed", "failed", "cancelled"].includes(completed.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (completed?.status !== "completed" || !completed.outputs?.length) {
    throw new Error(`Processamento smoke falhou: ${JSON.stringify(completed)}\n${output.slice(-6000)}`);
  }
  const result = await fetch(`http://127.0.0.1:35592${completed.outputs[0].url}`);
  if (!result.ok || (await result.arrayBuffer()).byteLength < 1000) throw new Error("O worker não entregou o WAV final");
  process.stdout.write("Worker empacotado processou e entregou um WAV de ponta a ponta.\n");
} finally {
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
  if (child.exitCode === null && process.platform !== "win32") child.kill("SIGKILL");
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
