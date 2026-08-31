"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_SCHEMA = 1;
const ML_VERSIONS = Object.freeze({
  audioSeparator: "0.47.0",
  audioSeparatorMac: "0.20.0",
  clearvoice: "0.1.2",
  numpy: "1.26.4",
  torch: "2.11.0",
  torchvision: "0.26.0",
  torchaudio: "2.11.0",
  onnxruntimeGpu: "1.26.0"
});

function pythonVersion(platform = process.platform, arch = process.arch) {
  return platform === "darwin" ? "3.11" : "3.12";
}

function pythonExecutable(environment, platform = process.platform) {
  return path.join(environment, platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

function platformLabel(platform = process.platform, arch = process.arch, hasNvidia = false) {
  if (platform === "win32" && hasNvidia) return "NVIDIA CUDA · LOCAL";
  if (platform === "win32") return "CPU WINDOWS · LOCAL";
  if (platform === "darwin" && arch === "arm64") return "APPLE SILICON · LOCAL";
  if (platform === "darwin") return "MAC INTEL · LOCAL";
  return "CPU LOCAL · PRIVADO";
}

function runtimePaths(userData, platform = process.platform) {
  const root = path.join(userData, "ml-runtime");
  const separatorEnvironment = path.join(root, "separator");
  const enhancerEnvironment = path.join(root, "enhancer");
  return {
    root,
    pythonRoot: path.join(root, "python"),
    uvCache: path.join(root, "uv-cache"),
    separatorEnvironment,
    enhancerEnvironment,
    separatorPython: pythonExecutable(separatorEnvironment, platform),
    enhancerPython: pythonExecutable(enhancerEnvironment, platform),
    marker: path.join(root, "runtime.json")
  };
}

function runtimeIsReady(paths, expected = { schema: RUNTIME_SCHEMA, versions: ML_VERSIONS }) {
  if (!fs.existsSync(paths.separatorPython) || !fs.existsSync(paths.enhancerPython)) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(paths.marker, "utf8"));
    return marker.schema === expected.schema
      && Object.entries(expected.versions).every(([key, value]) => marker.versions?.[key] === value);
  } catch {
    return false;
  }
}

function separatorRequirements({ platform = process.platform, arch = process.arch, hasNvidia = false } = {}) {
  if (platform === "darwin") {
    return [
      "torch==2.2.2",
      "torchaudio==2.2.2",
      `audio-separator[cpu]==${ML_VERSIONS.audioSeparatorMac}`,
      "audioread>=3.1,<4"
    ];
  }
  const extra = platform === "win32" && hasNvidia ? "gpu" : "cpu";
  const values = [
    `torch==${ML_VERSIONS.torch}`,
    `torchvision==${ML_VERSIONS.torchvision}`,
    `torchaudio==${ML_VERSIONS.torchaudio}`,
    `audio-separator[${extra}]==${ML_VERSIONS.audioSeparator}`,
    "audioread>=3.1,<4"
  ];
  if (platform === "win32" && hasNvidia) values.push(`onnxruntime-gpu==${ML_VERSIONS.onnxruntimeGpu}`);
  return values;
}

function enhancerRequirements({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin") {
    return [
      "torch==2.2.2",
      "torchaudio==2.2.2",
      `clearvoice==${ML_VERSIONS.clearvoice}`,
      `numpy==${ML_VERSIONS.numpy}`
    ];
  }
  return [
    `torch==${ML_VERSIONS.torch}`,
    `torchvision==${ML_VERSIONS.torchvision}`,
    `torchaudio==${ML_VERSIONS.torchaudio}`,
    `clearvoice==${ML_VERSIONS.clearvoice}`,
    `numpy==${ML_VERSIONS.numpy}`
  ];
}

module.exports = {
  ML_VERSIONS,
  RUNTIME_SCHEMA,
  enhancerRequirements,
  platformLabel,
  pythonExecutable,
  pythonVersion,
  runtimeIsReady,
  runtimePaths,
  separatorRequirements
};
