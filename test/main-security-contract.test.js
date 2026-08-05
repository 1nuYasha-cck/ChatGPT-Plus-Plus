const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("Electron windows use isolated sandboxed renderers and deny privileges", () => {
  const main = read("src/main/main.js");

  assert.equal((main.match(/contextIsolation: true/g) || []).length, 3);
  assert.equal((main.match(/nodeIntegration: false/g) || []).length, 3);
  assert.equal((main.match(/sandbox: true/g) || []).length, 3);
  assert.equal((main.match(/webviewTag: false/g) || []).length, 3);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(main, /setPermissionRequestHandler\([^\n]+callback\(false\)\)/);
  assert.match(main, /"will-download", \(event\) => event\.preventDefault\(\)/);
});

test("tray lifecycle survives window closure and rejects a second instance", () => {
  const main = read("src/main/main.js");

  assert.match(main, /app\.requestSingleInstanceLock\(\)/);
  assert.match(main, /app\.on\("second-instance", \(\) => showMainWindow\(\)\)/);
  assert.match(main, /app\.on\("window-all-closed", \(\) => \{\}\)/);
  assert.doesNotMatch(main, /window-all-closed[^\n]+preventDefault/);
  assert.match(main, /if \(mainWindow === window\) mainWindow = null/);
  assert.match(main, /if \(menuBarWindow === window\) menuBarWindow = null/);
  assert.match(main, /if \(themeMenuWindow === window\) themeMenuWindow = null/);
  assert.match(main, /if \(!isUsableWindow\(mainWindow\)\) createWindow\(\)/);
});

test("quota refresh preserves last good data while reporting retry failures", () => {
  const main = read("src/main/main.js");

  assert.match(main, /let latestQuotaError = null/);
  assert.match(main, /function reportQuotaFailure\(snapshot, failureCount\)/);
  assert.doesNotMatch(main, /onFailure: \(quota\) => updateLatestQuota\(quota\)/);
  assert.match(main, /mainWindow\.webContents\.send\("quota:state-changed", getQuotaState\(\)\)/);
  assert.match(main, /automaticRefreshTimer = setInterval/);
});

test("theme restart happens only after an explicit confirmation", () => {
  const main = read("src/main/main.js");

  assert.match(main, /if \(!\(await confirmThemeRestart\(\)\)\) return \{ cancelled: true \}/);
  assert.match(main, /await operation\(true\)/);
  assert.match(main, /restartRequired && !\(await confirmThemeRestart\(\)\)/);
  assert.doesNotMatch(main, /restoreDefault\(\{ restart: Boolean\(/);
});

test("Windows tray exposes account switching and auth.json import", () => {
  const main = read("src/main/main.js");

  assert.match(main, /label: "全部账号"/);
  assert.match(main, /click: \(\) => void switchAccountFromMenu\(account\.id\)/);
  assert.match(main, /label: "导入 auth\.json…"/);
  assert.match(main, /label: "添加账号…"/);
  assert.match(main, /shell\.openExternal\(authUrl\)/);
  assert.match(main, /registerIpcHandler\("menu-bar:resize"/);
  assert.match(main, /registerIpcHandler\("theme:resize"/);
});

test("account switching requires an explicit ChatGPT restart decision", () => {
  const main = read("src/main/main.js");

  assert.match(main, /必须重启 ChatGPT 才能让新账号生效/);
  assert.match(main, /buttons: runningClients\.length \? \["稍后重启", "立即重启"\]/);
  assert.match(main, /await restartCodexProcesses\(runningClients\)/);
});

test("native restart dialogs stay attached to a visible parent and block menu auto-hide", () => {
  const main = read("src/main/main.js");

  assert.match(main, /if \(nativeDialogDepth > 0\) return/);
  assert.match(main, /isUsableWindow\(themeMenuWindow\) && themeMenuWindow\.isVisible\(\)/);
  assert.match(main, /isUsableWindow\(menuBarWindow\) && menuBarWindow\.isVisible\(\)/);
  assert.match(main, /nativeDialogDepth \+= 1/);
  assert.match(main, /nativeDialogDepth = Math\.max\(0, nativeDialogDepth - 1\)/);
  assert.match(main, /clearTimeout\(hideMenuWindowsTimer\);\r?\n  nativeDialogDepth \+= 1/);
});

test("theme menu is vertically anchored to the clicked theme button", () => {
  const main = read("src/main/main.js");
  const preload = read("src/main/preload-menu-bar.js");

  assert.match(preload, /openThemeMenu: \(anchor\) => ipcRenderer\.invoke\("theme:open-menu", anchor\)/);
  assert.match(main, /calculateThemeMenuPosition\(parentBounds, \{ width, height \}, display\.workArea, themeMenuAnchorTop\)/);
  assert.match(main, /const requestedTop = Number\(anchor\?\.top\)/);
  assert.doesNotMatch(main, /parentBounds\.y \+ 74/);
});
