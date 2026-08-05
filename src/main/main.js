const { app, BrowserWindow, dialog, ipcMain, Tray, Menu, nativeImage, screen, session, shell } = require("electron");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { getQuota } = require("./quota-service");
const { AccountService } = require("./account-service");
const { detectCodexProcesses, restartCodexProcesses } = require("./codex-process-service");
const { createQuotaRetryReader } = require("./quota-retry");
const { DreamSkinService, resolveEngineRoot } = require("./dream-skin-service");
const { syncDockVisibility } = require("./dock-visibility");
const { calculateThemeMenuPosition, MENU_BAR_POPOVER_SIZE, THEME_MENU_SIZE } = require("./menu-bar-layout");
const {
  DEFAULT_MENU_BAR_QUOTA_SOURCE,
  normalizeMenuBarQuotaSource,
  formatMenuBarTitle
} = require("./menu-bar-logic");

let mainWindow;
let menuBarWindow;
let themeMenuWindow;
let tray;
let isAlwaysOnTop = true;
let refreshIntervalMinutes = 5;
let windowSize = { width: 260, height: 192 };
let menuBarQuotaSource = DEFAULT_MENU_BAR_QUOTA_SOURCE;
let latestQuota = null;
let latestQuotaError = null;
let quotaRetrying = false;
let quotaFailureCount = 0;
let activeQuotaRefresh = null;
let isRefreshingMenuBar = false;
let accountsExpanded = false;
let accountStatusMessage = "";
let themeMenuAnchorTop = 74;
let latestThemeState = {
  supported: process.platform === "darwin",
  busy: false,
  status: { level: "idle", label: "正在检查主题服务", message: "", canRepair: false }
};
let lastTrayClickAt = 0;
let nativeDialogDepth = 0;
let saveWindowSizeTimer;
let hideMenuWindowsTimer;
let automaticRefreshTimer;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

const dreamSkinService = new DreamSkinService({
  engineRoot: resolveEngineRoot({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: path.join(__dirname, "../..")
  })
});
const accountService = new AccountService();

const getQuotaWithRetry = createQuotaRetryReader({
  read: getQuota,
  onFailure: (quota, failureCount) => reportQuotaFailure(quota, failureCount)
});

const REFRESH_INTERVAL_OPTIONS = [1, 5, 15, 30, 60];
const DEFAULT_REFRESH_INTERVAL_MINUTES = 5;

app.setName("ChatGPT++");

function getIcon() {
  const iconPath = path.join(__dirname, "../../assets/icon.png");
  const image = nativeImage.createFromPath(iconPath);
  return image.isEmpty() ? undefined : image;
}

function hardenWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function isUsableWindow(window) {
  return Boolean(window && !window.isDestroyed());
}

function createWindow() {
  if (isUsableWindow(mainWindow)) return mainWindow;
  // macOS reads the application icon exclusively from the application bundle.
  // Windows still needs an explicit window icon for the taskbar executable.
  const icon = process.platform === "darwin" ? undefined : getIcon();
  mainWindow = new BrowserWindow({
    width: windowSize.width,
    height: windowSize.height,
    // Keep the compact layout usable while allowing the meter to be hidden
    // without leaving an unnecessarily large native window constraint.
    minWidth: 180,
    minHeight: 140,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: isAlwaysOnTop,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#00000000",
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged,
      // Keep the always-visible Apple Silicon widget responsive when macOS
      // moves it to the background; Windows keeps the lower-power default.
      backgroundThrottling: process.platform !== "darwin",
      v8CacheOptions: "bypassHeatCheckAndEagerCompile"
    }
  });

  const window = mainWindow;
  window.loadFile(path.join(__dirname, "../renderer/index.html"));
  hardenWindow(window);
  window.on("resize", () => {
    if (!isUsableWindow(window) || window.isMaximized() || window.isMinimized()) return;
    const { width, height } = window.getBounds();
    windowSize = { width, height };
    clearTimeout(saveWindowSizeTimer);
    saveWindowSizeTimer = setTimeout(saveSettings, 300);
  });
  window.on("show", () => {
    syncDockVisibility({ platform: process.platform, dock: app.dock, widgetVisible: true });
    notifyMenuBarStateChanged();
  });
  window.on("hide", () => {
    // The widget remains available from the macOS menu bar while it runs in
    // the background, so it should not leave a redundant Dock icon behind.
    syncDockVisibility({ platform: process.platform, dock: app.dock, widgetVisible: false });
    notifyMenuBarStateChanged();
  });
  window.once("ready-to-show", () => {
    if (!isUsableWindow(window)) return;
    window.setSkipTaskbar(true);
    window.show();
    placeWindowTopRight();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    notifyMenuBarStateChanged();
  });
  return window;
}

function createMenuBarWindow() {
  if (process.platform !== "darwin") return;
  if (isUsableWindow(menuBarWindow)) return menuBarWindow;
  menuBarWindow = new BrowserWindow({
    width: MENU_BAR_POPOVER_SIZE.width,
    height: MENU_BAR_POPOVER_SIZE.height,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    type: "panel",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload-menu-bar.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged,
      backgroundThrottling: false
    }
  });

  const window = menuBarWindow;
  window.loadFile(path.join(__dirname, "../renderer/menu-bar.html"));
  hardenWindow(window);
  window.on("blur", scheduleMenuWindowsHide);
  window.on("hide", () => {
    if (isUsableWindow(themeMenuWindow)) themeMenuWindow.hide();
  });
  window.on("closed", () => {
    if (menuBarWindow === window) menuBarWindow = null;
  });
  return window;
}

function createThemeMenuWindow() {
  if (process.platform !== "darwin") return;
  if (isUsableWindow(themeMenuWindow)) return themeMenuWindow;
  themeMenuWindow = new BrowserWindow({
    width: THEME_MENU_SIZE.width,
    height: THEME_MENU_SIZE.height,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    hasShadow: false,
    type: "panel",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload-theme-menu.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged,
      backgroundThrottling: false
    }
  });

  const window = themeMenuWindow;
  window.loadFile(path.join(__dirname, "../renderer/theme-menu.html"));
  hardenWindow(window);
  window.on("blur", scheduleMenuWindowsHide);
  window.on("closed", () => {
    if (themeMenuWindow === window) themeMenuWindow = null;
  });
  return window;
}

function scheduleMenuWindowsHide() {
  clearTimeout(hideMenuWindowsTimer);
  hideMenuWindowsTimer = setTimeout(() => {
    if (nativeDialogDepth > 0) return;
    if (Date.now() - lastTrayClickAt <= 180) return;
    const menuFocused = isUsableWindow(menuBarWindow) && menuBarWindow.isFocused();
    const themeFocused = isUsableWindow(themeMenuWindow) && themeMenuWindow.isFocused();
    if (!menuFocused && !themeFocused) {
      if (isUsableWindow(themeMenuWindow)) themeMenuWindow.hide();
      if (isUsableWindow(menuBarWindow)) menuBarWindow.hide();
    }
  }, 260);
}

function placeWindowTopRight() {
  if (!isUsableWindow(mainWindow)) return;
  const display = screen.getPrimaryDisplay();
  const { width, height } = mainWindow.getBounds();
  const { workArea } = display;
  mainWindow.setBounds({
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
    width,
    height
  });
}

function createTray() {
  const icon = getIcon();
  const iconSize = process.platform === "darwin" ? 18 : 16;
  tray = new Tray(icon ? icon.resize({ width: iconSize, height: iconSize }) : nativeImage.createEmpty());
  tray.setToolTip("ChatGPT++");
  if (process.platform === "darwin") {
    createMenuBarWindow();
    createThemeMenuWindow();
    updateMenuBarTitle();
    tray.on("click", toggleMenuBarWindow);
    tray.on("right-click", toggleMenuBarWindow);
  } else {
    rebuildTrayMenu();
    tray.on("click", toggleWindow);
  }
}

function rebuildTrayMenu() {
  if (!tray || process.platform === "darwin") return;
  const accountState = accountService.getState();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示/隐藏", click: toggleWindow },
      {
        label: "刷新额度",
        click: () => {
          if (isUsableWindow(mainWindow)) mainWindow.webContents.send("quota:refresh");
          void refreshQuotaInBackground();
        }
      },
      {
        label: isAlwaysOnTop ? "取消置顶" : "置顶",
        click: () => setAlwaysOnTop(!isAlwaysOnTop)
      },
      {
        label: "开机自启动",
        type: "checkbox",
        checked: isAutoLaunchEnabled(),
        click: (item) => setAutoLaunch(item.checked)
      },
      {
        label: "刷新间隔",
        submenu: REFRESH_INTERVAL_OPTIONS.map((minutes) => ({
          label: `${minutes} 分钟`,
          type: "radio",
          checked: refreshIntervalMinutes === minutes,
          click: () => setRefreshIntervalMinutes(minutes)
        }))
      },
      {
        label: "全部账号",
        submenu: [
          ...accountState.accounts.map((account) => ({
            label: `${account.email || account.name || "未识别账号"} · ${String(account.planType || "--").toUpperCase()}`,
            type: "radio",
            checked: account.isActive,
            enabled: !accountState.switchingAccountId,
            click: () => void switchAccountFromMenu(account.id).catch(() => {})
          })),
          ...(accountState.accounts.length ? [{ type: "separator" }] : []),
          { label: "添加账号…", click: () => void addAccountFromMenu().catch(() => {}) },
          { label: "导入 auth.json…", click: () => void importAccountFromMenu().catch(() => {}) }
        ]
      },
      { type: "separator" },
      { label: "退出 ChatGPT++", click: () => app.quit() }
    ])
  );
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    const currentPath = getSettingsPath();
    const legacyPath = path.join(app.getPath("appData"), "ChatGPT Quota", "settings.json");
    const sourcePath = fs.existsSync(currentPath) ? currentPath : legacyPath;
    const settings = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    refreshIntervalMinutes = normalizeRefreshInterval(settings.refreshIntervalMinutes);
    windowSize = normalizeWindowSize(settings.windowSize);
    menuBarQuotaSource = normalizeMenuBarQuotaSource(settings.menuBarQuotaSource);
    isAlwaysOnTop = typeof settings.isAlwaysOnTop === "boolean" ? settings.isAlwaysOnTop : true;
  } catch {
    refreshIntervalMinutes = DEFAULT_REFRESH_INTERVAL_MINUTES;
    windowSize = { width: 260, height: 192 };
    menuBarQuotaSource = DEFAULT_MENU_BAR_QUOTA_SOURCE;
    isAlwaysOnTop = true;
  }
}

function saveSettings() {
  const settingsPath = getSettingsPath();
  const temporary = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      temporary,
      JSON.stringify(
        {
          refreshIntervalMinutes,
          windowSize,
          menuBarQuotaSource,
          isAlwaysOnTop
        },
        null,
        2
      ),
      { encoding: "utf8", mode: 0o600, flag: "wx" }
    );
    fs.renameSync(temporary, settingsPath);
    fs.chmodSync(settingsPath, 0o600);
    return true;
  } catch (error) {
    console.error(`[quota] could not save settings: ${error?.message || error}`);
    return false;
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function normalizeWindowSize(value) {
  const width = Math.round(Number(value?.width));
  const height = Math.round(Number(value?.height));
  return {
    width: Number.isFinite(width) ? Math.max(180, Math.min(width, 1600)) : 260,
    height: Number.isFinite(height) ? Math.max(140, Math.min(height, 1200)) : 192
  };
}

function normalizeRefreshInterval(value) {
  const minutes = Number(value);
  return REFRESH_INTERVAL_OPTIONS.includes(minutes) ? minutes : DEFAULT_REFRESH_INTERVAL_MINUTES;
}

function setRefreshIntervalMinutes(minutes) {
  const previous = refreshIntervalMinutes;
  refreshIntervalMinutes = normalizeRefreshInterval(minutes);
  if (!saveSettings()) {
    refreshIntervalMinutes = previous;
    throw new Error("刷新间隔保存失败");
  }
  scheduleAutomaticRefresh();
  if (isUsableWindow(mainWindow)) {
    mainWindow.webContents.send("settings:refreshIntervalChanged", refreshIntervalMinutes);
  }
  rebuildTrayMenu();
  notifyMenuBarStateChanged();
  return refreshIntervalMinutes;
}

function getAutoLaunchOptions() {
  if (app.isPackaged) {
    return { path: process.execPath, args: [] };
  }
  return { path: process.execPath, args: [app.getAppPath()] };
}

function isAutoLaunchEnabled() {
  try {
    return app.getLoginItemSettings(getAutoLaunchOptions()).openAtLogin;
  } catch {
    return false;
  }
}

function setAutoLaunch(enabled) {
  const options = getAutoLaunchOptions();
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: options.path,
      args: options.args
    });
  } finally {
    rebuildTrayMenu();
    notifyMenuBarStateChanged();
  }
}

function setAlwaysOnTop(value) {
  const previous = isAlwaysOnTop;
  isAlwaysOnTop = Boolean(value);
  if (!saveSettings()) {
    isAlwaysOnTop = previous;
    throw new Error("置顶设置保存失败");
  }
  if (isUsableWindow(mainWindow)) {
    mainWindow.setAlwaysOnTop(isAlwaysOnTop);
    mainWindow.webContents.send("window:alwaysOnTopChanged", isAlwaysOnTop);
  }
  rebuildTrayMenu();
  return isAlwaysOnTop;
}

function toggleWindow() {
  if (!isUsableWindow(mainWindow)) createWindow();
  if (!isUsableWindow(mainWindow)) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.setSkipTaskbar(true);
    mainWindow.show();
    mainWindow.focus();
  }
  if (isUsableWindow(menuBarWindow)) menuBarWindow.hide();
  if (isUsableWindow(themeMenuWindow)) themeMenuWindow.hide();
  notifyMenuBarStateChanged();
}

function toggleMenuBarWindow() {
  if (!isUsableWindow(menuBarWindow)) createMenuBarWindow();
  if (!isUsableWindow(themeMenuWindow)) createThemeMenuWindow();
  if (!isUsableWindow(menuBarWindow) || !tray) return;
  lastTrayClickAt = Date.now();
  if (menuBarWindow.isVisible()) {
    if (isUsableWindow(themeMenuWindow)) themeMenuWindow.hide();
    menuBarWindow.hide();
    return;
  }

  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2)
  });
  const { width, height } = menuBarWindow.getBounds();
  const minX = display.workArea.x + 8;
  const maxX = display.workArea.x + display.workArea.width - width - 8;
  const x = Math.max(minX, Math.min(maxX, Math.round(trayBounds.x + trayBounds.width / 2 - width / 2)));
  const y = Math.min(
    display.workArea.y + display.workArea.height - height - 8,
    Math.round(trayBounds.y + trayBounds.height + 6)
  );

  menuBarWindow.setPosition(x, y, false);
  notifyMenuBarStateChanged();
  menuBarWindow.show();
  menuBarWindow.focus();
  refreshThemeState();
}

function positionThemeMenuWindow() {
  if (!isUsableWindow(menuBarWindow) || !isUsableWindow(themeMenuWindow)) return;
  const parentBounds = menuBarWindow.getBounds();
  const display = screen.getDisplayMatching(parentBounds);
  const { width, height } = themeMenuWindow.getBounds();
  const position = calculateThemeMenuPosition(parentBounds, { width, height }, display.workArea, themeMenuAnchorTop);
  themeMenuWindow.setPosition(position.x, position.y, false);
}

async function openThemeMenu(anchor = {}) {
  if (!isUsableWindow(themeMenuWindow)) createThemeMenuWindow();
  if (!isUsableWindow(themeMenuWindow) || !isUsableWindow(menuBarWindow) || !menuBarWindow.isVisible()) return null;
  const parentHeight = menuBarWindow.getBounds().height;
  const requestedTop = Number(anchor?.top);
  if (Number.isFinite(requestedTop)) themeMenuAnchorTop = Math.max(0, Math.min(parentHeight, requestedTop));
  clearTimeout(hideMenuWindowsTimer);
  positionThemeMenuWindow();
  themeMenuWindow.show();
  themeMenuWindow.focus();
  await refreshThemeState();
  return latestThemeState;
}

function updateLatestQuota(quota) {
  latestQuota = quota;
  accountService.ingestActiveQuota(quota);
  latestQuotaError = null;
  quotaRetrying = false;
  quotaFailureCount = 0;
  updateMenuBarTitle();
  notifyQuotaStateChanged();
  notifyMenuBarStateChanged();
}

function reportQuotaFailure(snapshot, failureCount) {
  latestQuotaError = String(snapshot?.quotaError || "额度读取未返回有效数据");
  quotaRetrying = true;
  quotaFailureCount = Number.isFinite(failureCount) ? failureCount : quotaFailureCount + 1;
  notifyQuotaStateChanged();
  notifyMenuBarStateChanged();
}

function getQuotaState() {
  return {
    quota: latestQuota,
    error: latestQuotaError,
    retrying: quotaRetrying,
    failureCount: quotaFailureCount
  };
}

function notifyQuotaStateChanged() {
  if (!isUsableWindow(mainWindow)) return;
  mainWindow.webContents.send("quota:state-changed", getQuotaState());
}

function refreshQuotaInBackground() {
  if (activeQuotaRefresh) return activeQuotaRefresh;
  if (!quotaRetrying) {
    quotaRetrying = true;
    quotaFailureCount = 0;
    notifyQuotaStateChanged();
    notifyMenuBarStateChanged();
  }
  activeQuotaRefresh = getQuotaWithRetry()
    .then((quota) => {
      updateLatestQuota(quota);
      return quota;
    })
    .finally(() => {
      activeQuotaRefresh = null;
    });
  return activeQuotaRefresh;
}

function scheduleAutomaticRefresh() {
  clearInterval(automaticRefreshTimer);
  automaticRefreshTimer = setInterval(() => {
    void refreshQuotaInBackground().catch((error) => reportQuotaFailure({ quotaError: error?.message || String(error) }));
    void accountService.refreshAll().then(() => notifyMenuBarStateChanged()).catch(() => {});
  }, refreshIntervalMinutes * 60 * 1000);
}

function updateMenuBarTitle() {
  if (!tray || process.platform !== "darwin") return;
  tray.setTitle(formatMenuBarTitle(latestQuota, menuBarQuotaSource));
}

function setMenuBarQuotaSource(value) {
  const previous = menuBarQuotaSource;
  menuBarQuotaSource = normalizeMenuBarQuotaSource(value);
  if (!saveSettings()) {
    menuBarQuotaSource = previous;
    throw new Error("菜单栏额度设置保存失败");
  }
  updateMenuBarTitle();
  notifyMenuBarStateChanged();
  return menuBarQuotaSource;
}

function getMenuBarState() {
  return {
    quota: latestQuota,
    quotaError: latestQuotaError,
    quotaSource: menuBarQuotaSource,
    autoLaunch: isAutoLaunchEnabled(),
    refreshIntervalMinutes,
    widgetVisible: isUsableWindow(mainWindow) && mainWindow.isVisible(),
    refreshing: isRefreshingMenuBar || quotaRetrying,
    theme: latestThemeState,
    ...accountService.getState(),
    accountsExpanded,
    accountStatusMessage
  };
}

function setAccountsExpanded(expanded) {
  accountsExpanded = Boolean(expanded);
  notifyMenuBarStateChanged();
  return getMenuBarState();
}

function resizeMenuBarToContent(contentHeight) {
  if (!isUsableWindow(menuBarWindow)) return null;
  const requested = Math.ceil(Number(contentHeight));
  if (!Number.isFinite(requested)) throw new Error("菜单高度无效");
  const current = menuBarWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const height = Math.max(320, Math.min(requested, display.workArea.height - 16));
  menuBarWindow.setBounds({
    x: current.x,
    y: Math.max(display.workArea.y + 8, Math.min(current.y, display.workArea.y + display.workArea.height - height - 8)),
    width: MENU_BAR_POPOVER_SIZE.width,
    height
  }, false);
  return { width: MENU_BAR_POPOVER_SIZE.width, height };
}

function resizeThemeMenuToContent(contentHeight) {
  if (!isUsableWindow(themeMenuWindow)) return null;
  const requested = Math.ceil(Number(contentHeight));
  if (!Number.isFinite(requested)) throw new Error("主题菜单高度无效");
  const current = themeMenuWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const height = Math.max(180, Math.min(requested, display.workArea.height - 16));
  themeMenuWindow.setBounds({
    x: current.x,
    y: current.y,
    width: THEME_MENU_SIZE.width,
    height
  }, false);
  positionThemeMenuWindow();
  return { width: THEME_MENU_SIZE.width, height };
}

async function addAccountFromMenu() {
  if (accountService.addingAccount) return getMenuBarState();
  const loginPromise = accountService.addWithOfficialLogin((authUrl) => shell.openExternal(authUrl));
  accountStatusMessage = "请在官方登录页面完成登录…";
  notifyMenuBarStateChanged();
  try {
    const result = await loginPromise;
    accountStatusMessage = "账号添加成功，登录信息已保存";
    notifyMenuBarStateChanged();
    return getMenuBarState();
  } catch (error) {
    accountStatusMessage = error?.message || String(error);
    notifyMenuBarStateChanged();
    throw error;
  }
}

async function importAccountFromMenu() {
  const options = {
    title: "导入 Codex auth.json",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }]
  };
  const result = isUsableWindow(menuBarWindow)
    ? await dialog.showOpenDialog(menuBarWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return getMenuBarState();
  const account = accountService.addFromFile(result.filePaths[0]);
  accountStatusMessage = "账号已导入";
  await accountService.refreshAccount(account.id);
  notifyMenuBarStateChanged();
  return getMenuBarState();
}

async function switchAccountFromMenu(accountId) {
  const id = String(accountId || "");
  const runningClients = await detectCodexProcesses().catch(() => []);
  accountStatusMessage = "正在切换账号…";
  notifyMenuBarStateChanged();
  try {
    const state = await accountService.switchTo(id);
    const active = state.accounts.find((account) => account.isActive);
    if (active?.quota) updateLatestQuota(active.quota);
    accountStatusMessage = runningClients.length ? "账号切换成功，等待重启 ChatGPT" : "账号切换成功";
    setAccountsExpanded(false);
    const restartPrompt = await showMessageBox({
      type: runningClients.length ? "warning" : "info",
      title: runningClients.length ? "需要重启 ChatGPT" : "账号切换成功",
      message: runningClients.length
        ? "账号已切换，必须重启 ChatGPT 才能让新账号生效。"
        : "账号已切换。ChatGPT 下次启动时将使用新账号。",
      detail: runningClients.length ? "请先保存正在编辑的内容，然后选择“立即重启”。" : "",
      buttons: runningClients.length ? ["稍后重启", "立即重启"] : ["知道了"],
      defaultId: runningClients.length ? 1 : 0,
      cancelId: 0,
      noLink: true
    });
    if (runningClients.length && restartPrompt.response === 1) {
      accountStatusMessage = "正在重启 ChatGPT…";
      notifyMenuBarStateChanged();
      try {
        await restartCodexProcesses(runningClients);
        accountStatusMessage = "ChatGPT 已重启，新账号已生效";
      } catch (restartError) {
        accountStatusMessage = restartError?.message || String(restartError);
        await showMessageBox({
          type: "error",
          title: "无法自动重启 ChatGPT",
          message: accountStatusMessage,
          detail: "账号凭据已经切换，请手动关闭并重新打开 ChatGPT。",
          buttons: ["知道了"],
          defaultId: 0,
          noLink: true
        });
      }
      notifyMenuBarStateChanged();
    } else if (runningClients.length) {
      accountStatusMessage = "账号已切换；请手动重启 ChatGPT 后使用";
      notifyMenuBarStateChanged();
    }
    return getMenuBarState();
  } catch (error) {
    accountStatusMessage = error?.message || String(error);
    notifyMenuBarStateChanged();
    throw error;
  }
}

function notifyMenuBarStateChanged() {
  if (process.platform !== "darwin") rebuildTrayMenu();
  if (!isUsableWindow(menuBarWindow)) return;
  menuBarWindow.webContents.send("menu-bar:state-changed", getMenuBarState());
}

async function refreshFromMenuBar() {
  if (isRefreshingMenuBar) return getMenuBarState();
  isRefreshingMenuBar = true;
  notifyMenuBarStateChanged();

  if (isUsableWindow(mainWindow)) mainWindow.webContents.send("quota:refresh");
  void Promise.allSettled([refreshQuotaInBackground(), accountService.refreshAll()])
    .then(() => notifyMenuBarStateChanged())
    .finally(() => {
      isRefreshingMenuBar = false;
      notifyMenuBarStateChanged();
    });
  return getMenuBarState();
}

function notifyThemeStateChanged() {
  if (isUsableWindow(themeMenuWindow)) {
    themeMenuWindow.webContents.send("theme:state-changed", latestThemeState);
  }
  notifyMenuBarStateChanged();
}

async function refreshThemeState() {
  latestThemeState = await dreamSkinService.getState();
  notifyThemeStateChanged();
  return latestThemeState;
}

async function showMessageBox(options) {
  const parent = isUsableWindow(themeMenuWindow) && themeMenuWindow.isVisible()
    ? themeMenuWindow
    : isUsableWindow(menuBarWindow) && menuBarWindow.isVisible() ? menuBarWindow : null;
  clearTimeout(hideMenuWindowsTimer);
  nativeDialogDepth += 1;
  try {
    return await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
  } finally {
    nativeDialogDepth = Math.max(0, nativeDialogDepth - 1);
  }
}

async function confirmThemeRestart() {
  const result = await showMessageBox({
    type: "warning",
    title: "重启 ChatGPT 并应用主题",
    message: "ChatGPT 需要重启一次才能启用主题。",
    detail: "请先保存正在编辑的内容。重启通常需要 10–30 秒。",
    buttons: ["取消", "重启并应用"],
    defaultId: 1,
    cancelId: 0,
    noLink: true
  });
  return result.response === 1;
}

async function runThemeOperation(operation) {
  try {
    await operation(false);
    return { cancelled: false };
  } catch (error) {
    if (error?.code !== "RESTART_REQUIRED" && error?.message !== "RESTART_REQUIRED") throw error;
    if (!(await confirmThemeRestart())) return { cancelled: true };
    await operation(true);
    return { cancelled: false };
  }
}

function readableThemeError(error) {
  const message = String(error?.message || error || "未知主题错误").replace(/^ChatGPT Dream Skin:\s*/i, "");
  return message.length > 260 ? `${message.slice(0, 257)}…` : message;
}

async function handleThemeAction(action, value) {
  latestThemeState = {
    ...latestThemeState,
    busy: true,
    status: { level: "busy", label: "正在处理主题", message: "请稍候", canRepair: false }
  };
  notifyThemeStateChanged();

  let outcome = { cancelled: false };
  try {
    switch (action) {
      case "reload":
      case "repair":
        outcome = await runThemeOperation((allowRestart) => dreamSkinService.apply({ allowRestart }));
        break;
      case "switch":
        outcome = await runThemeOperation((allowRestart) => dreamSkinService.switchTheme(String(value || ""), { allowRestart }));
        break;
      case "create": {
        const result = await dialog.showOpenDialog(themeMenuWindow, {
          title: "选择主题背景图",
          properties: ["openFile"],
          filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "heic", "tif", "tiff"] }]
        });
        if (result.canceled || !result.filePaths[0]) {
          outcome = { cancelled: true };
          break;
        }
        outcome = await runThemeOperation((allowRestart) => dreamSkinService.createTheme(result.filePaths[0], value, { allowRestart }));
        break;
      }
      case "restore": {
        const confirmation = await showMessageBox({
          type: "warning",
          title: "恢复 ChatGPT 默认外观",
          message: "确定要移除当前主题吗？",
          detail: "已保存的主题不会删除，以后仍可以重新应用。",
          buttons: ["取消", "恢复默认"],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        });
        if (confirmation.response !== 1) {
          outcome = { cancelled: true };
          break;
        }
        const raw = await dreamSkinService.rawStatus().catch(() => ({}));
        const restartRequired = Boolean(raw.codexRunning && !raw.cdpOk);
        if (restartRequired && !(await confirmThemeRestart())) {
          outcome = { cancelled: true };
          break;
        }
        await dreamSkinService.restoreDefault({ restart: restartRequired });
        break;
      }
      default:
        throw new Error(`Unsupported theme action: ${action}`);
    }
  } catch (error) {
    await refreshThemeState();
    return { state: latestThemeState, error: readableThemeError(error) };
  }

  await refreshThemeState();
  return {
    state: latestThemeState,
    cancelled: outcome.cancelled,
    message: outcome.cancelled ? "" : "主题操作已完成"
  };
}

async function handleMenuBarAction(action, value) {
  switch (action) {
    case "toggle-widget":
      toggleWindow();
      break;
    case "refresh":
      return refreshFromMenuBar();
    case "set-quota-source":
      setMenuBarQuotaSource(value);
      break;
    case "set-auto-launch":
      setAutoLaunch(Boolean(value));
      break;
    case "set-refresh-interval":
      setRefreshIntervalMinutes(value);
      break;
    case "set-accounts-expanded":
      return setAccountsExpanded(value);
    case "add-account":
      return addAccountFromMenu();
    case "import-account":
      return importAccountFromMenu();
    case "switch-account":
      return switchAccountFromMenu(value);
    case "quit":
      app.quit();
      return null;
    default:
      throw new Error(`Unsupported menu bar action: ${action}`);
  }
  return getMenuBarState();
}

function registerIpcHandler(channel, getExpectedWindow, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    const expectedWindow = getExpectedWindow();
    const expectedContents = expectedWindow && !expectedWindow.isDestroyed()
      ? expectedWindow.webContents
      : null;
    const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || "";
    const expectedUrl = expectedContents?.getURL?.() || "";
    if (!expectedContents || event.sender !== expectedContents || !expectedUrl || senderUrl !== expectedUrl) {
      throw new Error(`Rejected unauthorized IPC sender for ${channel}`);
    }
    return handler(...args);
  });
}

function showMainWindow() {
  if (!isUsableWindow(mainWindow)) createWindow();
  if (!isUsableWindow(mainWindow)) return;
  mainWindow.setSkipTaskbar(true);
  mainWindow.show();
  mainWindow.focus();
}

async function initializeApplication() {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.on("will-download", (event) => event.preventDefault());
  loadSettings();
  try {
    accountService.initialize();
  } catch (error) {
    accountStatusMessage = `账号仓库初始化失败：${error?.message || error}`;
  }
  createWindow();
  createTray();

  registerIpcHandler("quota:get", () => mainWindow, async () => {
    return refreshQuotaInBackground();
  });
  registerIpcHandler("settings:refreshInterval:get", () => mainWindow, () => refreshIntervalMinutes);
  registerIpcHandler("settings:refreshInterval:set", () => mainWindow, (value) => setRefreshIntervalMinutes(value));
  registerIpcHandler("window:minimize", () => mainWindow, () => {
    if (isUsableWindow(mainWindow)) mainWindow.hide();
  });
  registerIpcHandler("window:close", () => mainWindow, () => {
    if (process.platform === "darwin" && isUsableWindow(mainWindow)) mainWindow.hide();
    else app.quit();
  });
  registerIpcHandler("window:alwaysOnTop:get", () => mainWindow, () => isAlwaysOnTop);
  registerIpcHandler("window:alwaysOnTop:set", () => mainWindow, (value) => setAlwaysOnTop(value));
  registerIpcHandler("menu-bar:get-state", () => menuBarWindow, getMenuBarState);
  registerIpcHandler("menu-bar:action", () => menuBarWindow, (action, value) => handleMenuBarAction(action, value));
  registerIpcHandler("menu-bar:resize", () => menuBarWindow, resizeMenuBarToContent);
  registerIpcHandler("theme:open-menu", () => menuBarWindow, openThemeMenu);
  registerIpcHandler("theme:get-state", () => themeMenuWindow, refreshThemeState);
  registerIpcHandler("theme:resize", () => themeMenuWindow, resizeThemeMenuToContent);
  registerIpcHandler("theme:list", () => themeMenuWindow, async () => {
    await dreamSkinService.ensureLibrary();
    return dreamSkinService.listThemes();
  });
  registerIpcHandler("theme:action", () => themeMenuWindow, (action, value) => handleThemeAction(action, value));

  refreshThemeState();
  scheduleAutomaticRefresh();
  void refreshQuotaInBackground().catch((error) => reportQuotaFailure({ quotaError: error?.message || String(error) }));
  void accountService.refreshAll().then(() => notifyMenuBarStateChanged()).catch(() => {});

  app.on("activate", () => {
    if (!isUsableWindow(mainWindow)) createWindow();
    else if (!mainWindow.isVisible()) toggleWindow();
  });
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  app.whenReady().then(initializeApplication).catch((error) => {
    console.error(`[quota] application initialization failed: ${error?.stack || error}`);
    app.quit();
  });
  // Keeping a listener makes this tray application remain alive after every
  // window is closed. Electron does not pass an event object here.
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    clearTimeout(saveWindowSizeTimer);
    clearTimeout(hideMenuWindowsTimer);
    clearInterval(automaticRefreshTimer);
    saveSettings();
  });
}
