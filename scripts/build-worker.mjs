import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localPython = path.join(root, "worker", process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const python = process.env.NOIZZZY_BUILD_PYTHON || (existsSync(localPython) ? localPython : process.platform === "win32" ? "python" : "python3");
const work = path.join(root, ".runtime", "pyinstaller");
const dist = path.join(root, "dist-worker");

if (existsSync(work)) rmSync(work, { recursive: true, force: true });
if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(dist, { recursive: true });

const args = [
  "-m", "PyInstaller",
  path.join(root, "worker", "voice_worker", "entrypoint.py"),
  "--name", "noizzzy-worker",
  "--onefile",
  "--clean",
  "--noconfirm",
  "--paths", path.join(root, "worker"),
  "--distpath", dist,
  "--workpath", path.join(work, "build"),
  "--specpath", work,
  "--collect-submodules", "uvicorn",
  "--collect-submodules", "pydantic_settings"
];

const result = spawnSync(python, args, { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
