const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const { transformImage } = require("./image-privacy");

const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".md", ".mjs", ".sh", ".svg", ".toml", ".txt"]);
const IMAGE_EXTENSIONS = new Set([".icns", ".ico", ".jpeg", ".jpg", ".png"]);
const FORBIDDEN_ENTRY_PATTERNS = [
  /(^|\/)(?:auth|accounts|settings)\.json$/i,
  /(^|\/)(?:artifacts|backups|login-staging|logs?|sessions)(\/|$)/i,
  /(^|\/)\.env(?:\.|$)/i
];
const SENSITIVE_TEXT_PATTERNS = [
  { label: "macOS user home", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { label: "Linux user home", pattern: /\/home\/[A-Za-z0-9._-]+\// },
  { label: "Windows user home", pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/i },
  { label: "email address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { label: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: "JWT token", pattern: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/ },
  { label: "stored access token", pattern: /["']access_token["']\s*:\s*["'][A-Za-z0-9._-]{20,}["']/i },
  { label: "stored refresh token", pattern: /["']refresh_token["']\s*:\s*["'][A-Za-z0-9._-]{20,}["']/i }
];

function assertSafeEntryName(name, findings) {
  const normalized = String(name || "").replaceAll("\\", "/").replace(/^\/+/, "");
  for (const pattern of FORBIDDEN_ENTRY_PATTERNS) {
    if (pattern.test(normalized)) findings.push(`${normalized}: forbidden user-data path`);
  }
}

function scanText(bytes, label, findings) {
  const text = bytes.toString("utf8");
  for (const check of SENSITIVE_TEXT_PATTERNS) {
    if (check.pattern.test(text)) findings.push(`${label}: ${check.label}`);
  }
}

function scanImage(bytes, extension, label, findings) {
  const result = transformImage(bytes, extension, false);
  if (result.sensitive.length) findings.push(`${label}: metadata ${result.sensitive.join(",")}`);
}

function scanControlledFile(bytes, name, findings) {
  const extension = path.extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) scanText(bytes, name, findings);
  if (IMAGE_EXTENSIONS.has(extension)) scanImage(bytes, extension, name, findings);
}

function auditAsar(archivePath, findings) {
  const entries = asar.listPackage(archivePath);
  let fileCount = 0;
  for (const entry of entries) {
    const normalized = entry.replace(/^\/+/, "");
    assertSafeEntryName(normalized, findings);
    const stat = asar.statFile(archivePath, normalized);
    if (stat.link) {
      findings.push(`app.asar/${normalized}: packaged symlink`);
      continue;
    }
    if (stat.files) continue;
    fileCount += 1;
    scanControlledFile(asar.extractFile(archivePath, normalized), `app.asar/${normalized}`, findings);
  }
  return fileCount;
}

function walkFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Packaged resource cannot be a symlink: ${target}`);
    if (entry.isDirectory()) files.push(...walkFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function auditResourceTree(root, findings) {
  const files = walkFiles(root);
  for (const filePath of files) {
    const relative = path.relative(root, filePath).replaceAll(path.sep, "/");
    assertSafeEntryName(relative, findings);
    scanControlledFile(fs.readFileSync(filePath), path.basename(root) + "/" + relative, findings);
  }
  return files.length;
}

function auditPackage({ archivePath, resourceRoot }) {
  const findings = [];
  if (!fs.existsSync(archivePath)) throw new Error(`Missing app archive: ${archivePath}`);
  const asarFiles = auditAsar(archivePath, findings);
  const resourceFiles = auditResourceTree(resourceRoot, findings);
  if (findings.length) throw new Error(`Package privacy audit failed:\n${findings.join("\n")}`);
  return { archivePath, resourceRoot, asarFiles, resourceFiles, findings: 0 };
}

function defaultTargets(projectRoot = path.resolve(__dirname, "..")) {
  return [
    {
      archivePath: path.join(projectRoot, "dist/mac-arm64/ChatGPT++.app/Contents/Resources/app.asar"),
      resourceRoot: path.join(projectRoot, "dist/mac-arm64/ChatGPT++.app/Contents/Resources/codex-dream-skin-studio")
    },
    {
      archivePath: path.join(projectRoot, "dist/win-unpacked/resources/app.asar"),
      resourceRoot: path.join(projectRoot, "dist/win-unpacked/resources/codex-dream-skin-studio")
    }
  ];
}

if (require.main === module) {
  const requested = new Set(process.argv.slice(2));
  const targets = defaultTargets();
  const selected = requested.has("--mac") ? [targets[0]] : requested.has("--win") ? [targets[1]] : targets;
  const results = selected.map(auditPackage);
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

module.exports = {
  auditAsar,
  auditPackage,
  auditResourceTree,
  defaultTargets,
  scanControlledFile
};
