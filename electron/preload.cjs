"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("noizzzy", Object.freeze({
  getAppInfo: () => ipcRenderer.invoke("noizzzy:app-info"),
  getRuntimeStatus: () => ipcRenderer.invoke("noizzzy:runtime-status"),
  installRuntime: () => ipcRenderer.invoke("noizzzy:runtime-install"),
  onRuntimeStatus: (callback) => subscribe("noizzzy:runtime-status", callback),
  onWorkerStatus: (callback) => subscribe("noizzzy:worker-status", callback)
}));
