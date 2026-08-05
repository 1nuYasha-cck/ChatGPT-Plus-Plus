const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AccountStore } = require("../src/main/account-store");
const { AccountService } = require("../src/main/account-service");

test("reads each account quota through its isolated CODEX_HOME", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-plus-plus-service-"));
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture" }));
  const store = new AccountStore({ storeRoot: path.join(root, "store"), codexHome });
  store.ensure();
  const service = new AccountService({ store, candidates: ["/fake/codex"], requester: async (_candidate, options) => {
    assert.match(options.env.CODEX_HOME, /profiles/);
    return { rateLimits: { limitId: "codex", planType: "plus", primary: { usedPercent: 27, windowDurationMins: 10_080 } } };
  } });
  try {
    const state = await service.refreshAll();
    assert.equal(state.accounts[0].quota.weekly.remainingPercent, 73);
    assert.equal(state.accounts[0].planType, "plus");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("persists the resolved subscription expiry alongside refreshed quota", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-plus-plus-expiry-"));
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
    tokens: { access_token: "header.payload.signature" },
    email: "paid@example.com"
  }));
  const store = new AccountStore({ storeRoot: path.join(root, "store"), codexHome });
  const account = store.ensure().manifest.accounts[0];
  const service = new AccountService({
    store,
    candidates: ["/fake/codex"],
    requester: async () => ({ rateLimits: { limitId: "codex", planType: "plus", primary: { usedPercent: 15, windowDurationMins: 10_080 } } }),
    subscriptionRequester: async () => ({
      planType: "plus",
      subscriptionExpiresAt: "2032-03-04T00:00:00.000Z",
      source: "account-entitlement"
    })
  });
  try {
    const refreshed = await service.refreshAccount(account.id);
    assert.equal(refreshed.subscriptionExpiresAt, "2032-03-04T00:00:00.000Z");
    assert.equal(store.readManifest().accounts[0].subscriptionExpiresAt, "2032-03-04T00:00:00.000Z");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("retains an official browser login from a temporary file-backed profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-plus-plus-login-"));
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "current" }));
  const store = new AccountStore({ storeRoot: path.join(root, "store"), codexHome });
  store.ensure();
  let opened = false;
  let stagingRoot = null;
  const service = new AccountService({
    store,
    candidates: ["/fake/codex"],
    requester: async () => ({ rateLimits: { limitId: "codex", planType: "pro", primary: { usedPercent: 10, windowDurationMins: 10_080 } } }),
    loginRequester: async ({ codexHome: loginHome, openExternal }) => {
      stagingRoot = loginHome;
      await openExternal("https://chatgpt.com/auth/login");
      fs.writeFileSync(path.join(loginHome, "auth.json"), JSON.stringify({
        email: "new@example.com",
        planType: "pro",
        tokens: { access_token: "header.payload.signature" }
      }));
      return { account: { type: "chatgpt", email: "new@example.com", planType: "pro" } };
    }
  });
  try {
    const result = await service.addWithOfficialLogin(async () => { opened = true; });
    const account = result.state.accounts.find((item) => item.id === result.accountId);
    assert.equal(opened, true);
    assert.equal(account.email, "new@example.com");
    assert.equal(account.planType, "pro");
    assert.equal(account.source, "official-chatgpt-login");
    assert.equal(fs.existsSync(stagingRoot), false);
    assert.equal(service.addingAccount, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
