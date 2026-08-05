const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { MENU_BAR_POPOVER_SIZE } = require("../src/main/menu-bar-layout");

const projectRoot = path.resolve(__dirname, "..");
const outputRoot = process.argv[2] || path.join(projectRoot, "artifacts");
let expanded = false;
let themeOpenCount = 0;
let lastThemeAnchor = null;
const accounts = [
  { id: "current", name: "Demo User", email: "demo@example.com", planType: "plus", subscriptionExpiresAt: 0, isActive: true, quotaUpdatedAt: "2026-08-05T20:38:00+08:00", quota: { weekly: { remainingPercent: 19 }, fiveHour: null } }
];
let qaWindow = null;

function state() {
  return { quotaSource: "weekly", refreshing: false, widgetVisible: true, autoLaunch: false, refreshIntervalMinutes: 5,
    accountsExpanded: expanded, activeAccountId: "current", switchingAccountId: null, accounts,
    theme: { status: { level: "healthy", label: "主题服务正常", message: "", canRepair: false } }, quota: accounts[0].quota };
}

ipcMain.handle("menu-bar:get-state", () => state());
ipcMain.handle("menu-bar:action", (_event, action, value) => {
  if (action === "set-accounts-expanded") expanded = Boolean(value);
  return state();
});
ipcMain.handle("theme:open-menu", (_event, anchor) => {
  themeOpenCount += 1;
  lastThemeAnchor = anchor;
  return null;
});
ipcMain.handle("menu-bar:resize", (_event, height) => {
  const nextHeight = Math.ceil(Number(height));
  if (qaWindow && Number.isFinite(nextHeight)) qaWindow.setSize(MENU_BAR_POPOVER_SIZE.width, nextHeight);
  return { width: MENU_BAR_POPOVER_SIZE.width, height: nextHeight };
});

app.whenReady().then(async () => {
  fs.mkdirSync(outputRoot, { recursive: true });
  const window = new BrowserWindow({ width: MENU_BAR_POPOVER_SIZE.width, height: MENU_BAR_POPOVER_SIZE.height, frame: false, transparent: true, show: false,
    webPreferences: { preload: path.join(projectRoot, "src/main/preload-menu-bar.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await window.loadFile(path.join(projectRoot, "src/renderer/menu-bar.html"));
  qaWindow = window;
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (document.getElementById('accountCount')?.textContent === '1') {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > 3000) {
        clearInterval(timer);
        reject(new Error('menu state render timed out'));
      }
    }, 25);
  })`);
  await window.webContents.executeJavaScript("document.getElementById('themeBtn').dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const themeOpenCountAfterHover = themeOpenCount;
  await window.webContents.executeJavaScript("document.getElementById('themeBtn').click()");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const themeOpenCountAfterClick = themeOpenCount;
  const collapsedPath = path.join(outputRoot, "chatgpt-plus-plus-menu-collapsed-implementation.png");
  await new Promise((resolve) => setTimeout(resolve, 120));
  const collapsedBounds = await window.webContents.executeJavaScript(`(() => {
    const popover = document.querySelector('.popover').getBoundingClientRect();
    const quit = document.querySelector('.quit-row').getBoundingClientRect();
    return { content: document.querySelector('.popover').scrollHeight, viewport: innerHeight, bottomGap: Math.round(popover.bottom - quit.bottom) };
  })()`);
  fs.writeFileSync(collapsedPath, (await window.webContents.capturePage()).toPNG());
  expanded = true;
  window.webContents.send("menu-bar:state-changed", state());
  await new Promise((resolve) => setTimeout(resolve, 220));
  const expandedPath = path.join(outputRoot, "chatgpt-plus-plus-menu-expanded-implementation.png");
  fs.writeFileSync(expandedPath, (await window.webContents.capturePage()).toPNG());
  const expandedBounds = await window.webContents.executeJavaScript(`(() => {
    const popover = document.querySelector('.popover').getBoundingClientRect();
    const quit = document.querySelector('.quit-row').getBoundingClientRect();
    return { content: document.querySelector('.popover').scrollHeight, viewport: innerHeight, bottomGap: Math.round(popover.bottom - quit.bottom), accounts: document.querySelectorAll('.account-row').length, expiry: document.getElementById('accountMeta').textContent, addAccountVisible: !document.getElementById('addAccountBtn').closest('[hidden]') };
  })()`);
  const valid = collapsedBounds.bottomGap <= 20 && expandedBounds.bottomGap <= 20 &&
    Math.abs(expandedBounds.content - expandedBounds.viewport) <= 2 &&
    !expandedBounds.expiry.includes("1970") && expandedBounds.addAccountVisible &&
    themeOpenCountAfterHover === 0 && themeOpenCountAfterClick === 1 &&
    Number(lastThemeAnchor?.top) > 200 && Number(lastThemeAnchor?.bottom) > Number(lastThemeAnchor?.top);
  console.log(JSON.stringify({ collapsedPath, expandedPath, collapsedBounds, expandedBounds,
    themeInteraction: { afterHover: themeOpenCountAfterHover, afterClick: themeOpenCountAfterClick, anchor: lastThemeAnchor }, valid }));
  if (!valid) process.exitCode = 1;
  app.quit();
});
