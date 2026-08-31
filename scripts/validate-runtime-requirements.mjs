import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { enhancerRequirements, pythonVersion, separatorRequirements } = require("../electron/lib/platform.cjs");
const uv = path.join(root, "build-tools", process.platform === "win32" ? "uv.exe" : "uv");
if (!existsSync(uv)) throw new Error("Execute npm run tools:prepare antes da validação do runtime");

const validationRoot = path.join(root, ".runtime", "runtime-validation");
mkdirSync(validationRoot, { recursive: true });
const environment = {
  ...process.env,
  UV_CACHE_DIR: path.join(validationRoot, "cache"),
  UV_PYTHON_INSTALL_DIR: path.join(validationRoot, "python"),
  UV_PYTHON_PREFERENCE: "only-managed",
  UV_LINK_MODE: "copy"
};
const version = pythonVersion(process.platform, process.arch);

function run(args, label) {
  process.stdout.write(`${label}...\n`);
  const result = spawnSync(uv, args, { cwd: root, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} falhou (código ${result.status})`);
}

run(["python", "install", version], `Preparando Python ${version}`);
const separator = separatorRequirements({ platform: process.platform, arch: process.arch, hasNvidia: false });
const enhancer = enhancerRequirements({ platform: process.platform, arch: process.arch });
run([
  "pip", "install", "--dry-run", "--python", version,
  "--target", path.join(validationRoot, "separator"), ...separator
], "Resolvendo dependências do separador");
run([
  "pip", "install", "--dry-run", "--python", version,
  "--target", path.join(validationRoot, "enhancer"), ...enhancer
], "Resolvendo dependências do restaurador");
process.stdout.write(`Runtime resolvido para ${process.platform}/${process.arch}.\n`);
