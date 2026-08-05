const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const BUILT_IN_INTEGRITY_MANIFEST = require("./dream-skin-integrity.json");

const execFileAsync = promisify(execFile);
const THEME_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const IMAGE_NAME_PATTERN = /^(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f-\u009f\u2028\u2029]{1,160}$/u;
const THEME_NAME_PATTERN = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]{1,80}$/u;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 16384;
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_THEME_SCAN_ENTRIES = 500;
const MAX_LISTED_THEMES = 100;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_SINGLE_PREVIEW_BYTES = 2 * 1024 * 1024;
const OPEN_NOFOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

function resolveEngineRoot({ packaged = false, resourcesPath = process.resourcesPath, appPath = path.join(__dirname, "../..") } = {}) {
  return packaged
    ? path.join(resourcesPath, "codex-dream-skin-studio")
    : path.join(appPath, "vendor", "codex-dream-skin-studio");
}

function getThemePaths(home = os.homedir()) {
  const stateRoot = path.join(home, "Library", "Application Support", "CodexDreamSkinStudio");
  return {
    stateRoot,
    statePath: path.join(stateRoot, "state.json"),
    activeThemeDir: path.join(stateRoot, "theme"),
    themesRoot: path.join(stateRoot, "themes"),
    backupPath: path.join(stateRoot, "theme-backup.json")
  };
}

function assertPrivateDirectory(directory, label, { create = false } = {}) {
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label}必须是非符号链接目录`);
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}

function ensureThemeStateDirectories(paths, { includeActive = false } = {}) {
  assertPrivateDirectory(paths.stateRoot, "主题状态目录", { create: true });
  assertPrivateDirectory(paths.themesRoot, "已保存主题目录", { create: true });
  if (includeActive) assertPrivateDirectory(paths.activeThemeDir, "当前主题目录", { create: true });
}

function sameFileStat(left, right) {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readStableFile(filePath, { maxBytes, label = "文件" } = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, OPEN_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`${label}不能是符号链接`);
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${label}必须是普通文件`);
    if (before.size <= 0 || before.size > maxBytes) throw new Error(`${label}大小不合法`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!sameFileStat(before, after) || bytes.length !== after.size) throw new Error(`${label}在读取期间发生变化`);
    return { bytes, stat: after };
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseImageMetadata(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG 缺少 IHDR");
    return { type: "png", mime: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (startOfFrame.has(marker)) {
        if (length < 7) break;
        return { type: "jpeg", mime: "image/jpeg", width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
    throw new Error("JPEG 缺少有效尺寸信息");
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      const width = 1 + bytes.readUIntLE(24, 3);
      const height = 1 + bytes.readUIntLE(27, 3);
      return { type: "webp", mime: "image/webp", width, height };
    }
    if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { type: "webp", mime: "image/webp", width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      const height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
      return { type: "webp", mime: "image/webp", width, height };
    }
    throw new Error("WebP 缺少有效尺寸信息");
  }
  throw new Error("不支持或损坏的图片格式");
}

function validateImageMetadata(metadata, imageName) {
  const extension = path.extname(imageName).toLowerCase();
  const expected = metadata.type === "jpeg" ? [".jpg", ".jpeg"] : [`.${metadata.type}`];
  if (!expected.includes(extension)) throw new Error("图片扩展名与内容不匹配");
  if (!Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)
    || metadata.width < 1 || metadata.height < 1
    || metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION
    || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
    throw new Error("图片尺寸不安全");
  }
}

function safeThemeImage(themeDirectory, imageName, { includeBytes = false } = {}) {
  if (!IMAGE_NAME_PATTERN.test(imageName || "") || !/\.(?:png|jpe?g|webp)$/i.test(imageName)) return null;
  const candidate = path.join(themeDirectory, imageName);
  const relative = path.relative(themeDirectory, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const stable = readStableFile(candidate, { maxBytes: MAX_IMAGE_BYTES, label: "主题图片" });
    const metadata = parseImageMetadata(stable.bytes);
    validateImageMetadata(metadata, imageName);
    return { path: candidate, metadata, bytes: includeBytes ? stable.bytes : undefined };
  } catch {
    return null;
  }
}

function decodeManifest(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("主题清单包含 NUL");
  const manifest = JSON.parse(text);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.schemaVersion !== 1) {
    throw new Error("主题清单 schemaVersion 不支持");
  }
  if (!THEME_ID_PATTERN.test(manifest.id || "")) throw new Error("主题清单 ID 无效");
  if (!THEME_NAME_PATTERN.test(String(manifest.name || ""))) throw new Error("主题名称无效");
  if (!IMAGE_NAME_PATTERN.test(manifest.image || "")) throw new Error("主题图片名无效");
  return manifest;
}

function listSavedThemes(themesRoot, options = {}) {
  const includePreviews = Boolean(options.includePreviews);
  const maxThemes = Math.max(1, Math.min(MAX_LISTED_THEMES, Number(options.maxThemes) || MAX_LISTED_THEMES));
  const maxPreviewBytes = Math.max(0, Math.min(MAX_PREVIEW_BYTES, Number.isFinite(options.maxPreviewBytes) ? options.maxPreviewBytes : MAX_PREVIEW_BYTES));
  let directory;
  let rootReal;
  try {
    const rootStat = fs.lstatSync(themesRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [];
    rootReal = fs.realpathSync(themesRoot);
    directory = fs.opendirSync(themesRoot);
  } catch {
    return [];
  }

  const themes = [];
  let scanned = 0;
  let previewBytes = 0;
  try {
    let entry;
    while (scanned < MAX_THEME_SCAN_ENTRIES && themes.length < maxThemes && (entry = directory.readSync())) {
      scanned += 1;
      if (!entry.isDirectory() || !THEME_ID_PATTERN.test(entry.name)) continue;
      const themeDirectory = path.join(themesRoot, entry.name);
      try {
        const directoryStat = fs.lstatSync(themeDirectory);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) continue;
        const directoryReal = fs.realpathSync(themeDirectory);
        if (!directoryReal.startsWith(`${rootReal}${path.sep}`)) continue;
        const manifestStable = readStableFile(path.join(directoryReal, "theme.json"), {
          maxBytes: MAX_MANIFEST_BYTES,
          label: "主题清单"
        });
        const manifest = decodeManifest(manifestStable.bytes);
        const image = safeThemeImage(directoryReal, manifest.image, { includeBytes: includePreviews });
        if (!image) continue;
        const theme = {
          id: entry.name,
          manifestId: manifest.id,
          name: manifest.name,
          imageName: manifest.image,
          width: image.metadata.width,
          height: image.metadata.height
        };
        if (includePreviews && image.bytes.length <= MAX_SINGLE_PREVIEW_BYTES
          && previewBytes + image.bytes.length <= maxPreviewBytes) {
          theme.previewUrl = `data:${image.metadata.mime};base64,${image.bytes.toString("base64")}`;
          previewBytes += image.bytes.length;
        }
        themes.push(theme);
      } catch {
        // A malformed or concurrently modified pack is omitted.
      }
    }
  } finally {
    directory.closeSync();
  }
  return themes.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function verifyEngineIntegrity(engineRoot, manifest = BUILT_IN_INTEGRITY_MANIFEST) {
  const rootStat = fs.lstatSync(engineRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("内置主题引擎目录不安全");
  const rootReal = fs.realpathSync(engineRoot);
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== "object") {
    throw new Error("内置主题引擎完整性清单无效");
  }
  const expectedNames = Object.keys(manifest.files).sort();
  if (expectedNames.length === 0) throw new Error("内置主题引擎完整性清单为空");
  for (const relativeName of expectedNames) {
    const expected = manifest.files[relativeName];
    if (!/^(?:scripts|assets|presets)\/[A-Za-z0-9._\-/ ]+$/.test(relativeName)
      || relativeName.split("/").includes("..")) {
      throw new Error("内置主题引擎完整性路径无效");
    }
    const target = path.join(engineRoot, ...relativeName.split("/"));
    const relative = path.relative(rootReal, path.resolve(target));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("内置主题引擎文件越界");
    const stable = readStableFile(target, { maxBytes: 64 * 1024 * 1024, label: `内置主题文件 ${relativeName}` });
    if (!expected || stable.stat.size !== expected.size || sha256(stable.bytes) !== expected.sha256) {
      throw new Error(`内置主题文件完整性校验失败：${relativeName}`);
    }
  }
  return true;
}

function mapThemeStatus(raw = {}, { engineAvailable = true, hasActiveTheme = false, error = "", mismatch = false } = {}) {
  if (!engineAvailable) {
    return {
      level: "error",
      label: "主题服务缺失",
      message: error || "Quota 内置主题引擎不完整，请重新安装 Quota",
      canRepair: false
    };
  }
  if (error) return { level: "error", label: "主题服务异常", message: error, canRepair: true };
  if (mismatch) {
    return { level: "error", label: "主题状态不一致", message: "主题名称与背景文件不一致，请重新应用主题", canRepair: true };
  }
  if (raw.operation === "applying" || raw.operation === "pausing" || raw.session === "applying") {
    return { level: "busy", label: raw.operationMessage || "正在应用主题", message: "请稍候", canRepair: false };
  }
  if (raw.operation === "failed") {
    return { level: "error", label: "主题操作失败", message: raw.operationMessage || "上次操作未完成", canRepair: true };
  }
  if (!hasActiveTheme) {
    return { level: "warning", label: "主题尚未初始化", message: "选择一个已保存主题即可启用", canRepair: true };
  }
  if (raw.session === "active" && raw.injectorAlive && raw.cdpOk && raw.codexRunning) {
    return { level: "healthy", label: "主题服务正常", message: raw.appliedThemeName || raw.themeName || "主题已启用", canRepair: false };
  }
  if (!raw.codexRunning) {
    return { level: "idle", label: "主题服务待机", message: "ChatGPT 未运行，应用主题时会自动打开", canRepair: false };
  }
  if (raw.session === "paused" || raw.session === "off") {
    return { level: "warning", label: "主题未启用", message: "点击重新加载以启用主题", canRepair: true };
  }
  return { level: "error", label: "主题服务异常", message: "注入器或本地连接不可用", canRepair: true };
}

function readActiveThemeIdentity(paths) {
  try {
    const root = assertPrivateDirectory(paths.activeThemeDir, "当前主题目录");
    const manifest = decodeManifest(readStableFile(path.join(root, "theme.json"), {
      maxBytes: MAX_MANIFEST_BYTES,
      label: "当前主题清单"
    }).bytes);
    if (!safeThemeImage(root, manifest.image)) return null;
    return { id: manifest.id, name: manifest.name, image: manifest.image };
  } catch {
    return null;
  }
}

function copyDirectoryFiles(source, destination) {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error("内置预设主题目录不安全");
  assertPrivateDirectory(destination, "预设主题目录", { create: true });
  const entries = fs.readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== ".DS_Store")
    .sort((left, right) => Number(left.name === "theme.json") - Number(right.name === "theme.json"));
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === ".DS_Store") continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const stable = readStableFile(sourcePath, { maxBytes: 64 * 1024 * 1024, label: `内置预设文件 ${entry.name}` });
    let identical = false;
    try {
      const destinationStat = fs.lstatSync(destinationPath);
      identical = destinationStat.isFile()
        && !destinationStat.isSymbolicLink()
        && stable.stat.size === destinationStat.size
        && stable.bytes.equals(readStableFile(destinationPath, { maxBytes: 64 * 1024 * 1024, label: "已安装预设文件" }).bytes);
    } catch {}
    if (!identical) {
      const temporary = path.join(destination, `.${entry.name}.${process.pid}.${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, stable.bytes, { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, destinationPath);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
    fs.chmodSync(destinationPath, 0o600);
  }
}

class DreamSkinService {
  constructor({ engineRoot, home = os.homedir(), runScript, integrityManifest = BUILT_IN_INTEGRITY_MANIFEST } = {}) {
    this.engineRoot = engineRoot;
    this.home = home;
    this.paths = getThemePaths(home);
    this.runScript = runScript || this.executeScript.bind(this);
    this.integrityManifest = integrityManifest;
    this.integrityError = "";
    this.activeOperation = null;
    this.libraryRequest = null;
  }

  scriptPath(name) {
    if (!/^[A-Za-z0-9._-]+$/.test(name || "")) throw new Error("内置主题脚本名无效");
    return path.join(this.engineRoot, "scripts", name);
  }

  engineAvailable() {
    if (process.platform !== "darwin") return false;
    try {
      verifyEngineIntegrity(this.engineRoot, this.integrityManifest);
      for (const name of [
        "status-dream-skin-macos.sh",
        "start-dream-skin-macos.sh",
        "switch-theme-macos.sh",
        "load-image-theme-macos.sh",
        "restore-dream-skin-macos.sh"
      ]) {
        const script = this.scriptPath(name);
        const stat = fs.lstatSync(script);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`内置主题脚本缺失：${name}`);
      }
      this.integrityError = "";
      return true;
    } catch (error) {
      this.integrityError = error?.message || String(error);
      return false;
    }
  }

  async executeScript(name, args = [], timeout = 120000) {
    verifyEngineIntegrity(this.engineRoot, this.integrityManifest);
    const script = this.scriptPath(name);
    const manifestEntry = this.integrityManifest.files[`scripts/${name}`];
    if (!manifestEntry) throw new Error(`内置主题脚本未经授权：${name}`);
    const scriptStat = fs.lstatSync(script);
    if (scriptStat.isSymbolicLink() || !scriptStat.isFile()) throw new Error(`内置主题脚本缺失：${name}`);
    const environment = { ...process.env, HOME: this.home };
    for (const key of [
      "BASH_ENV", "ENV", "SHELLOPTS", "CDPATH", "GLOBIGNORE", "IFS",
      "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "ELECTRON_RUN_AS_NODE"
    ]) delete environment[key];
    try {
      return await execFileAsync("/bin/bash", [script, ...args], {
        encoding: "utf8",
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        env: environment
      });
    } catch (error) {
      const details = [error?.stderr, error?.stdout, error?.message].map((item) => String(item || "").trim()).filter(Boolean);
      throw new Error(details[0] || "主题脚本执行失败");
    }
  }

  ensureLibrary() {
    if (this.libraryRequest) return this.libraryRequest;
    this.libraryRequest = this.ensureLibraryNow().finally(() => {
      this.libraryRequest = null;
    });
    return this.libraryRequest;
  }

  async ensureLibraryNow() {
    if (!this.engineAvailable()) throw new Error(this.integrityError || "Quota 内置主题引擎不可用");
    ensureThemeStateDirectories(this.paths);
    const presetsRoot = path.join(this.engineRoot, "presets");
    for (const entry of fs.readdirSync(presetsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("preset-") || !THEME_ID_PATTERN.test(entry.name)) continue;
      copyDirectoryFiles(path.join(presetsRoot, entry.name), path.join(this.paths.themesRoot, entry.name));
    }
  }

  async rawStatus() {
    if (!this.engineAvailable()) throw new Error(this.integrityError || "Quota 内置主题引擎不完整");
    const { stdout } = await this.runScript("status-dream-skin-macos.sh", ["--json", "--deep"], 10000);
    return JSON.parse(String(stdout).trim());
  }

  async getState() {
    if (process.platform !== "darwin") {
      return { supported: false, status: { level: "idle", label: "仅支持 macOS", message: "", canRepair: false }, themeName: "" };
    }
    const engineAvailable = this.engineAvailable();
    let raw = {};
    let error = "";
    if (engineAvailable) {
      try {
        await this.ensureLibrary();
        raw = await this.rawStatus();
      } catch (cause) {
        error = cause?.message || String(cause);
      }
    }
    const activeTheme = readActiveThemeIdentity(this.paths);
    const hasActiveTheme = Boolean(activeTheme);
    const mismatch = Boolean(activeTheme && raw.appliedThemeId && raw.appliedThemeId !== activeTheme.id);
    if (activeTheme) {
      raw.themeId = activeTheme.id;
      raw.themeName = activeTheme.name;
    }
    return {
      supported: true,
      busy: Boolean(this.activeOperation),
      status: mapThemeStatus(raw, { engineAvailable, hasActiveTheme, error, mismatch }),
      themeName: activeTheme?.name || raw.themeName || "",
      appliedThemeName: raw.appliedThemeName || "",
      themeId: activeTheme?.id || raw.themeId || "",
      appliedThemeId: raw.appliedThemeId || "",
      raw
    };
  }

  listThemes() {
    ensureThemeStateDirectories(this.paths);
    return listSavedThemes(this.paths.themesRoot, { includePreviews: true });
  }

  async runExclusive(task) {
    if (this.activeOperation) throw new Error("另一个主题操作正在进行");
    this.activeOperation = Promise.resolve().then(task).finally(() => {
      this.activeOperation = null;
    });
    return this.activeOperation;
  }

  async applyCurrent({ allowRestart = false } = {}) {
    await this.ensureLibrary();
    const state = await this.rawStatus();
    const args = [];
    if (state.codexRunning && !state.cdpOk) {
      if (!allowRestart) {
        const error = new Error("RESTART_REQUIRED");
        error.code = "RESTART_REQUIRED";
        throw error;
      }
      args.push("--restart-existing");
    }
    return this.runScript("start-dream-skin-macos.sh", args, 180000);
  }

  apply(options) {
    return this.runExclusive(() => this.applyCurrent(options));
  }

  switchTheme(id, options) {
    if (!THEME_ID_PATTERN.test(id || "")) throw new Error("无效的主题 ID");
    return this.runExclusive(async () => {
      const state = await this.rawStatus();
      if (state.codexRunning && !state.cdpOk && !options?.allowRestart) {
        const error = new Error("RESTART_REQUIRED");
        error.code = "RESTART_REQUIRED";
        throw error;
      }
      await this.ensureLibrary();
      await this.runScript("switch-theme-macos.sh", ["--id", id, "--no-apply"]);
      return this.applyCurrent(options);
    });
  }

  createTheme(imagePath, name, options) {
    if (!path.isAbsolute(imagePath || "")) throw new Error("请选择有效的本地图片");
    const safeName = String(name || path.basename(imagePath, path.extname(imagePath))).trim().slice(0, 80);
    if (!safeName || /[\r\n]/.test(safeName)) throw new Error("主题名称无效");
    return this.runExclusive(async () => {
      const sourceStat = fs.lstatSync(imagePath);
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > 50 * 1024 * 1024) {
        throw new Error("请选择不超过 50 MB 的普通图片文件");
      }
      const state = await this.rawStatus();
      if (state.codexRunning && !state.cdpOk && !options?.allowRestart) {
        const error = new Error("RESTART_REQUIRED");
        error.code = "RESTART_REQUIRED";
        throw error;
      }
      await this.ensureLibrary();
      await this.runScript("load-image-theme-macos.sh", ["--file", imagePath, "--name", safeName, "--no-apply"], 120000);
      return this.applyCurrent(options);
    });
  }

  restoreDefault({ restart = false } = {}) {
    return this.runExclusive(async () => {
      await this.ensureLibrary();
      const args = [];
      if (fs.existsSync(this.paths.backupPath)) args.push("--restore-base-theme");
      if (restart) args.push("--restart-codex");
      return this.runScript("restore-dream-skin-macos.sh", args, 180000);
    });
  }
}

module.exports = {
  DreamSkinService,
  getThemePaths,
  listSavedThemes,
  mapThemeStatus,
  parseImageMetadata,
  resolveEngineRoot,
  safeThemeImage,
  verifyEngineIntegrity
};
