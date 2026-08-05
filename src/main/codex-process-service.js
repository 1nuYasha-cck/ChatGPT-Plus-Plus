const fs = require("node:fs");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function parseRelevantProcesses(output, platform = process.platform) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const names = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("chatgpt++")) continue;
    if (platform === "win32") {
      const name = line.split(/\s+/)[0];
      if (/^(?:chatgpt|codex)\.exe$/i.test(name)) names.push(name);
    } else if (/\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)(?:\s|$)/i.test(line)) {
      names.push(line.includes("/Codex.app/") ? "Codex" : "ChatGPT");
    }
  }
  return [...new Set(names)];
}

async function detectCodexProcesses({ platform = process.platform, exec = execFileAsync } = {}) {
  if (platform === "win32") {
    const { stdout } = await exec("tasklist.exe", ["/FO", "TABLE", "/NH"], { windowsHide: true, maxBuffer: 1024 * 1024 });
    return parseRelevantProcesses(stdout, platform);
  }
  if (platform === "darwin") {
    const { stdout } = await exec("/bin/ps", ["-ax", "-o", "command="], { maxBuffer: 1024 * 1024 });
    return parseRelevantProcesses(stdout, platform);
  }
  return [];
}

function normalizeProcessNames(processNames, platform = process.platform) {
  const allowed = platform === "win32"
    ? new Set(["ChatGPT.exe", "Codex.exe"])
    : new Set(["ChatGPT", "Codex"]);
  return [...new Set((processNames || []).filter((name) => allowed.has(name)))];
}

function parseWindowsExecutablePaths(output) {
  if (!String(output || "").trim()) return [];
  try {
    const parsed = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return [...new Set(rows
      .filter((row) => /^(?:ChatGPT|Codex)\.exe$/i.test(row?.Name || ""))
      .map((row) => row.ExecutablePath)
      .filter((value) => typeof value === "string" && fs.existsSync(value)))];
  } catch {
    return [];
  }
}

async function waitUntilStopped(names, {
  detector = detectCodexProcesses,
  platform = process.platform,
  timeoutMs = 10_000,
  intervalMs = 250
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = normalizeProcessNames(await detector({ platform }).catch(() => names), platform);
    if (!running.some((name) => names.includes(name))) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function restartCodexProcesses(processNames, {
  platform = process.platform,
  exec = execFileAsync,
  spawnImpl = spawn,
  detector = detectCodexProcesses,
  waitForStop = waitUntilStopped
} = {}) {
  const names = normalizeProcessNames(processNames, platform);
  if (!names.length) return { restarted: false, clients: [] };

  if (platform === "darwin") {
    await exec("/usr/bin/osascript", ["-e", 'tell application id "com.openai.codex" to quit'], { maxBuffer: 1024 * 1024 });
    let stopped = await waitForStop(names, { detector, platform });
    if (!stopped) {
      for (const name of names) await exec("/usr/bin/pkill", ["-TERM", "-x", name]).catch(() => {});
      stopped = await waitForStop(names, { detector, platform, timeoutMs: 5_000 });
    }
    if (!stopped) throw new Error("ChatGPT 未能完全退出，请手动关闭后重新打开");
    await exec("/usr/bin/open", ["-b", "com.openai.codex"], { maxBuffer: 1024 * 1024 });
    return { restarted: true, clients: names };
  }

  if (platform === "win32") {
    const query = [
      "$names = @('ChatGPT.exe','Codex.exe')",
      "Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name } | Select-Object Name,ExecutablePath | ConvertTo-Json -Compress"
    ].join("; ");
    const pathsResult = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], {
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }).catch(() => ({ stdout: "" }));
    const executablePaths = parseWindowsExecutablePaths(pathsResult.stdout);
    for (const name of names) {
      await exec("taskkill.exe", ["/IM", name, "/T"], { windowsHide: true, maxBuffer: 1024 * 1024 });
    }
    const stopped = await waitForStop(names, { detector, platform });
    if (!stopped) throw new Error("ChatGPT 未能完全退出，请手动关闭后重新打开");
    if (!executablePaths.length) throw new Error("ChatGPT 已退出，但未找到启动路径，请手动重新打开");
    for (const executablePath of executablePaths) {
      const child = spawnImpl(executablePath, [], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref?.();
    }
    return { restarted: true, clients: names };
  }

  throw new Error("当前系统不支持自动重启 ChatGPT");
}

module.exports = {
  detectCodexProcesses,
  normalizeProcessNames,
  parseRelevantProcesses,
  parseWindowsExecutablePaths,
  restartCodexProcesses,
  waitUntilStopped
};
