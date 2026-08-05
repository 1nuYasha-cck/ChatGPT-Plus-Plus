const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { loginWithChatGPTFrom, validateOfficialAuthUrl } = require("../src/main/codex-login-service");

function fakeChild(onRequest) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("exit", null)); };
  let input = "";
  child.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
    let newline;
    while ((newline = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (line) onRequest(JSON.parse(line), child);
    }
  });
  return child;
}

test("accepts only official OpenAI HTTPS login URLs", () => {
  assert.equal(validateOfficialAuthUrl("https://chatgpt.com/auth/login"), "https://chatgpt.com/auth/login");
  assert.equal(validateOfficialAuthUrl("https://auth.openai.com/codex"), "https://auth.openai.com/codex");
  assert.throws(() => validateOfficialAuthUrl("http://chatgpt.com/login"), /官方 HTTPS/);
  assert.throws(() => validateOfficialAuthUrl("https://chatgpt.com.evil.example/login"), /官方 HTTPS/);
});

test("runs the official browser login protocol and waits for completion", async () => {
  let opened = null;
  let spawnOptions = null;
  const child = fakeChild((message, target) => {
    if (message.method === "initialize") {
      target.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    } else if (message.method === "account/login/start") {
      assert.deepEqual(message.params, { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "chatgpt" });
      target.stdout.write(`${JSON.stringify({ id: message.id, result: { type: "chatgpt", loginId: "login-1", authUrl: "https://chatgpt.com/auth/login" } })}\n`);
      target.stdout.write(`${JSON.stringify({ method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } })}\n`);
    } else if (message.method === "account/read") {
      assert.deepEqual(message.params, { refreshToken: true });
      target.stdout.write(`${JSON.stringify({ id: message.id, result: { account: { type: "chatgpt", email: "person@example.com", planType: "plus" } } })}\n`);
    }
  });
  const result = await loginWithChatGPTFrom("/fake/codex", {
    codexHome: "/tmp/chatgpt-plus-plus-login-profile",
    spawnImpl: (_command, _args, options) => { spawnOptions = options; return child; },
    openExternal: async (url) => { opened = url; },
    requestTimeoutMs: 500,
    loginTimeoutMs: 500
  });
  assert.equal(opened, "https://chatgpt.com/auth/login");
  assert.equal(result.account.email, "person@example.com");
  assert.equal(spawnOptions.env.CODEX_HOME, "/tmp/chatgpt-plus-plus-login-profile");
  assert.equal(child.killed, true);
});
