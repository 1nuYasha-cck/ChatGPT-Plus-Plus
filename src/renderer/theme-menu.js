const elements = {
  serviceDot: document.getElementById("serviceDot"),
  serviceLabel: document.getElementById("serviceLabel"),
  serviceMessage: document.getElementById("serviceMessage"),
  repairBtn: document.getElementById("repairBtn"),
  newThemeBtn: document.getElementById("newThemeBtn"),
  savedThemesBtn: document.getElementById("savedThemesBtn"),
  newThemeForm: document.getElementById("newThemeForm"),
  themeNameInput: document.getElementById("themeNameInput"),
  actionMessage: document.getElementById("actionMessage"),
  savedPanel: document.getElementById("savedPanel"),
  themeList: document.getElementById("themeList"),
  themeCount: document.getElementById("themeCount"),
  emptyThemes: document.getElementById("emptyThemes")
};

let currentState = null;
let savedThemesLoaded = false;
let actionInProgress = false;
let hideSavedThemesTimer = null;
let resizeFrame = null;

function scheduleContentResize() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    const shell = document.querySelector(".theme-shell");
    const height = Math.ceil(shell?.getBoundingClientRect().height || document.body.scrollHeight);
    window.codexThemeMenu.resizeToContent(height).catch(() => {});
  });
}

function setActionMessage(message = "", level = "") {
  elements.actionMessage.textContent = message;
  elements.actionMessage.dataset.level = level;
  scheduleContentResize();
}

function setBusy(busy) {
  actionInProgress = busy;
  for (const button of document.querySelectorAll("button")) button.disabled = busy;
}

function renderState(state) {
  currentState = state;
  const status = state?.status || {};
  elements.serviceDot.dataset.level = status.level || "idle";
  elements.serviceLabel.textContent = status.label || "主题服务";
  elements.serviceMessage.textContent = status.message || state?.themeName || "";
  elements.repairBtn.hidden = !status.canRepair;
  setBusy(Boolean(state?.busy) || actionInProgress);
  scheduleContentResize();
}

function renderThemes(themes) {
  elements.themeList.replaceChildren();
  elements.themeCount.textContent = String(themes.length);
  elements.emptyThemes.hidden = themes.length > 0;
  // The active directory is authoritative.  A stale injector record must not
  // make two saved themes look selected at the same time.
  const activeIds = new Set([currentState?.themeId, currentState?.raw?.themeId].filter(Boolean));
  for (const theme of themes) {
    const active = activeIds.has(theme.id) || activeIds.has(theme.manifestId);
    const button = document.createElement("button");
    button.className = "theme-card";
    button.type = "button";
    button.dataset.active = String(active);

    const image = document.createElement("img");
    image.hidden = !theme.previewUrl;
    if (theme.previewUrl) image.src = theme.previewUrl;
    image.alt = "";
    const name = document.createElement("strong");
    name.textContent = theme.name;
    const mark = document.createElement("span");
    mark.className = "active-mark";
    mark.textContent = active ? "✓" : "";
    button.append(image, name, mark);
    button.addEventListener("click", () => performAction("switch", theme.id));
    elements.themeList.append(button);
  }
  scheduleContentResize();
}

async function showSavedThemes() {
  clearTimeout(hideSavedThemesTimer);
  elements.savedPanel.hidden = false;
  elements.savedThemesBtn.dataset.open = "true";
  elements.savedThemesBtn.setAttribute("aria-expanded", "true");
  if (!savedThemesLoaded) {
    const themes = await window.codexThemeMenu.listThemes();
    renderThemes(themes);
    savedThemesLoaded = true;
  }
  scheduleContentResize();
}

function hideSavedThemes() {
  clearTimeout(hideSavedThemesTimer);
  elements.savedPanel.hidden = true;
  elements.savedThemesBtn.dataset.open = "false";
  elements.savedThemesBtn.setAttribute("aria-expanded", "false");
  scheduleContentResize();
}

function scheduleHideSavedThemes() {
  clearTimeout(hideSavedThemesTimer);
  hideSavedThemesTimer = setTimeout(() => {
    if (!elements.savedThemesBtn.matches(":hover") && !elements.savedPanel.matches(":hover")) {
      hideSavedThemes();
    }
  }, 180);
}

async function performAction(action, value) {
  if (actionInProgress) return;
  setBusy(true);
  setActionMessage("正在处理…");
  try {
    const result = await window.codexThemeMenu.performAction(action, value);
    if (result?.state) renderState(result.state);
    if (result?.error) setActionMessage(result.error, "error");
    else if (result?.cancelled) setActionMessage("操作已取消");
    else setActionMessage(result?.message || "操作已完成");
    savedThemesLoaded = false;
    if (!elements.savedPanel.hidden) await showSavedThemes();
  } catch (error) {
    setActionMessage(error?.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", () => performAction(button.dataset.action));
}
elements.repairBtn.addEventListener("click", () => performAction("repair"));
elements.savedThemesBtn.addEventListener("mouseenter", showSavedThemes);
elements.savedThemesBtn.addEventListener("mouseleave", scheduleHideSavedThemes);
elements.savedPanel.addEventListener("mouseenter", () => clearTimeout(hideSavedThemesTimer));
elements.savedPanel.addEventListener("mouseleave", scheduleHideSavedThemes);
elements.newThemeBtn.addEventListener("click", () => {
  elements.newThemeForm.hidden = !elements.newThemeForm.hidden;
  if (!elements.newThemeForm.hidden) elements.themeNameInput.focus();
  scheduleContentResize();
});
elements.newThemeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const themeName = elements.themeNameInput.value.trim();
  elements.newThemeForm.hidden = true;
  elements.themeNameInput.value = "";
  performAction("create", themeName);
});

hideSavedThemes();

new ResizeObserver(scheduleContentResize).observe(document.querySelector(".theme-shell"));

window.codexThemeMenu.onStateChanged(renderState);
window.codexThemeMenu.getState().then(renderState);
