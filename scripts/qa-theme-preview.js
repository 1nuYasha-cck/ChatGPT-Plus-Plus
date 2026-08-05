const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const bundleRoot = path.join(projectRoot, "dist/mac-arm64/ChatGPT++.app/Contents/Resources/app.asar");
const outputPath = process.argv[2] || "/tmp/chatgpt-plus-plus-theme-preview.png";
const collapsedOutputPath = outputPath.replace(/\.png$/i, "-collapsed.png");
let previewWindow = null;
const sampleState = {
  supported: true,
  busy: false,
  themeName: "沙发女",
  appliedThemeName: "沙发女",
  status: { level: "healthy", label: "主题服务正常", message: "沙发女已启用", canRepair: false }
};

function preview(colorA, colorB) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="110"><defs><linearGradient id="g"><stop stop-color="${colorA}"/><stop offset="1" stop-color="${colorB}"/></linearGradient></defs><rect width="180" height="110" rx="12" fill="url(#g)"/><circle cx="132" cy="42" r="25" fill="rgba(255,255,255,.22)"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const themes = [
  { id: "sofa", name: "沙发女", previewUrl: preview("#6f5143", "#17181b") },
  { id: "rose", name: "桥本有菜", previewUrl: preview("#df9fa4", "#31242d") },
  { id: "gothic", name: "Gothic Void Crusade", previewUrl: preview("#251a17", "#a47d37") }
];

ipcMain.handle("theme:get-state", () => sampleState);
ipcMain.handle("theme:list", () => themes);
ipcMain.handle("theme:action", () => ({ state: sampleState, message: "主题操作已完成" }));
ipcMain.handle("theme:resize", (event, height) => {
  if (!previewWindow || event.sender !== previewWindow.webContents) return null;
  const nextHeight = Math.max(180, Math.min(358, Math.ceil(Number(height) || 358)));
  previewWindow.setSize(514, nextHeight, false);
  return { width: 514, height: nextHeight };
});

app.whenReady().then(async () => {
  const window = previewWindow = new BrowserWindow({
    width: 514,
    height: 358,
    frame: false,
    transparent: true,
    show: false,
    webPreferences: {
      preload: path.join(bundleRoot, "src/main/preload-theme-menu.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await window.loadFile(path.join(bundleRoot, "src/renderer/theme-menu.html"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const initialState = await window.webContents.executeJavaScript(`(() => ({
    savedHidden: document.getElementById('savedPanel').hidden,
    formHidden: document.getElementById('newThemeForm').hidden
  }))()`);
  fs.writeFileSync(collapsedOutputPath, (await window.webContents.capturePage()).toPNG());
  const formState = await window.webContents.executeJavaScript(`(async () => {
    document.getElementById('newThemeBtn').click();
    document.getElementById('themeNameInput').value = 'QA Theme';
    document.getElementById('newThemeForm').requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      hidden: document.getElementById('newThemeForm').hidden,
      value: document.getElementById('themeNameInput').value
    };
  })()`);
  await window.webContents.executeJavaScript("document.getElementById('savedThemesBtn').dispatchEvent(new MouseEvent('mouseenter'))");
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.writeFileSync(outputPath, (await window.webContents.capturePage()).toPNG());
  const hoverState = await window.webContents.executeJavaScript(`(() => ({
    savedHidden: document.getElementById('savedPanel').hidden,
    expanded: document.getElementById('savedThemesBtn').getAttribute('aria-expanded')
  }))()`);
  const leaveState = await window.webContents.executeJavaScript(`(async () => {
    document.getElementById('savedThemesBtn').dispatchEvent(new MouseEvent('mouseleave'));
    document.getElementById('savedPanel').dispatchEvent(new MouseEvent('mouseleave'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    return {
      savedHidden: document.getElementById('savedPanel').hidden,
      expanded: document.getElementById('savedThemesBtn').getAttribute('aria-expanded')
    };
  })()`);
  console.log(JSON.stringify({ outputPath, collapsedOutputPath, initialState, formState, hoverState, leaveState }));
  app.quit();
});
