"use strict";

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn, spawnSync } = require("node:child_process");

const API_PORT = 35592;
const API_URL = `http://127.0.0.1:${API_PORT}`;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminateProcessTree(child, { platform = process.platform, timeoutMs = 10000 } = {}) {
  if (!child || child.exitCode !== null) return;
  if (platform === "win32" && child.pid) {
    await new Promise((resolve, reject) => {
      execFile(
        "taskkill.exe",
        ["/pid", String(child.pid), "/t", "/f"],
        { windowsHide: true, timeout: timeoutMs },
        (error) => {
          if (error && child.exitCode === null) reject(error);
          else resolve();
        }
      );
    });
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      finish();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      finish();
    });
    child.kill("SIGTERM");
  });
}

function unpackedPath(value) {
  return value?.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function existing(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate));
}

function pathWithBundledMedia(ffmpeg, currentPath = process.env.PATH || "") {
  return [path.dirname(ffmpeg), currentPath].filter(Boolean).join(path.delimiter);
}

class WorkerManager extends EventEmitter {
  constructor({ app, runtime, logger }) {
    super();
    this.app = app;
    this.runtime = runtime;
    this.logger = logger;
    this.child = null;
    this.stopping = false;
    this.status = { ready: false, message: "Starting local processor", error: null };
  }

  snapshot() {
    return { ...this.status, url: API_URL };
  }

  update(changes) {
    this.status = { ...this.status, ...changes };
    this.emit("status", this.snapshot());
  }

  executable() {
    if (this.app.isPackaged) {
      return {
        command: path.join(process.resourcesPath, "worker", process.platform === "win32" ? "noizzzy-worker.exe" : "noizzzy-worker"),
        args: [],
        cwd: this.app.getPath("userData")
      };
    }
    const root = path.join(__dirname, "..");
    const configured = process.env.NOIZZZY_WORKER_PYTHON;
    const command = existing([
      configured,
      path.join(root, "worker", process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python")
    ]) || (process.platform === "win32" ? "python" : "python3");
    return { command, args: ["-m", "voice_worker.entrypoint"], cwd: path.join(root, "worker") };
  }

  environment() {
    const runtimeReady = this.runtime.snapshot().ready;
    const resourceScripts = this.app.isPackaged
      ? path.join(process.resourcesPath, "worker-scripts")
      : path.join(__dirname, "..", "worker", "voice_worker");
    const dataRoot = path.join(this.app.getPath("userData"), "data");
    const modelRoot = path.join(this.app.getPath("userData"), "models");
    const cacheRoot = path.join(this.app.getPath("userData"), "cache");
    const ffmpeg = this.app.isPackaged
      ? path.join(process.resourcesPath, "media", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")
      : unpackedPath(require("ffmpeg-static"));
    const ffprobe = this.app.isPackaged
      ? path.join(process.resourcesPath, "media", process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
      : unpackedPath(require("ffprobe-static").path);
    const environment = {
      ...process.env,
      PYTHONUTF8: "1",
      VOICE_DATA_DIR: dataRoot,
      VOICE_MODEL_DIR: modelRoot,
      VOICE_FFMPEG: ffmpeg,
      VOICE_FFPROBE: ffprobe,
      PATH: pathWithBundledMedia(ffmpeg),
      VOICE_CORS_ORIGINS: "null,http://127.0.0.1:27295,http://localhost:27295",
      VOICE_SEPARATOR_DEVICE: process.platform === "win32" && this.runtime.hasNvidia ? "cuda" : "auto",
      HF_HOME: path.join(cacheRoot, "huggingface"),
      TORCH_HOME: path.join(cacheRoot, "torch"),
      XDG_CACHE_HOME: cacheRoot,
      NOIZZZY_API_PORT: String(API_PORT)
    };
    if (runtimeReady) {
      environment.VOICE_SEPARATOR_PYTHON = this.runtime.paths.separatorPython;
      environment.VOICE_SEPARATOR_RUNNER = path.join(resourceScripts, "separator_bridge.py");
      environment.VOICE_ENHANCER_PYTHON = this.runtime.paths.enhancerPython;
      environment.VOICE_ENHANCER_RUNNER = path.join(resourceScripts, "enhancer_bridge.py");
    }
    return environment;
  }

  async start() {
    if (this.child) return this.waitUntilHealthy();
    const target = this.executable();
    this.stopping = false;
    this.update({ ready: false, message: "Starting local processor", error: null });
    this.logger.info(`Starting worker: ${target.command}`);
    const child = spawn(target.command, target.args, {
      cwd: target.cwd,
      env: this.environment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    child.stdout.on("data", (chunk) => this.logger.info(`[worker] ${chunk.toString("utf8").trimEnd()}`));
    child.stderr.on("data", (chunk) => this.logger.warn(`[worker] ${chunk.toString("utf8").trimEnd()}`));
    child.on("error", (reason) => {
      this.logger.error("Could not start worker", reason);
      this.update({ ready: false, message: "Local processor unavailable", error: reason.message });
    });
    child.on("exit", (code, signal) => {
      this.logger.info(`Worker exited: code=${code} signal=${signal}`);
      if (this.child === child) this.child = null;
      if (!this.stopping) this.update({ ready: false, message: "The local processor exited", error: `Code ${code ?? signal}` });
    });
    return this.waitUntilHealthy();
  }

  async waitUntilHealthy(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline && this.child) {
      try {
        const response = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(1200) });
        if (response.ok) {
          this.update({ ready: true, message: "Local processor ready", error: null });
          return this.snapshot();
        }
      } catch (reason) {
        lastError = reason;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const message = lastError instanceof Error ? lastError.message : "Timed out";
    this.update({ ready: false, message: "Local processor unavailable", error: message });
    throw new Error(message);
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  async waitUntilPortIsFree(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(500) });
      } catch {
        return;
      }
      await wait(100);
    }
    throw new Error(`Local processor did not release port ${API_PORT}`);
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.child = null;
    await terminateProcessTree(child);
    await this.waitUntilPortIsFree();
  }

  stopNow() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.child = null;
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    } else {
      child.kill("SIGTERM");
    }
  }
}

module.exports = {
  API_PORT,
  API_URL,
  WorkerManager,
  pathWithBundledMedia,
  terminateProcessTree,
  unpackedPath
};
