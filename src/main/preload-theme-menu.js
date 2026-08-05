const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexThemeMenu", {
  getState: () => ipcRenderer.invoke("theme:get-state"),
  listThemes: () => ipcRenderer.invoke("theme:list"),
  performAction: (action, value) => ipcRenderer.invoke("theme:action", action, value),
  resizeToContent: (height) => ipcRenderer.invoke("theme:resize", height),
  onStateChanged: (callback) => {
    ipcRenderer.on("theme:state-changed", (_event, state) => callback(state));
  }
});
