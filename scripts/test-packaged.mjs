import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const release = path.join(root, "release");

function findExecutable(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && (
      process.platform === "win32" && entry.name === "Noizzzy.exe"
      || process.platform === "darwin" && entry.name === "Noizzzy" && candidate.includes(".app/Contents/MacOS".replaceAll("/", path.sep))
    )) return candidate;
    if (entry.isDirectory()) {
      const nested = findExecutable(candidate);
      if (nested) return nested;
    }
  }
  return null;
}

if (!existsSync(release)) throw new Error("A pasta release não existe");
const executable = findExecutable(release);
if (!executable) throw new Error("O executável empacotado do Noizzzy não foi encontrado");
const result = spawnSync(process.execPath, [require.resolve("@playwright/test/cli"), "test"], {
  cwd: root,
  env: { ...process.env, NOIZZZY_PACKAGED_EXECUTABLE: executable },
  stdio: "inherit"
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
