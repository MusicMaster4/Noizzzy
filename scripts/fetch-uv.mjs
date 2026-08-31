import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, chmodSync, copyFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const UV_VERSION = "0.11.28";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tools = path.join(root, "build-tools");
const runtime = path.join(root, ".runtime", "uv-download");
const executableName = process.platform === "win32" ? "uv.exe" : "uv";
const destination = path.join(tools, executableName);

const targets = {
  "win32:x64": "x86_64-pc-windows-msvc",
  "darwin:x64": "x86_64-apple-darwin",
  "darwin:arm64": "aarch64-apple-darwin"
};
const target = targets[`${process.platform}:${process.arch}`];
if (!target) throw new Error(`Plataforma sem binário uv configurado: ${process.platform}/${process.arch}`);

if (existsSync(destination) && !process.env.NOIZZZY_REFRESH_UV) {
  process.stdout.write(`uv já preparado em ${destination}\n`);
  process.exit(0);
}

if (existsSync(runtime)) rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });
mkdirSync(tools, { recursive: true });

const extension = process.platform === "win32" ? "zip" : "tar.gz";
const archive = path.join(runtime, `uv.${extension}`);
const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}.${extension}`;
const response = await fetch(url, { redirect: "follow" });
if (!response.ok || !response.body) throw new Error(`Falha ao baixar uv ${UV_VERSION}: HTTP ${response.status}`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));

const extraction = spawnSync("tar", ["-xf", archive, "-C", runtime], { stdio: "inherit" });
if (extraction.error) throw extraction.error;
if (extraction.status !== 0) throw new Error(`Não foi possível extrair o pacote uv (código ${extraction.status})`);

function find(directory, filename) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) return candidate;
    if (entry.isDirectory()) {
      const nested = find(candidate, filename);
      if (nested) return nested;
    }
  }
  return null;
}

const extracted = find(runtime, executableName);
if (!extracted) throw new Error(`O arquivo ${executableName} não foi encontrado no pacote uv`);
copyFileSync(extracted, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);
process.stdout.write(`uv ${UV_VERSION} preparado para ${target}\n`);
