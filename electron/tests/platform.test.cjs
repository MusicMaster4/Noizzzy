"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  enhancerRequirements,
  platformLabel,
  pythonVersion,
  runtimeIsReady,
  runtimePaths,
  separatorRequirements
} = require("../lib/platform.cjs");

test("selects architecture-compatible runtimes", () => {
  assert.equal(pythonVersion("darwin", "x64"), "3.11");
  assert.equal(pythonVersion("darwin", "arm64"), "3.11");
  assert.equal(pythonVersion("win32", "x64"), "3.12");
  assert.equal(platformLabel("win32", "x64", true), "NVIDIA CUDA · LOCAL");
  assert.equal(platformLabel("darwin", "arm64", false), "APPLE SILICON · LOCAL");
});

test("installs CUDA only on Windows with NVIDIA", () => {
  assert.ok(separatorRequirements({ platform: "win32", arch: "x64", hasNvidia: true }).some((item) => item.startsWith("onnxruntime-gpu")));
  assert.ok(separatorRequirements({ platform: "darwin", arch: "arm64", hasNvidia: false }).some((item) => item.includes("[cpu]")));
  assert.ok(separatorRequirements({ platform: "darwin", arch: "arm64", hasNvidia: false }).includes("torch==2.2.2"));
  assert.ok(separatorRequirements({ platform: "darwin", arch: "x64", hasNvidia: false }).includes("torch==2.2.2"));
  assert.ok(separatorRequirements({ platform: "darwin", arch: "x64", hasNvidia: false }).includes("numba==0.61.2"));
  assert.ok(separatorRequirements({ platform: "darwin", arch: "x64", hasNvidia: false }).includes("llvmlite==0.44.0"));
  assert.ok(enhancerRequirements({ platform: "darwin", arch: "x64" }).includes("torch==2.2.2"));
});

test("marks the runtime ready only with executables and a compatible manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "noizzzy-platform-test-"));
  try {
    const paths = runtimePaths(root, "win32");
    fs.mkdirSync(path.dirname(paths.separatorPython), { recursive: true });
    fs.mkdirSync(path.dirname(paths.enhancerPython), { recursive: true });
    fs.writeFileSync(paths.separatorPython, "");
    fs.writeFileSync(paths.enhancerPython, "");
    fs.writeFileSync(paths.marker, JSON.stringify({ schema: 7, versions: { model: "1" } }));
    assert.equal(runtimeIsReady(paths, { schema: 7, versions: { model: "1" } }), true);
    fs.writeFileSync(paths.marker, JSON.stringify({ schema: 6, versions: { model: "1" } }));
    assert.equal(runtimeIsReady(paths, { schema: 7, versions: { model: "1" } }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
