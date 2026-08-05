const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("codexQuota", {
  getQuota: () => ipcRenderer.invoke("quota:get"),
  getRefreshIntervalMinutes: () => ipcRenderer.invoke("settings:refreshInterval:get"),
  setRefreshIntervalMinutes: (value) => ipcRenderer.invoke("settings:refreshInterval:set", value),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  close: () => ipcRenderer.invoke("window:close"),
  getAlwaysOnTop: () => ipcRenderer.invoke("window:alwaysOnTop:get"),
  setAlwaysOnTop: (value) => ipcRenderer.invoke("window:alwaysOnTop:set", value),
  onRefresh: (callback) => subscribe("quota:refresh", callback),
  onQuotaStateChanged: (callback) => subscribe("quota:state-changed", callback),
  onAlwaysOnTopChanged: (callback) => subscribe("window:alwaysOnTopChanged", callback),
  onRefreshIntervalChanged: (callback) => subscribe("settings:refreshIntervalChanged", callback)
});
