const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const {
  createSanitizedChildEnv,
  getCachedTodayTokenUsage,
  getTodayTokenUsage,
  normalizeSnapshot,
  readQuota,
  requestRateLimits,
  requestRateLimitsFrom,
  resolveCodexCandidates
} = require("../src/main/quota-service");

function createFakeChild({ stdinError = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = stdinError
    ? new Writable({
        write(_chunk, _encoding, callback) {
          callback(stdinError);
        }
      })
    : new PassThrough();
  child.killed = false;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    child.killed = true;
    queueMicrotask(() => child.emit("exit", null));
    return true;
  };
  return child;
}

function sessionDayDirectory(root, now) {
  return path.join(
    root,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  );
}

function tokenLine(now, totalTokens) {
  return JSON.stringify({
    timestamp: now.toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          total_tokens: totalTokens,
          input_tokens: totalTokens - 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0
        }
      }
    }
  });
}

test("normalizes both the five-hour and seven-day quota windows", () => {
  const result = normalizeSnapshot({
    primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 25.4, windowDurationMins: 10_080, resetsAt: 1_900_000_000 }
  });

  assert.equal(result.fiveHour.remainingPercent, 20);
  assert.equal(result.fiveHour.windowDurationMins, 300);
  assert.equal(result.weekly.remainingPercent, 75);
  assert.equal(result.remainingPercent, 75);
  assert.equal(result.weekly.windowDurationMins, 10_080);
});

test("accepts a seven-day window returned as primary by newer Codex versions", () => {
  const result = normalizeSnapshot({
    primary: { usedPercent: 10, windowDurationMins: 10_080 }
  });

  assert.equal(result.weekly.remainingPercent, 90);
  assert.equal(result.fiveHour, null);
  assert.equal(result.remainingPercent, 90);
});

test("keeps a five-hour-only response usable", () => {
  const result = normalizeSnapshot({
    primary: { usedPercent: 62, windowDurationMins: 300 }
  });

  assert.equal(result.fiveHour.remainingPercent, 38);
  assert.equal(result.weekly, null);
  assert.equal(result.remainingPercent, 38);
});

test("supports older snapshots that omit window durations", () => {
  const result = normalizeSnapshot({
    primary: { usedPercent: 30 },
    secondary: { usedPercent: 45 }
  });

  assert.equal(result.fiveHour.remainingPercent, 70);
  assert.equal(result.weekly.remainingPercent, 55);
});

test("rejects null or blank usage instead of reporting a false 100 percent", () => {
  const result = normalizeSnapshot({
    primary: { usedPercent: null, windowDurationMins: 300 },
    secondary: { usedPercent: "", windowDurationMins: 10_080 }
  });

  assert.equal(result.fiveHour, null);
  assert.equal(result.weekly, null);
  assert.equal(result.remainingPercent, null);
});

test("accepts reset timestamps in seconds or milliseconds and rejects invalid values", () => {
  const seconds = normalizeSnapshot({ primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1_900_000_000 } });
  const milliseconds = normalizeSnapshot({ primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1_900_000_000_000 } });
  const invalid = normalizeSnapshot({ primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: "not-a-date" } });

  assert.equal(seconds.fiveHour.resetsAt, milliseconds.fiveHour.resetsAt);
  assert.equal(invalid.fiveHour.resetsAt, null);
});

test("finds a global npm Codex command before the PATH fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-widget-test-"));
  const appData = path.join(root, "Roaming");
  const command = path.join(appData, "npm", "codex.cmd");
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.writeFileSync(command, "@echo off\r\n");

  try {
    const candidates = resolveCodexCandidates({
      APPDATA: appData,
      LOCALAPPDATA: path.join(root, "Local"),
      USERPROFILE: root,
      PATH: ""
    }, "win32");
    assert.equal(candidates[0], command);
    assert.equal(candidates.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finds a macOS Codex CLI installed in the user's local bin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-widget-test-"));
  const command = path.join(root, ".local", "bin", "codex");
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.writeFileSync(command, "#!/bin/sh\n");

  try {
    const candidates = resolveCodexCandidates({ HOME: root, PATH: "" }, "darwin");
    assert.ok(candidates.includes(command));
    assert.ok(candidates.every(path.isAbsolute));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignores relative CODEX_CLI_PATH entries instead of executing from the working directory", () => {
  const candidates = resolveCodexCandidates({ CODEX_CLI_PATH: "codex", PATH: "", HOME: os.tmpdir() }, "darwin");
  assert.ok(candidates.every(path.isAbsolute));
});

test("token log failures never turn a successful quota snapshot into an error", async () => {
  const result = await readQuota({
    rateLimitsReader: async () => ({
      rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: { usedPercent: 25, windowDurationMins: 10_080 } }
      }
    }),
    todayTokensReader: async () => {
      throw new Error("session log is unreadable");
    },
    now: new Date(2026, 6, 26, 12, 0, 0)
  });

  assert.equal(result.quotaError, undefined);
  assert.equal(result.weekly.remainingPercent, 75);
  assert.equal(result.todayTokens.available, false);
  assert.match(result.todayTokens.error, /unreadable/);
});

test("token cache expires when the local calendar day changes", async () => {
  let reads = 0;
  const reader = async (now) => ({
    available: true,
    totalTokens: ++reads,
    date: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
  });
  const beforeMidnight = new Date(2038, 0, 18, 23, 59, 50);
  const sameDay = new Date(2038, 0, 18, 23, 59, 55);
  const nextDay = new Date(2038, 0, 19, 0, 0, 5);

  assert.equal((await getCachedTodayTokenUsage(beforeMidnight, { reader })).totalTokens, 1);
  assert.equal((await getCachedTodayTokenUsage(sameDay, { reader })).totalTokens, 1);
  assert.equal((await getCachedTodayTokenUsage(nextDay, { reader })).totalTokens, 2);
  assert.equal(reads, 2);
});

test("token scan caps file count, total bytes, and oversized lines", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-token-limits-"));
  const now = new Date(2026, 6, 26, 12, 0, 0);
  const directory = sessionDayDirectory(root, now);
  fs.mkdirSync(directory, { recursive: true });
  const validA = `${tokenLine(now, 11)}\n`;
  const validB = `${tokenLine(now, 22)}\n`;
  fs.writeFileSync(path.join(directory, "a.jsonl"), validA);
  fs.writeFileSync(path.join(directory, "b.jsonl"), validB);

  try {
    const fileLimited = await getTodayTokenUsage(now, { sessionRoot: root, maxFiles: 1 });
    assert.equal(fileLimited.events, 1);
    assert.equal(fileLimited.totalTokens, 22);
    assert.equal(fileLimited.truncated, true);

    const byteLimited = await getTodayTokenUsage(now, {
      sessionRoot: root,
      maxTotalBytes: Buffer.byteLength(validA) + 1
    });
    assert.ok(byteLimited.scannedBytes <= Buffer.byteLength(validA) + 1);
    assert.equal(byteLimited.truncated, true);

    fs.writeFileSync(path.join(directory, "c.jsonl"), `${"x".repeat(4096)}\n${validB}`);
    const lineLimited = await getTodayTokenUsage(now, {
      sessionRoot: root,
      maxLineBytes: 1024
    });
    assert.equal(lineLimited.events, 3);
    assert.equal(lineLimited.truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("candidate fallback only continues for executable-not-found errors", async () => {
  const calls = [];
  const success = { rateLimits: { limitId: "codex" } };
  const result = await requestRateLimits(["/missing", "/working"], async (candidate) => {
    calls.push(candidate);
    if (candidate === "/missing") {
      const error = new Error("spawn ENOENT");
      error.code = "ENOENT";
      throw error;
    }
    return success;
  });
  assert.equal(result, success);
  assert.deepEqual(calls, ["/missing", "/working"]);

  calls.length = 0;
  await assert.rejects(
    requestRateLimits(["/account", "/working"], async (candidate) => {
      calls.push(candidate);
      const error = new Error("account not found");
      error.code = "EAUTH";
      throw error;
    }),
    /account not found/
  );
  assert.deepEqual(calls, ["/account"]);

  calls.length = 0;
  await assert.rejects(
    requestRateLimits(["/denied", "/wrong-account"], async (candidate) => {
      calls.push(candidate);
      const error = new Error("authentication required");
      error.code = "EACCES";
      throw error;
    }),
    /authentication required/
  );
  assert.deepEqual(calls, ["/denied"]);
});

test("app-server total timeout and stdin errors terminate the child", async () => {
  const timedOutChild = createFakeChild();
  await assert.rejects(
    requestRateLimitsFrom("/fake/codex", {
      spawnImpl: () => timedOutChild,
      requestTimeoutMs: 1000,
      totalTimeoutMs: 10
    }),
    (error) => error.code === "ETIMEDOUT" && /total timeout/.test(error.message)
  );
  assert.equal(timedOutChild.killed, true);
  assert.equal(timedOutChild.killCalls, 1);

  const pipeError = new Error("broken pipe");
  pipeError.code = "EPIPE";
  const pipeChild = createFakeChild({ stdinError: pipeError });
  await assert.rejects(
    requestRateLimitsFrom("/fake/codex", { spawnImpl: () => pipeChild }),
    (error) => error.code === "EPIPE"
  );
  assert.equal(pipeChild.killed, true);
});

test("Codex child environment excludes executable-injection variables", () => {
  const env = createSanitizedChildEnv({
    PATH: "/usr/bin",
    HOME: "/Users/test",
    USER: "test",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    CODEX_HOME: "/Users/test/.codex",
    NODE_OPTIONS: "--require /tmp/evil.js",
    NODE_PATH: "/tmp/modules",
    NODE_EXTRA_CA_CERTS: "/tmp/cert.pem",
    ELECTRON_RUN_AS_NODE: "1",
    BASH_ENV: "/tmp/bashrc",
    ENV: "/tmp/shrc",
    CDPATH: "/tmp",
    IFS: "/"
  });

  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/Users/test",
    USER: "test",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    CODEX_HOME: "/Users/test/.codex"
  });
});
