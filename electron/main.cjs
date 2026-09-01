"use strict";

const { app, BrowserWindow, ipcMain, Menu, shell } = require("electron");
const path = require("node:path");
const { execFile } = require("node:child_process");
const log = require("electron-log/main");
const { RuntimeManager } = require("./runtime.cjs");
const { WorkerManager } = require("./worker.cjs");
const { platformLabel } = require("./lib/platform.cjs");

app.setName("Noizzzy");
app.setAppUserModelId("com.musicmaster4.noizzzy");

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let mainWindow = null;
let runtime = null;
let worker = null;
let hasNvidia = false;

log.initialize();
log.transports.file.level = "info";
log.transports.console.level = app.isPackaged ? false : "debug";

function detectNvidia() {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("nvidia-smi.exe", ["--query-gpu=name", "--format=csv,noheader"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      resolve(!error && Boolean(stdout.trim()));
    });
  });
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Noizzzy", submenu: [
      { role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" },
      { type: "separator" }, { role: "quit" }
    ] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] }
  ]));
}

function createWindow() {
  const mac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 680,
    show: false,
    backgroundColor: "#070907",
    title: "Noizzzy",
    titleBarStyle: mac ? "hiddenInset" : "hidden",
    trafficLightPosition: mac ? { x: 18, y: 19 } : undefined,
    titleBarOverlay: mac ? undefined : { color: "#070907", symbolColor: "#f1eee3", height: 44 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow.webContents.getURL() && !url.startsWith("file:")) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = null; });

  const index = path.join(__dirname, "..", "web", "out", "index.html");
  void mainWindow.loadFile(index);
}

function registerIpc() {
  ipcMain.handle("noizzzy:app-info", () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    acceleration: hasNvidia ? "cuda" : process.platform === "darwin" && process.arch === "arm64" ? "mps-cpu" : "cpu",
    engineLabel: platformLabel(process.platform, process.arch, hasNvidia),
    worker: worker?.snapshot() || { ready: false }
  }));
  ipcMain.handle("noizzzy:runtime-status", () => runtime.snapshot());
  ipcMain.handle("noizzzy:runtime-install", async () => {
    try {
      const result = await runtime.install();
      await worker.restart();
      return result;
    } catch (reason) {
      return { ...runtime.snapshot(), error: reason instanceof Error ? reason.message : String(reason) };
    }
  });
}

async function bootstrap() {
  hasNvidia = await detectNvidia();
  runtime = new RuntimeManager({
    userData: app.getPath("userData"),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    hasNvidia,
    logger: log
  });
  worker = new WorkerManager({ app, runtime, logger: log });
  runtime.on("status", (status) => broadcast("noizzzy:runtime-status", status));
  worker.on("status", (status) => broadcast("noizzzy:worker-status", status));
  registerIpc();
  createMenu();
  try {
    await worker.start();
  } catch (reason) {
    log.error("Worker was not ready during startup", reason);
  }
  createWindow();
}

if (singleInstance) {
  app.whenReady().then(bootstrap).catch((reason) => {
    log.error("Fatal error while starting Noizzzy", reason);
    app.quit();
  });
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && runtime && worker) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => worker?.stopNow());
