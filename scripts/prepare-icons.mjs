import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "web", "src", "app", "icon.svg");
const build = path.join(root, "build");
const png = path.join(build, "icon.png");
const ico = path.join(build, "icon.ico");
mkdirSync(build, { recursive: true });

await sharp(readFileSync(source)).resize(1024, 1024).png().toFile(png);
writeFileSync(ico, await pngToIco(png));
process.stdout.write(`Ícones preparados em ${build}\n`);
