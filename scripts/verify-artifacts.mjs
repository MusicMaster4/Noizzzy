import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "release");
if (!existsSync(release)) throw new Error("A pasta release não foi criada");

function walk(directory) {
  const values = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) values.push(...walk(candidate));
    else values.push(candidate);
  }
  return values;
}

const files = walk(release);
const expectedExtensions = process.platform === "win32" ? [".exe"] : [".dmg", ".zip"];
for (const extension of expectedExtensions) {
  const artifact = files.find((file) => file.toLowerCase().endsWith(extension));
  if (!artifact || statSync(artifact).size < 1024 * 1024) throw new Error(`Artefato ${extension} ausente ou inválido`);
}
const worker = files.find((file) => /resources[\\/]worker[\\/]noizzzy-worker(?:\.exe)?$/i.test(file));
const uv = files.find((file) => /resources[\\/]tools[\\/]uv(?:\.exe)?$/i.test(file));
const ffmpeg = files.find((file) => /resources[\\/]media[\\/]ffmpeg(?:\.exe)?$/i.test(file));
const ffprobe = files.find((file) => /resources[\\/]media[\\/]ffprobe(?:\.exe)?$/i.test(file));
if (!worker || statSync(worker).size < 1024 * 1024) throw new Error("Sidecar do worker não foi incluído no app");
if (!uv || statSync(uv).size < 1024 * 1024) throw new Error("Gerenciador uv não foi incluído no app");
if (!ffmpeg || statSync(ffmpeg).size < 1024 * 1024) throw new Error("FFmpeg nativo não foi incluído no app");
if (!ffprobe || statSync(ffprobe).size < 1024 * 1024) throw new Error("FFprobe nativo não foi incluído no app");
if (process.platform === "darwin") {
  const appExecutable = files.find((file) => file.endsWith(`${path.sep}Noizzzy.app${path.sep}Contents${path.sep}MacOS${path.sep}Noizzzy`));
  const expected = process.arch === "arm64" ? "arm64" : "x86_64";
  for (const binary of [appExecutable, worker, uv, ffmpeg, ffprobe]) {
    if (!binary) throw new Error("Binário macOS ausente na verificação de arquitetura");
    const inspected = spawnSync("file", [binary], { encoding: "utf8" });
    if (inspected.status !== 0 || !inspected.stdout.includes(expected)) {
      throw new Error(`Arquitetura incorreta para ${binary}: ${inspected.stdout || inspected.stderr}`);
    }
  }
}
process.stdout.write(`Artefatos verificados (${files.length} arquivos).\n`);
