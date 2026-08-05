const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30000;
const TOKEN_CACHE_TTL_MS = 60_000;
const MAX_STDOUT_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_FILES = 1024;
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_SESSION_LINE_BYTES = 2 * 1024 * 1024;
const CHILD_ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "TZ",
  "LANG", "LANGUAGE", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE",
  "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES"
]);

let quotaRequest = null;
let tokenCache = null;

function resolveCodexCandidates(env = process.env, platform = process.platform) {
  const localAppData = env.LOCALAPPDATA || "";
  const appData = env.APPDATA || path.join(env.USERPROFILE || "", "AppData", "Roaming");
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const isWindows = platform === "win32";
  const candidates = (isWindows
    ? [
        env.CODEX_CLI_PATH,
        ...findLocalCodexBins(localAppData),
        safeJoin(localAppData, "OpenAI", "Codex", "bin", "codex.exe"),
        safeJoin(localAppData, "OpenAI", "Codex", "app", "resources", "codex.exe"),
        safeJoin(localAppData, "Programs", "Codex", "resources", "codex.exe"),
        safeJoin(appData, "npm", "codex.cmd"),
        safeJoin(localAppData, "pnpm", "codex.cmd"),
        safeJoin(home, ".bun", "bin", "codex.exe"),
        ...findOnPath(["codex.exe", "codex.cmd"], env)
      ]
    : [
        env.CODEX_CLI_PATH,
        safeJoin("/Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
        safeJoin(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
        safeJoin("/Applications", "Codex.app", "Contents", "Resources", "codex"),
        safeJoin(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
        safeJoin(home, ".local", "bin", "codex"),
        safeJoin(home, ".npm-global", "bin", "codex"),
        safeJoin(home, "Library", "pnpm", "codex"),
        safeJoin(home, ".bun", "bin", "codex"),
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        ...findOnPath(["codex"], env, ":")
      ])
    .filter(Boolean)
    .filter(isAllowedCodexPath);

  return uniquePaths(candidates).filter((candidate) => candidate === "codex" || fs.existsSync(candidate));
}

async function getQuota() {
  if (quotaRequest) return quotaRequest;
  quotaRequest = readQuota();
  try {
    return await quotaRequest;
  } finally {
    quotaRequest = null;
  }
}

async function readQuota({
  rateLimitsReader = requestRateLimits,
  todayTokensReader = getCachedTodayTokenUsage,
  now = new Date()
} = {}) {
  // Token logs are supplementary local data. A missing, unreadable, or very
  // large log must never turn a successful account quota read into a failure.
  const todayTokensPromise = getBestEffortTodayTokenUsage(todayTokensReader, now);

  try {
    const response = await rateLimitsReader();
    const snapshot = selectCodexSnapshot(response);

    if (!snapshot) {
      throw new Error("Codex did not return a rate-limit snapshot.");
    }

    const normalized = normalizeSnapshot(snapshot);
    if (!normalized.fiveHour && !normalized.weekly) {
      throw new Error("Codex did not return a usable rate-limit window.");
    }

    return {
      ...normalized,
      todayTokens: await todayTokensPromise
    };
  } catch (error) {
    return {
      limitId: "codex",
      limitName: "Codex",
      planType: null,
      reachedType: null,
      credits: null,
      fiveHour: null,
      weekly: null,
      remainingPercent: null,
      usedPercent: null,
      resetsAt: null,
      fetchedAt: new Date().toISOString(),
      quotaError: error?.message || String(error),
      todayTokens: await todayTokensPromise
    };
  }
}

function selectCodexSnapshot(response) {
  if (!response || typeof response !== "object") return null;
  const byId = response.rateLimitsByLimitId;
  if (byId?.codex && typeof byId.codex === "object") return byId.codex;
  const direct = response.rateLimits;
  if (direct && typeof direct === "object" && (!direct.limitId || direct.limitId === "codex")) {
    return direct;
  }
  return null;
}

function safeJoin(root, ...parts) {
  return root ? path.join(root, ...parts) : null;
}

function findOnPath(commands, env = process.env, delimiter = path.delimiter) {
  const pathValue = env.PATH || env.Path || "";
  const directories = pathValue.split(delimiter).filter(Boolean);
  const matches = [];
  for (const directory of directories) {
    for (const command of commands) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), command);
      if (fs.existsSync(candidate)) matches.push(candidate);
    }
  }
  return matches;
}

function findLocalCodexBins(localAppData) {
  if (!localAppData) return [];
  const root = path.join(localAppData, "OpenAI", "Codex", "bin");
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "codex.exe"))
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({ candidate, mtimeMs: fs.statSync(candidate).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates.map(({ candidate }) => candidate);
}

function isAllowedCodexPath(candidate) {
  if (!path.isAbsolute(candidate)) return false;
  const normalized = path.normalize(candidate).toLowerCase();
  return !normalized.includes(`${path.sep}downloads${path.sep}codex-msix-repack${path.sep}`);
}

function uniquePaths(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = path.normalize(candidate).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSnapshot(snapshot) {
  const windows = [snapshot.primary, snapshot.secondary].filter(Boolean);
  const weeklySource = windows.find((window) => Number(window.windowDurationMins) >= 7 * 24 * 60) ||
    (snapshot.secondary && !isFiveHourWindow(snapshot.secondary) ? snapshot.secondary : null) ||
    (snapshot.primary && !isFiveHourWindow(snapshot.primary) ? snapshot.primary : null);
  const fiveHourSource = windows.find(isFiveHourWindow) ||
    (snapshot.primary && snapshot.primary !== weeklySource ? snapshot.primary : null);
  const fiveHour = normalizeWindow(fiveHourSource);
  const weekly = normalizeWindow(weeklySource);
  const activeWindow = weekly || fiveHour;

  return {
    limitId: snapshot.limitId || "codex",
    limitName: snapshot.limitName || "Codex",
    planType: snapshot.planType || "unknown",
    reachedType: snapshot.rateLimitReachedType || null,
    credits: snapshot.credits || null,
    fiveHour,
    weekly,
    remainingPercent: activeWindow ? activeWindow.remainingPercent : null,
    usedPercent: activeWindow ? activeWindow.usedPercent : null,
    resetsAt: activeWindow ? activeWindow.resetsAt : null,
    fetchedAt: new Date().toISOString()
  };
}

function isFiveHourWindow(window) {
  const duration = Number(window?.windowDurationMins);
  return Number.isFinite(duration) && duration > 0 && duration < 24 * 60;
}

function normalizeWindow(window) {
  if (!window) return null;
  if (window.usedPercent === null || window.usedPercent === undefined) return null;
  if (typeof window.usedPercent === "string" && !window.usedPercent.trim()) return null;
  const rawUsedPercent = Number(window.usedPercent);
  if (!Number.isFinite(rawUsedPercent)) return null;
  const usedPercent = clampPercent(rawUsedPercent);
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowDurationMins: window.windowDurationMins ?? null,
    resetsAt: normalizeResetTimestamp(window.resetsAt)
  };
}

function normalizeResetTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function createEmptyTodayTokenUsage(now = new Date(), error = null) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    events: 0,
    source: "codex-session-logs",
    date: formatLocalDate(start),
    available: false,
    truncated: false,
    scannedFiles: 0,
    scannedBytes: 0,
    ...(error ? { error: error?.message || String(error) } : {})
  };
}

async function getBestEffortTodayTokenUsage(reader = getCachedTodayTokenUsage, now = new Date()) {
  try {
    const result = await reader(now);
    return result && typeof result === "object" ? result : createEmptyTodayTokenUsage(now);
  } catch (error) {
    return createEmptyTodayTokenUsage(now, error);
  }
}

async function getTodayTokenUsage(now = new Date(), options = {}) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + 1);

  const totals = createEmptyTodayTokenUsage(start);
  const limits = normalizeTokenScanLimits(options);
  const scan = await listSessionFilesForRange(start, end, {
    sessionRoot: options.sessionRoot,
    maxFiles: limits.maxFiles
  });
  totals.truncated = scan.truncated;

  let remainingBytes = limits.maxTotalBytes;
  for (const file of scan.files) {
    if (remainingBytes <= 0) {
      totals.truncated = true;
      break;
    }

    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      totals.truncated = true;
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;

    const maxBytes = Math.min(stat.size, limits.maxFileBytes, remainingBytes);
    if (maxBytes < stat.size) totals.truncated = true;

    try {
      const result = await addTokenUsageFromFile(file, start, end, totals, {
        maxBytes,
        maxLineBytes: limits.maxLineBytes
      });
      totals.scannedFiles += 1;
      totals.scannedBytes += result.bytesRead;
      remainingBytes -= result.bytesRead;
      if (result.truncated) totals.truncated = true;
    } catch {
      // A concurrently removed or unreadable file is skipped. Token usage is
      // diagnostic only, so retain all successfully collected data.
      totals.truncated = true;
    }
  }

  totals.available = totals.events > 0;
  return totals;
}

function normalizeTokenScanLimits(options = {}) {
  return {
    maxFiles: normalizePositiveLimit(options.maxFiles, MAX_SESSION_FILES),
    maxFileBytes: normalizePositiveLimit(options.maxFileBytes, MAX_SESSION_FILE_BYTES),
    maxTotalBytes: normalizePositiveLimit(options.maxTotalBytes, MAX_SESSION_TOTAL_BYTES),
    maxLineBytes: normalizePositiveLimit(options.maxLineBytes, MAX_SESSION_LINE_BYTES)
  };
}

function normalizePositiveLimit(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

async function getCachedTodayTokenUsage(now = new Date(), options = {}) {
  const nowMs = now.getTime();
  const dateKey = formatLocalDate(now);
  if (
    tokenCache &&
    tokenCache.dateKey === dateKey &&
    nowMs - tokenCache.createdAt < TOKEN_CACHE_TTL_MS
  ) {
    return tokenCache.value;
  }
  const reader = options.reader || getTodayTokenUsage;
  const value = await reader(now, options);
  tokenCache = { createdAt: nowMs, dateKey, value };
  return value;
}

async function listSessionFilesForRange(start, end, { sessionRoot: explicitSessionRoot, maxFiles } = {}) {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const sessionRoot = explicitSessionRoot || path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "sessions");
  const days = uniquePathDays([
    formatPathDay(start),
    formatPathDay(end),
    formatUtcPathDay(start),
    formatUtcPathDay(end)
  ]);
  const files = [];

  for (const day of days) {
    const dir = path.join(sessionRoot, day.year, day.month, day.day);
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  files.sort();
  const limit = normalizePositiveLimit(maxFiles, MAX_SESSION_FILES);
  return {
    files: files.length > limit ? files.slice(-limit) : files,
    truncated: files.length > limit
  };
}

function uniquePathDays(days) {
  const seen = new Set();
  return days.filter((day) => {
    const key = `${day.year}-${day.month}-${day.day}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatPathDay(date) {
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, "0"),
    day: String(date.getDate()).padStart(2, "0")
  };
}

function formatUtcPathDay(date) {
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
    day: String(date.getUTCDate()).padStart(2, "0")
  };
}

function formatLocalDate(date) {
  const day = formatPathDay(date);
  return `${day.year}-${day.month}-${day.day}`;
}

async function addTokenUsageFromFile(file, start, end, totals, { maxBytes, maxLineBytes }) {
  const stream = fs.createReadStream(file, { start: 0, end: Math.max(0, maxBytes - 1) });
  const decoder = new StringDecoder("utf8");
  let lineParts = [];
  let lineBytes = 0;
  let skippingLine = false;
  let truncated = false;

  const acceptSegment = (segment, endsLine) => {
    if (!skippingLine) {
      const segmentBytes = Buffer.byteLength(segment, "utf8");
      if (lineBytes + segmentBytes > maxLineBytes) {
        lineParts = [];
        lineBytes = 0;
        skippingLine = true;
        truncated = true;
      } else {
        lineParts.push(segment);
        lineBytes += segmentBytes;
      }
    }

    if (!endsLine) return;
    if (!skippingLine) processTokenUsageLine(lineParts.join("").replace(/\r$/, ""), start, end, totals);
    lineParts = [];
    lineBytes = 0;
    skippingLine = false;
  };

  const acceptText = (text) => {
    let startIndex = 0;
    let newlineIndex;
    while ((newlineIndex = text.indexOf("\n", startIndex)) >= 0) {
      acceptSegment(text.slice(startIndex, newlineIndex), true);
      startIndex = newlineIndex + 1;
    }
    if (startIndex < text.length) acceptSegment(text.slice(startIndex), false);
  };

  for await (const chunk of stream) acceptText(decoder.write(chunk));
  acceptText(decoder.end());
  if (lineParts.length || skippingLine) acceptSegment("", true);

  return { bytesRead: stream.bytesRead, truncated };
}

function processTokenUsageLine(line, start, end, totals) {
  if (!line.includes('"token_count"')) return;

  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }

  const timestamp = new Date(entry.timestamp);
  if (!Number.isFinite(timestamp.getTime()) || timestamp < start || timestamp >= end) return;
  if (entry.type !== "event_msg" || entry.payload?.type !== "token_count") return;

  const usage = entry.payload.info?.last_token_usage;
  if (!usage) return;

  totals.totalTokens += numberOrZero(usage.total_tokens);
  totals.inputTokens += numberOrZero(usage.input_tokens);
  totals.cachedInputTokens += numberOrZero(usage.cached_input_tokens);
  totals.outputTokens += numberOrZero(usage.output_tokens);
  totals.reasoningOutputTokens += numberOrZero(usage.reasoning_output_tokens);
  totals.events += 1;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isExecutableUnavailableError(error) {
  const code = String(error?.code || "").toUpperCase();
  if (["ENOENT", "ENOTDIR"].includes(code)) return true;
  const message = error?.message || String(error);
  return /\b(?:ENOENT|ENOTDIR)\b|no such file or directory|executable (?:was )?not found|cannot find (?:the )?(?:file|path)/i.test(message);
}

function withErrorContext(error, message) {
  const wrapped = new Error(message, { cause: error });
  if (error?.code) wrapped.code = error.code;
  return wrapped;
}

async function requestRateLimits(
  candidates = resolveCodexCandidates(),
  requester = requestRateLimitsFrom
) {
  const failures = [];

  for (const candidate of candidates) {
    try {
      return await requester(candidate);
    } catch (error) {
      const message = error?.message || String(error);
      failures.push(message);
      // Authentication, permission, protocol, and timeout failures belong to
      // the selected installation. Falling through could silently display a
      // different account from another Codex CLI on the machine.
      if (!isExecutableUnavailableError(error)) {
        throw withErrorContext(error, `Codex quota read failed via ${candidate}: ${message}`);
      }
    }
  }

  const finalError = failures.at(-1) || "Codex executable was not found.";
  const error = new Error(`Tried ${candidates.length} Codex installation path(s). ${finalError}`);
  error.code = "ENOENT";
  throw error;
}

function createSpawnSpec(candidate) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(candidate)) {
    if (/["\r\n&|<>^%!]/.test(candidate)) {
      throw new Error("Codex command path contains characters that are unsafe for cmd.exe.");
    }
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `call "${candidate}" app-server --listen stdio://`]
    };
  }
  return { command: candidate, args: ["app-server", "--listen", "stdio://"] };
}

function createSanitizedChildEnv(env = process.env) {
  const sanitized = {};
  for (const [key, value] of Object.entries(env || {})) {
    const normalized = key.toUpperCase();
    if (CHILD_ENV_ALLOWLIST.has(normalized) || normalized.startsWith("LC_")) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function requestRateLimitsFrom(candidate, {
  spawnImpl = spawn,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
  maxStdoutBufferBytes = MAX_STDOUT_BUFFER_BYTES,
  env = process.env
} = {}) {
  const spawnSpec = createSpawnSpec(candidate);
  const child = spawnImpl(spawnSpec.command, spawnSpec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: createSanitizedChildEnv(env)
  });

  let buffer = "";
  let stderr = "";
  let nextId = 1;
  let settled = false;
  let totalTimer = null;
  const pending = new Map();

  const cleanup = (reason = null) => {
    clearTimeout(totalTimer);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      if (reason) request.reject(reason);
    }
    pending.clear();
    try {
      if (!child.killed) child.kill();
    } catch {}
  };

  return new Promise((resolve, reject) => {
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup(error);
      reject(error);
    };

    const send = (method, params) => {
      const id = nextId++;
      const payload = params === undefined ? { id, method } : { id, method, params };
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          const error = new Error(`Codex request timed out: ${method}`);
          error.code = "ETIMEDOUT";
          rejectRequest(error);
        }, requestTimeoutMs);
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
        try {
          child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
            if (!error) return;
            clearTimeout(timer);
            pending.delete(id);
            rejectRequest(error);
          });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          rejectRequest(error);
        }
      });
    };

    totalTimer = setTimeout(() => {
      const error = new Error(`Codex app-server exceeded the ${totalTimeoutMs} ms total timeout.`);
      error.code = "ETIMEDOUT";
      fail(error);
    }, totalTimeoutMs);

    child.once("error", (error) => {
      fail(error);
    });

    child.once("exit", (code) => {
      if (!settled) fail(new Error(stderr || `Codex app-server exited with code ${code}`));
    });

    child.stdin.on("error", (error) => fail(error));
    child.stdout.on("error", (error) => fail(error));
    child.stderr.on("error", (error) => fail(error));

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > maxStdoutBufferBytes) {
        buffer = "";
        const error = new Error(`Codex app-server output exceeded the ${maxStdoutBufferBytes} byte safety limit.`);
        error.code = "EOVERFLOW";
        fail(error);
        return;
      }
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        handleMessage(line, pending);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8192);
    });

    (async () => {
      try {
        await send("initialize", {
          clientInfo: {
            name: "chatgpt-plus-plus",
            title: "ChatGPT++",
            version: "1.5.0"
          },
          capabilities: null
        });
        const result = await send("account/rateLimits/read");
        settled = true;
        cleanup();
        resolve(result);
      } catch (error) {
        const details = [error?.message, stderr.trim()].filter(Boolean);
        fail(withErrorContext(error, [...new Set(details)].join(" | ")));
      }
    })();
  });
}

function handleMessage(line, pending) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
  const request = pending.get(message.id);
  if (!request) return;

  clearTimeout(request.timer);
  pending.delete(message.id);

  if (message.error) {
    request.reject(new Error(message.error.message || JSON.stringify(message.error)));
  } else {
    request.resolve(message.result);
  }
}

module.exports = {
  getQuota,
  readQuota,
  normalizeSnapshot,
  getTodayTokenUsage,
  getCachedTodayTokenUsage,
  resolveCodexCandidates,
  createSpawnSpec,
  requestRateLimits,
  requestRateLimitsFrom,
  isExecutableUnavailableError,
  createSanitizedChildEnv
};
