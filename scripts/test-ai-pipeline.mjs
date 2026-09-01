import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { terminateProcessTree } = require("../electron/worker.cjs");
const ffmpeg = path.join(root, "build-tools", "media", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const ffprobe = path.join(root, "build-tools", "media", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
const worker = path.join(root, "dist-worker", process.platform === "win32" ? "noizzzy-worker.exe" : "noizzzy-worker");
const runtimeRoot = process.env.NOIZZZY_RUNTIME_ROOT || path.join(root, ".runtime", "runtime-validation", "ml-runtime");
const environmentBin = process.platform === "win32" ? "Scripts" : "bin";
const pythonName = process.platform === "win32" ? "python.exe" : "python";
const separatorPython = path.join(runtimeRoot, "separator", environmentBin, pythonName);
const enhancerPython = path.join(runtimeRoot, "enhancer", environmentBin, pythonName);

for (const required of [ffmpeg, ffprobe, worker, separatorPython, enhancerPython]) {
  if (!existsSync(required)) throw new Error(`AI integration prerequisite not found: ${required}`);
}

const temporary = mkdtempSync(path.join(os.tmpdir(), "noizzzy-ai-pipeline-"));
const input = process.env.NOIZZZY_AI_TEST_INPUT || path.join(temporary, "ai-smoke.mp4");
const modelDir = process.env.NOIZZZY_MODEL_DIR || path.join(temporary, "models");
const port = 35594;
const api = `http://127.0.0.1:${port}`;

if (!process.env.NOIZZZY_AI_TEST_INPUT) {
  const generated = spawnSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=2",
    "-filter_complex", "[1:a][2:a]amix=inputs=2:normalize=0[a]",
    "-map", "0:v:0", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast",
    "-c:a", "aac", "-shortest", input
  ], { stdio: "inherit" });
  if (generated.status !== 0) throw new Error("Could not generate the AI integration MP4");
}

const child = spawn(worker, [], {
  cwd: process.env.NOIZZZY_AI_WORKER_CWD || temporary,
  env: {
    ...process.env,
    NOIZZZY_API_PORT: String(port),
    VOICE_DATA_DIR: path.join(temporary, "data"),
    VOICE_MODEL_DIR: modelDir,
    VOICE_FFMPEG: ffmpeg,
    VOICE_FFPROBE: ffprobe,
    PATH: [path.dirname(ffmpeg), process.env.PATH].filter(Boolean).join(path.delimiter),
    VOICE_SEPARATOR_PYTHON: separatorPython,
    VOICE_SEPARATOR_RUNNER: path.join(root, "worker", "voice_worker", "separator_bridge.py"),
    VOICE_ENHANCER_PYTHON: enhancerPython,
    VOICE_ENHANCER_RUNNER: path.join(root, "worker", "voice_worker", "enhancer_bridge.py"),
    VOICE_SEPARATOR_DEVICE: process.platform === "win32" && process.env.NOIZZZY_AI_USE_CUDA === "1" ? "cuda" : "auto",
    HF_HOME: path.join(temporary, "cache", "huggingface"),
    TORCH_HOME: path.join(temporary, "cache", "torch"),
    XDG_CACHE_HOME: path.join(temporary, "cache"),
    PYTHONUTF8: "1"
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
child.stdout.on("data", (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-20000); });
child.stderr.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  output = `${output}${text}`.slice(-20000);
  process.stdout.write(text);
});

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${api}/health`, { signal: AbortSignal.timeout(750) });
      if (response.ok && (await response.json()).status === "ok") return;
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Packaged worker did not start.\n${output}`);
}

try {
  await waitForHealth();
  const form = new FormData();
  form.append("file", new Blob([readFileSync(input)], { type: "video/mp4" }), path.basename(input));
  form.append("profile", "streaming");
  form.append("separate_voice", "true");
  const created = await fetch(`${api}/api/jobs`, { method: "POST", body: form });
  if (!created.ok) throw new Error(`AI test upload failed: ${created.status} ${await created.text()}`);
  const job = await created.json();
  const deadline = Date.now() + 20 * 60 * 1000;
  let completed;
  let lastStage = "";
  while (Date.now() < deadline) {
    completed = await (await fetch(`${api}/api/jobs/${job.id}`)).json();
    if (completed.stage !== lastStage) {
      lastStage = completed.stage;
      process.stdout.write(`AI pipeline stage: ${lastStage} (${completed.progress})\n`);
    }
    if (["completed", "failed", "cancelled"].includes(completed.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (completed?.status !== "completed") {
    throw new Error(`Real AI processing failed: ${JSON.stringify(completed)}\n${output}`);
  }
  const kinds = new Set(completed.outputs?.map((item) => item.kind));
  for (const kind of ["audio", "instrumental", "video"]) {
    if (!kinds.has(kind)) throw new Error(`AI pipeline did not return the ${kind} output`);
  }
  for (const item of completed.outputs) {
    const response = await fetch(`${api}${item.url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok || bytes.byteLength < 1000) throw new Error(`Invalid ${item.kind} output`);
    if (item.kind === "video") {
      const destination = path.join(temporary, "verified-output.mp4");
      writeFileSync(destination, bytes);
      const inspected = spawnSync(ffprobe, [
        "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", destination
      ], { encoding: "utf8" });
      if (inspected.status !== 0 || !inspected.stdout.includes("video") || !inspected.stdout.includes("audio")) {
        throw new Error(`Remuxed MP4 is missing audio or video: ${inspected.stdout || inspected.stderr}`);
      }
    }
  }
  process.stdout.write("Packaged app completed real separation, restoration, mastering, and MP4 remux.\n");
} finally {
  await terminateProcessTree(child).catch(() => {});
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
