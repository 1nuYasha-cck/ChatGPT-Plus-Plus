const test = require("node:test");
const assert = require("node:assert/strict");
const {
  detectCodexProcesses,
  parseRelevantProcesses,
  parseWindowsExecutablePaths,
  restartCodexProcesses
} = require("../src/main/codex-process-service");

test("detects exact ChatGPT/Codex app processes while excluding ChatGPT++", () => {
  const mac = parseRelevantProcesses([
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    "/Applications/Codex.app/Contents/MacOS/Codex",
    "/Applications/ChatGPT++.app/Contents/MacOS/ChatGPT++"
  ].join("\n"), "darwin");
  assert.deepEqual(mac, ["ChatGPT", "Codex"]);

  const windows = parseRelevantProcesses("ChatGPT.exe  100 Console\nCodex.exe 200 Console\nChatGPT++.exe 300 Console", "win32");
  assert.deepEqual(windows, ["ChatGPT.exe", "Codex.exe"]);
});

test("process detection uses platform-native read-only process listing", async () => {
  const calls = [];
  const result = await detectCodexProcesses({ platform: "darwin", exec: async (command, args) => {
    calls.push({ command, args });
    return { stdout: "/Applications/Codex.app/Contents/MacOS/Codex\n" };
  } });
  assert.deepEqual(result, ["Codex"]);
  assert.equal(calls[0].command, "/bin/ps");
});

test("restarts the official macOS ChatGPT bundle only after it stops", async () => {
  const calls = [];
  const result = await restartCodexProcesses(["ChatGPT"], {
    platform: "darwin",
    exec: async (command, args) => { calls.push({ command, args }); return { stdout: "" }; },
    waitForStop: async () => true
  });
  assert.equal(result.restarted, true);
  assert.deepEqual(calls.map((call) => call.command), ["/usr/bin/osascript", "/usr/bin/open"]);
  assert.deepEqual(calls[1].args, ["-b", "com.openai.codex"]);
});

test("parses only exact Windows ChatGPT executable paths", () => {
  const original = require("node:fs").existsSync;
  require("node:fs").existsSync = () => true;
  try {
    assert.deepEqual(parseWindowsExecutablePaths(JSON.stringify([
      { Name: "ChatGPT.exe", ExecutablePath: "C:\\Apps\\ChatGPT.exe" },
      { Name: "ChatGPT++.exe", ExecutablePath: "C:\\Apps\\ChatGPT++.exe" }
    ])), ["C:\\Apps\\ChatGPT.exe"]);
  } finally {
    require("node:fs").existsSync = original;
  }
});
