"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { RuntimeManager } = require("../runtime.cjs");

test("removes the disposable installer cache without removing the runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "noizzzy-runtime-cache-test-"));
  const runtime = new RuntimeManager({
    userData: root,
    resourcesPath: root,
    isPackaged: true,
    platform: "win32",
    arch: "x64",
    hasNvidia: false,
    logger: { info() {}, warn() {}, error() {} }
  });
  try {
    fs.mkdirSync(runtime.paths.uvCache, { recursive: true });
    fs.writeFileSync(path.join(runtime.paths.uvCache, "download.whl"), "temporary");
    fs.mkdirSync(runtime.paths.separatorEnvironment, { recursive: true });
    fs.writeFileSync(path.join(runtime.paths.separatorEnvironment, "keep.txt"), "runtime");

    await runtime.cleanupInstallCache();

    assert.equal(fs.existsSync(runtime.paths.uvCache), false);
    assert.equal(fs.existsSync(path.join(runtime.paths.separatorEnvironment, "keep.txt")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
