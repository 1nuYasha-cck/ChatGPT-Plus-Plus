import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(here, "..");
const outputPath = path.resolve(
  process.argv[2] || path.join(engineRoot, "../../src/main/dream-skin-integrity.json"),
);

// Must stay identical to the packaged macOS runtime allowlist. Tests and
// launchers are intentionally absent from the installed application.
const runtimeFiles = [
  "assets/dream-skin.css", "assets/renderer-inject.js",
  "presets/preset-arina-hashimoto/background.jpg", "presets/preset-arina-hashimoto/theme.json",
  "presets/preset-gothic-void-crusade/background.jpg", "presets/preset-gothic-void-crusade/theme.json",
  "scripts/common-macos.sh", "scripts/image-metadata.mjs", "scripts/injector.mjs",
  "scripts/load-image-theme-macos.sh", "scripts/prepare-theme-image.jxa",
  "scripts/restore-dream-skin-macos.sh", "scripts/stage-theme.mjs",
  "scripts/start-dream-skin-macos.sh", "scripts/status-dream-skin-macos.sh",
  "scripts/switch-theme-macos.sh", "scripts/theme-config.mjs", "scripts/write-theme.mjs",
];
const files = {};
for (const relativeName of runtimeFiles) {
  const absoluteName = path.join(engineRoot, ...relativeName.split("/"));
  const stat = await fs.lstat(absoluteName);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Invalid runtime engine entry: ${relativeName}`);
  const bytes = await fs.readFile(absoluteName);
  files[relativeName] = { size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
const sortedFiles = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right, "en")));
const manifest = `${JSON.stringify({ schemaVersion: 1, algorithm: "sha256", files: sortedFiles }, null, 2)}\n`;
await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
const temporary = `${outputPath}.${process.pid}.tmp`;
try {
  await fs.writeFile(temporary, manifest, { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, outputPath);
} finally {
  await fs.rm(temporary, { force: true }).catch(() => {});
}
console.log(`Wrote ${Object.keys(sortedFiles).length} integrity entries to ${outputPath}`);
