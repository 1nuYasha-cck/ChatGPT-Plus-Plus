import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  earlyPayloadFor,
  isAuxiliaryOverlayTargetUrl,
  isThemeableAppTargetUrl,
} from "../scripts/injector.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const injectorPath = path.resolve(here, "../scripts/injector.mjs");
const source = await fs.readFile(injectorPath, "utf8");

function createFixture(href = "app://-/index.html") {
  const observers = [];
  const timers = new Map();
  let nextTimer = 1;
  const markers = { shell: false, main: false, sidebar: false };
  const context = {
    window: { installs: [] },
    location: { href, search: new URL(href).search },
    document: {
      documentElement: {},
      querySelector(selector) {
        if (selector === "main.main-surface") return markers.shell ? {} : null;
        if (selector === "main") return markers.main ? {} : null;
        if (selector === "aside.app-shell-left-panel") return markers.sidebar ? {} : null;
        return null;
      },
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.connected = true;
        observers.push(this);
      }
      observe() {}
      disconnect() { this.connected = false; }
    },
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  return { context, markers, observers };
}

assert.equal(isThemeableAppTargetUrl("app://-/index.html"), true);
assert.equal(isThemeableAppTargetUrl("app://-/index.html?route=%2Fhome"), true);
assert.equal(
  isThemeableAppTargetUrl("app://-/index.html?initialRoute=%2Favatar-overlay"),
  false,
  "The pet/avatar renderer must never be considered a themeable Codex page.",
);
assert.equal(
  isAuxiliaryOverlayTargetUrl("app://-/index.html?initialRoute=%2Favatar-overlay"),
  true,
  "The pet/avatar renderer must be recognized for residue cleanup.",
);
assert.equal(isAuxiliaryOverlayTargetUrl("app://-/index.html"), false);
assert.equal(
  isThemeableAppTargetUrl("app://-/index.html?initialRoute=%2Favatar-overlay%2Fpreview"),
  false,
);

const guarded = createFixture();
vm.runInNewContext(earlyPayloadFor('window.installs.push("guarded")', "guarded"), guarded.context);
assert.deepEqual(guarded.context.window.installs, [], "Auxiliary app targets must remain untouched.");
guarded.markers.shell = true;
guarded.observers[0].callback([]);
assert.deepEqual(guarded.context.window.installs, [], "A main surface without the Codex sidebar is not sufficient.");

const currentCodex = createFixture();
currentCodex.markers.main = true;
currentCodex.markers.sidebar = true;
vm.runInNewContext(earlyPayloadFor('window.installs.push("current")', "current"), currentCodex.context);
assert.deepEqual(
  currentCodex.context.window.installs,
  ["current"],
  "The current Codex shell must be accepted when its semantic main no longer has the legacy class.",
);

const avatarOverlay = createFixture("app://-/index.html?initialRoute=%2Favatar-overlay");
avatarOverlay.markers.shell = true;
avatarOverlay.markers.sidebar = true;
vm.runInNewContext(earlyPayloadFor('window.installs.push("avatar")', "avatar"), avatarOverlay.context);
assert.deepEqual(
  avatarOverlay.context.window.installs,
  [],
  "The early bootstrap must reject the avatar overlay even if it transiently exposes main-shell markers.",
);

const generations = createFixture();
vm.runInNewContext(earlyPayloadFor('window.installs.push("old")', "old"), generations.context);
vm.runInNewContext(earlyPayloadFor('window.installs.push("new")', "new"), generations.context);
generations.markers.shell = true;
generations.markers.sidebar = true;
for (const observer of generations.observers) observer.callback([]);
assert.deepEqual(
  generations.context.window.installs,
  ["new"],
  "A stale early script must yield to the newest watcher generation.",
);
assert.equal(generations.context.window.__CODEX_DREAM_SKIN_EARLY_APPLIED__, "new");

assert.equal(source.includes("Page.addScriptToEvaluateOnNewDocument"), false,
  "The watcher must not persist injection into avatar/pet auxiliary renderers.");
const probeStart = source.indexOf("const probe = await waitForCodexProbe");
const injectStart = source.indexOf("await applyToSession(session, current.payload)", probeStart);
assert.ok(probeStart >= 0 && injectStart > probeStart,
  "The full payload must run only after a ChatGPT renderer probe succeeds.");
assert.match(
  source,
  /const suggestionLabelColorsMatch = visibleSuggestionLabels\.every\(/,
  "Live verification must compare themed suggestion label colors.",
);
assert.match(
  source,
  /visibleSuggestionLabels\.length >= result\.visibleCardCount\s*&&\s*result\.suggestionLabelColorsMatch/,
  "Live verification must reject visible home suggestion labels that diverge from the themed card color.",
);
assert.match(
  source,
  /result\.homeLayoutWithinViewport = !result\.homeRoute[\s\S]{0,400}insideViewport\(result\.composer\)/,
  "Live verification must reject a home route whose composer was pushed below the viewport.",
);
assert.match(
  source,
  /stateTtl = \(value\) => value === "loading" \? 30000[\s\S]{0,100}value === "success" \? 900/,
  "Operation UI must have a short success lifetime and a bounded loading lifetime.",
);
assert.match(
  source,
  /runFinishOperation[\s\S]{0,2200}"clear"[\s\S]{0,1400}"hide"/,
  "A completed apply must clear stale hosts and explicitly hide its success UI.",
);
assert.match(
  source,
  /cleanAuxiliaryOverlaySession[\s\S]{0,900}chatgpt-dream-skin-operation[\s\S]{0,300}__CHATGPT_DREAM_SKIN_OPERATION_UI__/,
  "The watcher must remove legacy skin and operation residue from the avatar overlay.",
);

console.log("PASS: early injection is target-safe, generation-safe, operation-safe, and removed on shutdown.");
