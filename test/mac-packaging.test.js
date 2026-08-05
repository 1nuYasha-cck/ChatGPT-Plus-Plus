const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const plist = require("plist");
const { FuseV1Options, getCurrentFuseWire } = require("@electron/fuses");

const packageJson = require("../package.json");
const {
  UNUSED_PERMISSION_DESCRIPTIONS,
  hardenMacInfoPlist
} = require("../scripts/after-pack");

test("macOS build embeds the app icon and keeps the local ad-hoc build usable", () => {
  const buildScript = packageJson.scripts["build:mac"];

  assert.match(buildScript, /electron-builder --mac dir --arm64/);
  assert.match(buildScript, /codesign --force --deep --sign -/);
  assert.match(buildScript, /--identifier cn\.chatgptplusplus\.desktop/);
  assert.equal(packageJson.build.appId, "cn.chatgptplusplus.desktop");
  assert.equal(packageJson.build.mac.icon, "assets/icon.icns");
  assert.equal(packageJson.build.afterPack, "scripts/after-pack.js");
});

test("Electron release fuses disable Node launch overrides and enforce ASAR integrity", () => {
  assert.deepEqual(packageJson.build.electronFuses, {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: true
  });
});

test("macOS transport policy denies arbitrary loads and strips unused permission descriptions", () => {
  assert.deepEqual(packageJson.build.mac.extendInfo.NSAppTransportSecurity, {
    NSAllowsArbitraryLoads: false,
    NSAllowsLocalNetworking: true
  });

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "quota-info-plist-"));
  const infoPath = path.join(temporary, "Info.plist");
  const fixture = {
    CFBundleIdentifier: packageJson.build.appId,
    NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
    NSCameraUsageDescription: "camera",
    NSMicrophoneUsageDescription: "microphone",
    NSBluetoothAlwaysUsageDescription: "bluetooth",
    UnrelatedKey: "preserved"
  };
  try {
    fs.writeFileSync(infoPath, plist.build(fixture));
    hardenMacInfoPlist(infoPath);
    const result = plist.parse(fs.readFileSync(infoPath, "utf8"));
    assert.deepEqual(result.NSAppTransportSecurity, {
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: true
    });
    for (const key of UNUSED_PERMISSION_DESCRIPTIONS) assert.equal(key in result, false);
    assert.equal(result.UnrelatedKey, "preserved");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("packaged Dream Skin resources use a runtime-only allowlist", () => {
  const resource = packageJson.build.extraResources.find((item) =>
    item.from === "vendor/codex-dream-skin-studio" && item.to === "codex-dream-skin-studio"
  );
  assert.ok(resource);
  assert.doesNotMatch(resource.filter.join("\n"), /\*\*\/\*/);
  assert.ok(resource.filter.includes("assets/dream-skin.css"));
  assert.ok(resource.filter.includes("assets/renderer-inject.js"));
  assert.ok(resource.filter.includes("presets/preset-*/theme.json"));
  for (const script of [
    "common-macos.sh",
    "image-metadata.mjs",
    "injector.mjs",
    "load-image-theme-macos.sh",
    "prepare-theme-image.jxa",
    "restore-dream-skin-macos.sh",
    "stage-theme.mjs",
    "start-dream-skin-macos.sh",
    "status-dream-skin-macos.sh",
    "switch-theme-macos.sh",
    "theme-config.mjs",
    "write-theme.mjs"
  ]) {
    assert.ok(resource.filter.includes(`scripts/${script}`), `missing runtime script ${script}`);
  }
});

test("packaged macOS bundle has enforced fuses, narrow permissions, and no launcher files", async (t) => {
  const appPath = process.env.CHATGPT_QUOTA_PACKAGED_APP ||
    path.join(__dirname, "../dist/mac-arm64/ChatGPT++.app");
  if (process.platform !== "darwin" || !fs.existsSync(appPath)) {
    t.skip("packaged macOS app is not available");
    return;
  }

  const wire = await getCurrentFuseWire(appPath);
  const disabled = "0".charCodeAt(0);
  const enabled = "1".charCodeAt(0);
  assert.equal(wire[FuseV1Options.RunAsNode], disabled);
  assert.equal(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable], disabled);
  assert.equal(wire[FuseV1Options.EnableNodeCliInspectArguments], disabled);
  assert.equal(wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], enabled);
  assert.equal(wire[FuseV1Options.OnlyLoadAppFromAsar], enabled);
  assert.equal(wire[FuseV1Options.GrantFileProtocolExtraPrivileges], enabled);

  const info = plist.parse(fs.readFileSync(path.join(appPath, "Contents/Info.plist"), "utf8"));
  assert.equal(info.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  assert.equal(info.NSAppTransportSecurity.NSAllowsLocalNetworking, true);
  for (const key of UNUSED_PERMISSION_DESCRIPTIONS) assert.equal(key in info, false);

  const engineRoot = path.join(appPath, "Contents/Resources/codex-dream-skin-studio");
  assert.equal(fs.existsSync(path.join(engineRoot, "Start Codex Dream Skin.command")), false);
  assert.equal(fs.existsSync(path.join(engineRoot, "README.md")), false);
  assert.equal(fs.existsSync(path.join(engineRoot, "tests")), false);
  assert.equal(fs.existsSync(path.join(engineRoot, "assets/dream-skin.css")), true);
  assert.equal(fs.existsSync(path.join(engineRoot, "scripts/start-dream-skin-macos.sh")), true);
});

test("macOS Dock icon is not overridden at runtime", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const dockSource = fs.readFileSync(path.join(__dirname, "../src/main/dock-visibility.js"), "utf8");

  assert.doesNotMatch(mainSource, /dock\.setIcon|setDockIcon|getDockIcon/);
  assert.doesNotMatch(dockSource, /dock\.setIcon|setDockIcon|getDockIcon/);
});
