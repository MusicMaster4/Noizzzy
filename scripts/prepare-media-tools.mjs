import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ffmpegSource = require("ffmpeg-static");
const ffprobeSource = require("ffprobe-static").path;
if (!ffmpegSource || !existsSync(ffmpegSource)) throw new Error("FFmpeg nativo não foi instalado");
if (!ffprobeSource || !existsSync(ffprobeSource)) throw new Error("FFprobe nativo não foi instalado");

const media = path.join(root, "build-tools", "media");
mkdirSync(media, { recursive: true });
const extension = process.platform === "win32" ? ".exe" : "";
const ffmpegDestination = path.join(media, `ffmpeg${extension}`);
const ffprobeDestination = path.join(media, `ffprobe${extension}`);
copyFileSync(ffmpegSource, ffmpegDestination);
copyFileSync(ffprobeSource, ffprobeDestination);

const ffmpegLicense = `${ffmpegSource}.LICENSE`;
if (existsSync(ffmpegLicense)) copyFileSync(ffmpegLicense, path.join(media, "FFMPEG-LICENSE.txt"));
const ffprobeLicense = path.join(path.dirname(require.resolve("ffprobe-static/package.json")), "LICENSE");
if (existsSync(ffprobeLicense)) copyFileSync(ffprobeLicense, path.join(media, "FFPROBE-PACKAGE-LICENSE.txt"));
if (process.platform !== "win32") {
  chmodSync(ffmpegDestination, 0o755);
  chmodSync(ffprobeDestination, 0o755);
}
process.stdout.write(`FFmpeg e FFprobe preparados para ${process.platform}/${process.arch}.\n`);
