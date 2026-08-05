const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("main and menu renderers share the approved quota palette", () => {
  const widgetStyles = read("src/renderer/styles.css").toLowerCase();
  const menuStyles = read("src/renderer/menu-bar.css").toLowerCase();

  for (const color of ["#34c98f", "#f2b84b", "#ff5c5c"]) {
    assert.match(widgetStyles, new RegExp(color));
    assert.match(menuStyles, new RegExp(color));
  }
});

test("read health stays separate from quota severity", () => {
  const renderer = read("src/renderer/renderer.js");

  assert.match(renderer, /healthLevel = state\.error \? "error" : state\.loading \|\| !quota \? "loading" : "ready"/);
  assert.match(renderer, /fiveHourCard\.dataset\.level = fiveHourLevel/);
  assert.match(renderer, /weeklyCard\.dataset\.level = weeklyLevel/);
  assert.match(renderer, /liquidMeter\.dataset\.level = liquidLevel/);
});

test("widget tolerates invalid persisted language and keeps the last good quota on refresh errors", () => {
  const renderer = read("src/renderer/renderer.js");

  assert.match(renderer, /function normalizeLanguage\(value\)/);
  assert.match(renderer, /return value === "en" \? "en" : "zh"/);
  assert.match(renderer, /if \(!nextError && nextQuota\) state\.quota = nextQuota/);
  assert.doesNotMatch(renderer, /catch \(error\) \{\s*state\.quota = null/);
  assert.match(renderer, /init\(\)\.catch\(reportIpcError\)/);
});

test("main process owns refresh scheduling and renderer consumes quota state broadcasts", () => {
  const renderer = read("src/renderer/renderer.js");
  const preload = read("src/main/preload.js");

  assert.doesNotMatch(renderer, /setInterval\(/);
  assert.doesNotMatch(renderer, /function scheduleRefresh/);
  assert.match(renderer, /onQuotaStateChanged\(applyQuotaState\)/);
  assert.match(preload, /onQuotaStateChanged: \(callback\) => subscribe\("quota:state-changed", callback\)/);
  assert.match(preload, /ipcRenderer\.removeListener\(channel, listener\)/);
});

test("reset time is separated by whitespace instead of a slash", () => {
  const renderer = read("src/renderer/renderer.js");

  assert.doesNotMatch(renderer, /` \/ \$\{includeDate/);
  assert.match(renderer, /` \$\{includeDate/);
});

test("menu percentage uses shared quota threshold logic", () => {
  const menuHtml = read("src/renderer/menu-bar.html");
  const menuRenderer = read("src/renderer/menu-bar.js");

  assert.match(menuHtml, /widget-logic\.js/);
  assert.match(menuRenderer, /summaryPercent\.dataset\.level = window\.WidgetLogic\.getLevel/);
});

test("menu bar exposes the integrated theme entry and service status", () => {
  const menuHtml = read("src/renderer/menu-bar.html");
  const menuRenderer = read("src/renderer/menu-bar.js");
  const themeHtml = read("src/renderer/theme-menu.html");

  assert.match(menuHtml, /id="themeBtn"/);
  assert.match(menuHtml, /id="themeStatusDot"/);
  assert.match(menuHtml, />ChatGPT主题</);
  assert.match(menuRenderer, /openThemeMenu/);
  assert.match(menuRenderer, /themeBtn\.addEventListener\("click", openThemeMenuSafely\)/);
  assert.doesNotMatch(menuRenderer, /themeBtn\.addEventListener\("mouseenter"/);
  assert.match(menuRenderer, /themeBtn\.getBoundingClientRect\(\)/);
  assert.match(menuRenderer, /openThemeMenu\(anchor\)/);
  assert.match(themeHtml, /<title>ChatGPT主题<\/title>/);
  for (const label of ["重新加载", "恢复默认", "新建主题", "已保存主题", "修复"]) {
    assert.match(themeHtml, new RegExp(label));
  }
});

test("theme menu reports its actual content height instead of preserving bottom padding", () => {
  const preload = read("src/main/preload-theme-menu.js");
  const renderer = read("src/renderer/theme-menu.js");
  const css = read("src/renderer/theme-menu.css");
  const main = read("src/main/main.js");

  assert.match(preload, /resizeToContent: \(height\) => ipcRenderer\.invoke\("theme:resize", height\)/);
  assert.match(renderer, /getBoundingClientRect\(\)\.height/);
  assert.match(renderer, /new ResizeObserver\(scheduleContentResize\)/);
  assert.match(css, /\.theme-panel \{[\s\S]*min-height: 0/);
  assert.match(css, /\.action-message:empty \{ display: none; \}/);
  assert.match(main, /registerIpcHandler\("theme:resize"/);
});

test("menu bar switches accounts by selecting rows inside the expandable all-accounts section", () => {
  const menuHtml = read("src/renderer/menu-bar.html");
  const menuRenderer = read("src/renderer/menu-bar.js");

  assert.match(menuHtml, /id="allAccountsBtn"/);
  assert.match(menuHtml, /id="addAccountBtn"/);
  assert.match(menuHtml, />＋ 添加账号</);
  assert.match(menuHtml, />全部账号</);
  assert.doesNotMatch(menuHtml, /全部账号（7天）|切换账号/);
  assert.match(menuRenderer, /performAction\("switch-account", account\.id\)/);
  assert.match(menuRenderer, /accounts\.filter\(\(item\) => !item\.isActive\)/);
  assert.match(menuRenderer, /performAction\("set-accounts-expanded"/);
  assert.match(menuRenderer, /performAction\("add-account"/);
  assert.match(menuRenderer, /date\.getUTCFullYear\(\) < 2020/);
});

test("theme library is hover-only and the create form closes after submit", () => {
  const themeRenderer = read("src/renderer/theme-menu.js");

  assert.match(themeRenderer, /savedThemesBtn\.addEventListener\("mouseenter", showSavedThemes\)/);
  assert.match(themeRenderer, /savedThemesBtn\.addEventListener\("mouseleave", scheduleHideSavedThemes\)/);
  assert.match(themeRenderer, /savedPanel\.addEventListener\("mouseleave", scheduleHideSavedThemes\)/);
  assert.doesNotMatch(themeRenderer, /savedThemesBtn\.addEventListener\("click", showSavedThemes\)/);
  assert.match(themeRenderer, /newThemeForm\.hidden = true;\s*elements\.themeNameInput\.value = "";\s*performAction\("create"/);
});
