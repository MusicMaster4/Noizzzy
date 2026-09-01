import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { RuntimeManager } = require("../electron/runtime.cjs");
const uv = path.join(root, "build-tools", process.platform === "win32" ? "uv.exe" : "uv");
if (!existsSync(uv)) throw new Error("Run npm run tools:prepare before validating the runtime");

const validationRoot = path.join(root, ".runtime", "runtime-validation");
rmSync(validationRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
mkdirSync(validationRoot, { recursive: true });

const logger = {
  info: (...values) => process.stdout.write(`${values.join(" ")}\n`),
  warn: (...values) => process.stderr.write(`${values.join(" ")}\n`),
  error: (...values) => process.stderr.write(`${values.join(" ")}\n`)
};

const runtime = new RuntimeManager({
  userData: validationRoot,
  resourcesPath: root,
  isPackaged: false,
  platform: process.platform,
  arch: process.arch,
  hasNvidia: false,
  logger
});

const status = await runtime.install();
if (!status.ready || !existsSync(runtime.paths.marker)) {
  throw new Error(`Runtime did not become ready: ${JSON.stringify(status)}`);
}
process.stdout.write(`Runtime installed and imported successfully for ${process.platform}/${process.arch}.\n`);
