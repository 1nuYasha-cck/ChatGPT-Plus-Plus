const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexMenuBar", {
  getState: () => ipcRenderer.invoke("menu-bar:get-state"),
  performAction: (action, value) => ipcRenderer.invoke("menu-bar:action", action, value),
  resizeToContent: (height) => ipcRenderer.invoke("menu-bar:resize", height),
  openThemeMenu: (anchor) => ipcRenderer.invoke("theme:open-menu", anchor),
  onStateChanged: (callback) => {
    ipcRenderer.on("menu-bar:state-changed", (_event, state) => callback(state));
  }
});
