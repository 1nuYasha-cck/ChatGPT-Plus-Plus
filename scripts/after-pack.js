const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const plist = require("plist");

const UNUSED_PERMISSION_DESCRIPTIONS = Object.freeze([
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription"
]);

function hardenMacInfoPlist(infoPath) {
  const stat = fs.lstatSync(infoPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to edit a non-regular Info.plist: ${infoPath}`);
  }

  const info = plist.parse(fs.readFileSync(infoPath, "utf8"));
  info.NSAppTransportSecurity = {
    NSAllowsArbitraryLoads: false,
    NSAllowsLocalNetworking: true
  };
  for (const key of UNUSED_PERMISSION_DESCRIPTIONS) delete info[key];

  const temporary = `${infoPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, plist.build(info), {
      encoding: "utf8",
      flag: "wx",
      mode: stat.mode & 0o777
    });
    fs.renameSync(temporary, infoPath);
    fs.chmodSync(infoPath, stat.mode & 0o777);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function afterPack(context) {
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "mas") return;
  const productFilename = context.packager.appInfo.productFilename;
  const infoPath = path.join(context.appOutDir, `${productFilename}.app`, "Contents", "Info.plist");
  hardenMacInfoPlist(infoPath);
}

module.exports = afterPack;
module.exports.hardenMacInfoPlist = hardenMacInfoPlist;
module.exports.UNUSED_PERMISSION_DESCRIPTIONS = UNUSED_PERMISSION_DESCRIPTIONS;
