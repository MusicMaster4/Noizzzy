"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { pathWithBundledMedia } = require("../worker.cjs");

test("bundled media directory is first on the worker PATH", () => {
  const ffmpeg = path.join("runtime", "media", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const inherited = ["system", "bin"].join(path.delimiter);
  const entries = pathWithBundledMedia(ffmpeg, inherited).split(path.delimiter);

  assert.equal(entries[0], path.dirname(ffmpeg));
  assert.deepEqual(entries.slice(1), ["system", "bin"]);
});
