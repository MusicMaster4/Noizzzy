"use strict";

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  ML_VERSIONS,
  RUNTIME_SCHEMA,
  enhancerRequirements,
  pythonVersion,
  runtimeIsReady,
  runtimePaths,
  separatorRequirements
} = require("./lib/platform.cjs");

class RuntimeManager extends EventEmitter {
  constructor({ userData, resourcesPath, isPackaged, platform, arch, hasNvidia, logger }) {
    super();
    this.platform = platform;
    this.arch = arch;
    this.hasNvidia = hasNvidia;
    this.logger = logger;
    this.resourcesPath = resourcesPath;
    this.isPackaged = isPackaged;
    this.paths = runtimePaths(userData, platform);
    this.installPromise = null;
    this.status = {
      ready: runtimeIsReady(this.paths),
      installing: false,
      progress: runtimeIsReady(this.paths) ? 100 : 0,
      message: runtimeIsReady(this.paths) ? "AI models ready" : "AI models not installed yet",
      error: null
    };
  }

  snapshot() {
    return { ...this.status };
  }

  update(changes) {
    this.status = { ...this.status, ...changes };
    this.emit("status", this.snapshot());
  }

  uvExecutable() {
    const filename = this.platform === "win32" ? "uv.exe" : "uv";
    const packaged = path.join(this.resourcesPath, "tools", filename);
    const development = path.join(__dirname, "..", "build-tools", filename);
    if (fs.existsSync(packaged)) return packaged;
    if (!this.isPackaged && fs.existsSync(development)) return development;
    return filename;
  }

  async runUv(args, label, progress) {
    this.update({ message: label, progress });
    const environment = {
      ...process.env,
      UV_CACHE_DIR: this.paths.uvCache,
      UV_PYTHON_INSTALL_DIR: this.paths.pythonRoot,
      UV_PYTHON_PREFERENCE: "only-managed",
      UV_LINK_MODE: "copy",
      PYTHONUTF8: "1"
    };
    await new Promise((resolve, reject) => {
      const child = spawn(this.uvExecutable(), args, {
        env: environment,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let detail = "";
      const collect = (chunk) => {
        const text = chunk.toString("utf8");
        detail = `${detail}${text}`.slice(-12000);
        this.logger.info(`[uv] ${text.trimEnd()}`);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${label} failed (exit code ${code}). ${detail.trim().split("\n").slice(-4).join(" ")}`));
      });
    });
  }

  async runPython(executable, code, label, progress) {
    this.update({ message: label, progress });
    await new Promise((resolve, reject) => {
      const child = spawn(executable, ["-c", code], {
        env: { ...process.env, PYTHONUTF8: "1" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let detail = "";
      const collect = (chunk) => {
        const text = chunk.toString("utf8");
        detail = `${detail}${text}`.slice(-12000);
        this.logger.info(`[runtime-check] ${text.trimEnd()}`);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${label} failed (exit code ${code}). ${detail.trim().split("\n").slice(-4).join(" ")}`));
      });
    });
  }

  async cleanupInstallCache() {
    try {
      await fs.promises.rm(this.paths.uvCache, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      this.logger.info(`Removed runtime installation cache: ${this.paths.uvCache}`);
    } catch (reason) {
      this.logger.warn("Could not remove runtime installation cache", reason);
    }
  }

  async install() {
    if (this.status.ready) return this.snapshot();
    if (this.installPromise) return this.installPromise;
    this.installPromise = this.performInstall().finally(() => {
      this.installPromise = null;
    });
    return this.installPromise;
  }

  async performInstall() {
    fs.mkdirSync(this.paths.root, { recursive: true });
    this.update({ installing: true, error: null, message: "Preparing local runtime", progress: 2 });
    try {
      const version = pythonVersion(this.platform, this.arch);
      await this.runUv(["python", "install", version], `Installing Python ${version}`, 8);
      await this.runUv(["venv", "--clear", "--python", version, this.paths.separatorEnvironment], "Creating separator environment", 18);

      const separator = separatorRequirements({ platform: this.platform, arch: this.arch, hasNvidia: this.hasNvidia });
      if (this.platform === "win32") {
        const torchArgs = [
          "pip", "install", "--python", this.paths.separatorPython,
          `torch==${ML_VERSIONS.torch}`, `torchvision==${ML_VERSIONS.torchvision}`,
          `torchaudio==${ML_VERSIONS.torchaudio}`
        ];
        if (this.hasNvidia) torchArgs.push("--index-url", "https://download.pytorch.org/whl/cu128");
        await this.runUv(torchArgs, this.hasNvidia ? "Installing CUDA acceleration" : "Installing PyTorch for CPU", 28);
      }
      await this.runUv(["pip", "install", "--python", this.paths.separatorPython, ...separator], "Installing neural separation", 48);

      await this.runUv(["venv", "--clear", "--python", version, this.paths.enhancerEnvironment], "Creating restoration environment", 58);
      if (this.platform === "win32") {
        const torchArgs = [
          "pip", "install", "--python", this.paths.enhancerPython,
          `torch==${ML_VERSIONS.torch}`, `torchvision==${ML_VERSIONS.torchvision}`,
          `torchaudio==${ML_VERSIONS.torchaudio}`
        ];
        if (this.hasNvidia) torchArgs.push("--index-url", "https://download.pytorch.org/whl/cu128");
        await this.runUv(torchArgs, this.hasNvidia ? "Preparing CUDA restoration" : "Preparing CPU restoration", 68);
      }
      await this.runUv(
        ["pip", "install", "--python", this.paths.enhancerPython, ...enhancerRequirements({ platform: this.platform, arch: this.arch })],
        "Installing voice restoration",
        84
      );

      await this.runUv(["pip", "check", "--python", this.paths.separatorPython], "Validating separator", 91);
      await this.runUv(["pip", "check", "--python", this.paths.enhancerPython], "Validating restorer", 96);
      await this.runPython(
        this.paths.separatorPython,
        "import torch; from audio_separator.separator import Separator; print(torch.__version__, Separator.__name__)",
        "Loading neural separator",
        97
      );
      await this.runPython(
        this.paths.enhancerPython,
        "import torch; from clearvoice import ClearVoice; print(torch.__version__, ClearVoice.__name__)",
        "Loading voice restorer",
        98
      );

      fs.writeFileSync(this.paths.marker, JSON.stringify({
        schema: RUNTIME_SCHEMA,
        versions: ML_VERSIONS,
        platform: this.platform,
        arch: this.arch,
        acceleration: this.hasNvidia ? "cuda" : this.platform === "darwin" && this.arch === "arm64" ? "mps-cpu" : "cpu",
        installedAt: new Date().toISOString()
      }, null, 2));
      this.update({ message: "Cleaning installation cache", progress: 99 });
      await this.cleanupInstallCache();
      this.update({ ready: true, installing: false, progress: 100, message: "AI models ready", error: null });
      return this.snapshot();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      this.logger.error("Failed to install AI runtime", reason);
      this.update({ ready: false, installing: false, message: "Model installation failed", error: message });
      throw reason;
    }
  }
}

module.exports = { RuntimeManager };
