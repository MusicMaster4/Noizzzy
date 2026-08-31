"use strict";

const path = require("node:path");
const { test, expect, _electron: electron } = require("@playwright/test");

test("abre o desktop, identifica a plataforma e conecta ao worker", async () => {
  const root = path.resolve(__dirname, "..", "..");
  const localPython = path.join(root, "worker", process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  const packaged = process.env.NOIZZZY_PACKAGED_EXECUTABLE;
  const application = await electron.launch(packaged ? {
    executablePath: packaged,
    args: [],
    env: { ...process.env }
  } : {
    args: [root],
    env: { ...process.env, NOIZZZY_WORKER_PYTHON: localPython }
  });
  try {
    const window = await application.firstWindow();
    await expect(window).toHaveTitle(/Noizzzy/);
    await expect(window.getByLabel(/Noizzzy, início/i)).toBeVisible();
    await expect(window.getByText(/LOCAL/).first()).toBeVisible();
    const health = await window.evaluate(async () => (await fetch("http://127.0.0.1:35592/health")).json());
    expect(health).toEqual({ status: "ok" });
    const info = await window.evaluate(() => window.noizzzy.getAppInfo());
    expect(info.name).toBe("Noizzzy");
    expect(info.worker.ready).toBe(true);
    const processed = await window.evaluate(async () => {
      const sampleRate = 48000; const samples = sampleRate / 2;
      const buffer = new ArrayBuffer(44 + samples * 2); const view = new DataView(buffer);
      const text = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
      text(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); text(8, "WAVE"); text(12, "fmt ");
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      text(36, "data"); view.setUint32(40, samples * 2, true);
      for (let index = 0; index < samples; index += 1) view.setInt16(44 + index * 2, Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 12000, true);
      const form = new FormData();
      form.append("file", new File([buffer], "electron-smoke.wav", { type: "audio/wav" }));
      form.append("profile", "streaming"); form.append("separate_voice", "false");
      const created = await fetch("http://127.0.0.1:35592/api/jobs", { method: "POST", body: form });
      if (!created.ok) throw new Error(await created.text());
      const { id } = await created.json(); const deadline = Date.now() + 30000;
      let job;
      while (Date.now() < deadline) {
        job = await (await fetch(`http://127.0.0.1:35592/api/jobs/${id}`)).json();
        if (["completed", "failed", "cancelled"].includes(job.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (job?.status !== "completed") return { status: job?.status, error: job?.error };
      const result = await fetch(`http://127.0.0.1:35592${job.outputs[0].url}`);
      return { status: job.status, bytes: (await result.arrayBuffer()).byteLength };
    });
    expect(processed.status).toBe("completed");
    expect(processed.bytes).toBeGreaterThan(1000);
  } finally {
    await application.close();
  }
});
