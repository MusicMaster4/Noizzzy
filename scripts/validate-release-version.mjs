import { readFile } from "node:fs/promises";

const expectedTag = process.argv[2];

if (!expectedTag) {
  throw new Error("Usage: node scripts/validate-release-version.mjs <vMAJOR.MINOR.PATCH>");
}

const expectedVersion = expectedTag.startsWith("v") ? expectedTag.slice(1) : "";
if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
  throw new Error(`Invalid release tag: ${expectedTag}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const rootPackage = await readJson("package.json");
const rootLock = await readJson("package-lock.json");
const webPackage = await readJson("web/package.json");
const webLock = await readJson("web/package-lock.json");
const workerProject = await readFile("worker/pyproject.toml", "utf8");
const workerModule = await readFile("worker/voice_worker/__init__.py", "utf8");

const versions = new Map([
  ["package.json", rootPackage.version],
  ["package-lock.json", rootLock.version],
  ["package-lock.json packages['']", rootLock.packages?.[""]?.version],
  ["web/package.json", webPackage.version],
  ["web/package-lock.json", webLock.version],
  ["web/package-lock.json packages['']", webLock.packages?.[""]?.version],
  ["worker/pyproject.toml", workerProject.match(/^version\s*=\s*"([^"]+)"/m)?.[1]],
  ["worker/voice_worker/__init__.py", workerModule.match(/^__version__\s*=\s*"([^"]+)"/m)?.[1]],
]);

const mismatches = [...versions].filter(([, version]) => version !== expectedVersion);
if (mismatches.length > 0) {
  const details = mismatches
    .map(([path, version]) => `${path}: ${version ?? "missing"}`)
    .join("\n");
  throw new Error(`Release ${expectedTag} does not match every project version:\n${details}`);
}

console.log(`Release metadata is consistent for ${expectedTag}.`);
