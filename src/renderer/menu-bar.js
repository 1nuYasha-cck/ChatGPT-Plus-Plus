const elements = {
  currentIdentity: document.getElementById("currentIdentity"),
  currentPlan: document.getElementById("currentPlan"),
  accountMeta: document.getElementById("accountMeta"),
  summaryLabel: document.getElementById("summaryLabel"),
  summaryPercent: document.getElementById("summaryPercent"),
  currentAccount: document.getElementById("currentAccount"),
  allAccountsBtn: document.getElementById("allAccountsBtn"),
  accountCount: document.getElementById("accountCount"),
  accountList: document.getElementById("accountList"),
  accountActions: document.getElementById("accountActions"),
  addAccountBtn: document.getElementById("addAccountBtn"),
  importAccountBtn: document.getElementById("importAccountBtn"),
  statusMessage: document.getElementById("statusMessage"),
  toggleWidgetBtn: document.getElementById("toggleWidgetBtn"),
  toggleWidgetText: document.getElementById("toggleWidgetText"),
  refreshBtn: document.getElementById("refreshBtn"),
  themeBtn: document.getElementById("themeBtn"),
  themeStatusDot: document.getElementById("themeStatusDot"),
  themeStatusText: document.getElementById("themeStatusText"),
  autoLaunchInput: document.getElementById("autoLaunchInput"),
  refreshIntervalInput: document.getElementById("refreshIntervalInput"),
  quotaSources: Array.from(document.querySelectorAll('input[name="quotaSource"]')),
  quitBtn: document.getElementById("quitBtn")
};

let currentState = null;

function percentValue(account, source) {
  const value = account?.quota?.[source]?.remainingPercent;
  return Number.isFinite(value) ? value : null;
}

function formatPercentValue(value) {
  return Number.isFinite(value) ? `${value}%` : "--%";
}

function formatDate(value) {
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2020) return null;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(date).replaceAll("/", "-");
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未更新";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function planLabel(value) {
  const text = String(value || "unknown").toUpperCase();
  return text === "TEAM" ? "BUSINESS" : text;
}

function identity(account) {
  return account?.email || account?.name || "未识别账号";
}

function metadata(account) {
  const free = String(account?.planType || "").toLowerCase() === "free";
  const expiry = formatDate(account?.subscriptionExpiresAt);
  const left = free ? "免费账户" : expiry ? `到期 ${expiry}` : "到期时间未提供";
  return `${left} · 更新 ${formatTime(account?.quotaUpdatedAt || account?.quota?.fetchedAt)}`;
}

function createAccountRow(account, source, selectable) {
  const value = percentValue(account, source);
  const level = window.WidgetLogic.getLevel(value, null, false);
  const row = document.createElement(selectable ? "button" : "div");
  row.className = `account-row${selectable ? " selectable-account" : ""}`;
  if (!selectable) row.classList.add("current-account");
  row.title = identity(account);
  if (selectable) {
    row.type = "button";
    row.dataset.accountId = account.id;
    row.disabled = Boolean(currentState?.switchingAccountId);
  }

  const check = document.createElement("span");
  check.className = "account-check";
  check.textContent = account.isActive ? "✓" : "";
  const copy = document.createElement("span");
  copy.className = "account-copy";
  const title = document.createElement("span");
  title.className = "account-title";
  title.textContent = identity(account);
  const meta = document.createElement("small");
  meta.textContent = metadata(account);
  copy.append(title, meta);
  const plan = document.createElement("span");
  plan.className = "plan-chip";
  plan.dataset.plan = String(account.planType || "unknown").toLowerCase();
  plan.textContent = planLabel(account.planType);
  const percent = document.createElement("strong");
  percent.className = "account-percent";
  percent.dataset.level = level;
  percent.textContent = formatPercentValue(value);
  const rail = document.createElement("span");
  rail.className = "quota-rail";
  const fill = document.createElement("i");
  fill.dataset.level = level;
  fill.style.width = `${Number.isFinite(value) ? value : 0}%`;
  rail.append(fill);
  row.append(check, copy, plan, percent, rail);
  if (selectable) row.addEventListener("click", () => performAction("switch-account", account.id));
  return row;
}

function renderAccounts(state, source) {
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  const active = accounts.find((account) => account.isActive) || null;
  elements.accountCount.textContent = String(accounts.length);
  elements.currentIdentity.textContent = identity(active);
  elements.currentPlan.textContent = planLabel(active?.planType);
  elements.accountMeta.textContent = metadata(active);
  const currentRow = active ? createAccountRow(active, source, false) : document.createElement("div");
  currentRow.classList.add("current-account");
  if (!active) currentRow.textContent = "未找到已登录账号";
  elements.currentAccount.replaceWith(currentRow);
  elements.currentAccount = currentRow;

  const expanded = Boolean(state?.accountsExpanded);
  elements.allAccountsBtn.setAttribute("aria-expanded", String(expanded));
  elements.accountList.hidden = !expanded;
  elements.accountActions.hidden = !expanded;
  elements.accountList.replaceChildren();
  if (expanded) {
    for (const account of accounts.filter((item) => !item.isActive)) {
      elements.accountList.append(createAccountRow(account, source, true));
    }
    if (accounts.length <= 1) {
      const empty = document.createElement("p");
      empty.className = "empty-accounts";
      empty.textContent = "暂无其他账号，点击下方按钮登录添加";
      elements.accountList.append(empty);
    }
  }
}

function render(state) {
  currentState = state;
  const source = state?.quotaSource === "fiveHour" ? "fiveHour" : "weekly";
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  const active = accounts.find((account) => account.isActive);
  const quota = active?.quota || state?.quota;
  const selectedWindow = quota?.[source];
  const remaining = selectedWindow?.remainingPercent;
  document.body.dataset.refreshing = String(Boolean(state?.refreshing));
  document.body.dataset.switching = String(Boolean(state?.switchingAccountId));
  document.body.dataset.adding = String(Boolean(state?.addingAccount));
  elements.summaryLabel.textContent = source === "fiveHour" ? "5小时剩余额度" : "7天剩余额度";
  elements.summaryPercent.textContent = formatPercentValue(remaining);
  elements.summaryPercent.dataset.level = window.WidgetLogic.getLevel(remaining, null, false);
  renderAccounts(state, source);

  const message = state?.accountStatusMessage || active?.quotaError || state?.quotaError || "";
  elements.statusMessage.hidden = !message;
  elements.statusMessage.textContent = message;
  const themeStatus = state?.theme?.status || {};
  elements.themeStatusDot.dataset.level = themeStatus.level || "idle";
  elements.themeStatusText.textContent = themeStatus.level === "healthy" ? "正常" : themeStatus.level === "error" ? "异常" : themeStatus.level === "busy" ? "处理中" : themeStatus.level === "warning" ? "待修复" : "待机";
  elements.toggleWidgetText.textContent = state?.widgetVisible ? "隐藏小组件" : "显示小组件";
  elements.autoLaunchInput.checked = Boolean(state?.autoLaunch);
  elements.refreshIntervalInput.value = String(state?.refreshIntervalMinutes || 5);
  for (const input of elements.quotaSources) input.checked = input.value === source;
  elements.addAccountBtn.disabled = Boolean(state?.addingAccount);
  elements.addAccountBtn.textContent = state?.addingAccount ? "正在等待官方登录…" : "＋ 添加账号";
  scheduleContentResize();
}

let resizeFrame = null;
function scheduleContentResize() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    const height = Math.ceil(document.querySelector(".popover")?.scrollHeight || document.body.scrollHeight);
    window.codexMenuBar.resizeToContent(height).catch(() => {});
  });
}

async function performAction(action, value) {
  try {
    const nextState = await window.codexMenuBar.performAction(action, value);
    if (nextState) render(nextState);
  } catch (error) {
    const message = `操作失败：${String(error?.message || error).slice(0, 100)}`;
    if (currentState) render({ ...currentState, accountStatusMessage: message, refreshing: false, switchingAccountId: null });
  }
}

elements.allAccountsBtn.addEventListener("click", () => performAction("set-accounts-expanded", !currentState?.accountsExpanded));
elements.addAccountBtn.addEventListener("click", () => performAction("add-account"));
elements.importAccountBtn.addEventListener("click", () => performAction("import-account"));
elements.toggleWidgetBtn.addEventListener("click", () => performAction("toggle-widget"));
elements.refreshBtn.addEventListener("click", () => performAction("refresh"));
function openThemeMenuSafely() {
  const rect = elements.themeBtn.getBoundingClientRect();
  const anchor = { top: rect.top, bottom: rect.bottom };
  window.codexMenuBar.openThemeMenu(anchor).catch(() => { elements.themeStatusDot.dataset.level = "error"; });
}
elements.themeBtn.addEventListener("click", openThemeMenuSafely);
elements.quitBtn.addEventListener("click", () => performAction("quit"));
elements.autoLaunchInput.addEventListener("change", () => performAction("set-auto-launch", elements.autoLaunchInput.checked));
elements.refreshIntervalInput.addEventListener("change", () => performAction("set-refresh-interval", Number(elements.refreshIntervalInput.value)));
for (const input of elements.quotaSources) input.addEventListener("change", () => input.checked && performAction("set-quota-source", input.value));

window.codexMenuBar.onStateChanged(render);
window.codexMenuBar.getState().then(render).catch((error) => {
  elements.accountMeta.textContent = `初始化失败：${String(error?.message || error).slice(0, 80)}`;
});
