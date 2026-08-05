const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("../package.json");
const { auditResourceTree } = require("../scripts/audit-package-privacy");
const { transformImage } = require("../scripts/image-privacy");

const projectRoot = path.join(__dirname, "..");

test("packaging uses explicit product allowlists instead of copying the workspace", () => {
  assert.deepEqual(packageJson.build.files, ["src/**/*", "assets/icon.*", "package.json"]);
  assert.equal(packageJson.build.extraResources.length, 1);
  assert.equal(packageJson.build.extraResources[0].from, "vendor/codex-dream-skin-studio");
  assert.doesNotMatch(JSON.stringify(packageJson.build), /artifacts|auth\.json|accounts\.json|settings\.json|login-staging|backups/);
  assert.match(packageJson.scripts.build, /audit-package-privacy\.js --win/);
  assert.match(packageJson.scripts["build:mac"], /audit-package-privacy\.js --mac/);
});

test("first-run account and settings data resolve from the current machine", () => {
  const main = fs.readFileSync(path.join(projectRoot, "src/main/main.js"), "utf8");
  const store = fs.readFileSync(path.join(projectRoot, "src/main/account-store.js"), "utf8");
  assert.match(main, /app\.getPath\("userData"\)/);
  assert.match(store, /path\.join\(os\.homedir\(\), "\.chatgpt-plus-plus"\)/);
  assert.match(store, /path\.join\(os\.homedir\(\), "\.codex"\)/);
  assert.doesNotMatch(main, /\/Users\/[A-Za-z0-9._-]+\//);
  assert.doesNotMatch(store, /\/Users\/[A-Za-z0-9._-]+\//);
});

test("packaged image sources contain no EXIF, XMP, text, comment, or Photoshop metadata", () => {
  const images = [
    "assets/icon.png",
    "assets/icon.ico",
    "assets/icon.icns",
    "vendor/codex-dream-skin-studio/presets/preset-arina-hashimoto/background.jpg",
    "vendor/codex-dream-skin-studio/presets/preset-gothic-void-crusade/background.jpg"
  ];
  for (const relative of images) {
    const filePath = path.join(projectRoot, relative);
    const result = transformImage(fs.readFileSync(filePath), path.extname(filePath), false);
    assert.deepEqual(result.sensitive, [], `${relative} contains ${result.sensitive.join(",")}`);
  }
});

test("allowlisted extra-resource source has no local identity or credential material", () => {
  const findings = [];
  const checked = auditResourceTree(path.join(projectRoot, "vendor/codex-dream-skin-studio"), findings);
  assert.ok(checked > 0);
  assert.deepEqual(findings, []);
});
