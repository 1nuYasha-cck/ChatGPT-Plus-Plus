const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { listSavedThemes, mapThemeStatus, resolveEngineRoot } = require("../src/main/dream-skin-service");

const validJpeg = fs.readFileSync(path.join(__dirname, "../vendor/codex-dream-skin-studio/presets/preset-arina-hashimoto/background.jpg"));

function makeTheme(root, id, manifest, image = validJpeg) {
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "theme.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, manifest.image), image);
}

test("saved themes are validated and can include renderer-safe previews", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "quota-themes-"));
  try {
    makeTheme(temporary, "valid-theme", { schemaVersion: 1, id: "manifest-id", name: "我的主题", image: "background.jpg" });
    makeTheme(temporary, "bad-name!", { schemaVersion: 1, id: "ignored", name: "ignored", image: "background.jpg" });
    fs.mkdirSync(path.join(temporary, "escaped-theme"));
    fs.writeFileSync(path.join(temporary, "escaped-theme", "theme.json"), JSON.stringify({ image: "../secret.jpg" }));

    const themes = listSavedThemes(temporary, { includePreviews: true });
    assert.equal(themes.length, 1);
    assert.equal(themes[0].id, "valid-theme");
    assert.equal(themes[0].name, "我的主题");
    assert.match(themes[0].previewUrl, /^data:image\/jpeg;base64,/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("theme service status distinguishes healthy, idle, and repairable failures", () => {
  assert.equal(mapThemeStatus({ session: "active", injectorAlive: true, cdpOk: true, codexRunning: true }, { hasActiveTheme: true }).level, "healthy");
  assert.equal(mapThemeStatus({ codexRunning: false }, { hasActiveTheme: true }).level, "idle");
  assert.equal(mapThemeStatus({ session: "stale", codexRunning: true }, { hasActiveTheme: true }).canRepair, true);
  assert.equal(mapThemeStatus({}, { hasActiveTheme: true, mismatch: true }).label, "主题状态不一致");
  assert.equal(mapThemeStatus({}, { engineAvailable: false }).level, "error");
});

test("packaged engine resolves from app resources", () => {
  const resourcesPath = "/Applications/Quota.app/Contents/Resources";
  assert.equal(
    resolveEngineRoot({ packaged: true, resourcesPath }),
    path.join(resourcesPath, "codex-dream-skin-studio")
  );
});
