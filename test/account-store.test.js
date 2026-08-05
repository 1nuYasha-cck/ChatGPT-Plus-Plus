const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  AccountStore,
  extractAuthMetadata,
  normalizeSubscriptionExpiry,
  parseAuthJson
} = require("../src/main/account-store");

function jwt(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;
}

function auth(email, plan = "plus", marker = email) {
  return { tokens: { access_token: jwt({ email, name: email.split("@")[0], sub: marker,
    "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_account_id: marker } }) } };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-plus-plus-"));
  const codexHome = path.join(root, "codex");
  const storeRoot = path.join(root, "store");
  fs.mkdirSync(codexHome, { recursive: true });
  return { root, codexHome, store: new AccountStore({ storeRoot, codexHome }) };
}

test("extracts actual account identity and plan from local JWT claims", () => {
  const metadata = extractAuthMetadata(auth("kai@example.com", "pro"));
  assert.deepEqual({ email: metadata.email, name: metadata.name, planType: metadata.planType },
    { email: "kai@example.com", name: "kai", planType: "pro" });
});

test("rejects JSON without usable Codex credentials", () => {
  assert.throws(() => parseAuthJson("not-json"), /有效的 JSON/);
  assert.throws(() => parseAuthJson("{}"), /未找到可用/);
});

test("rejects zero and 1970 subscription timestamps instead of displaying a fake expiry", () => {
  assert.equal(normalizeSubscriptionExpiry(0), null);
  assert.equal(normalizeSubscriptionExpiry("1970-01-01T00:00:00.000Z"), null);
  assert.equal(normalizeSubscriptionExpiry("2030-08-05T00:00:00Z"), "2030-08-05T00:00:00.000Z");
});

test("extracts subscription active-until from the ID token without using OAuth exp", () => {
  const idToken = jwt({
    email: "paid@example.com",
    exp: 1_800_000_000,
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "plus",
      chatgpt_account_id: "account-paid",
      chatgpt_subscription_active_until: "2030-09-16T12:30:00Z"
    }
  });
  const accessToken = jwt({
    exp: 1_700_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: "account-paid" }
  });
  const metadata = extractAuthMetadata({ tokens: { id_token: idToken, access_token: accessToken } });
  assert.equal(metadata.subscriptionExpiresAt, "2030-09-16T12:30:00.000Z");
  assert.equal(metadata.planType, "plus");
});

test("auto-imports current auth.json into a plaintext profile", () => {
  const item = fixture();
  try {
    fs.writeFileSync(path.join(item.codexHome, "auth.json"), JSON.stringify(auth("first@example.com")));
    const { manifest } = item.store.ensure();
    assert.equal(manifest.accounts.length, 1);
    assert.equal(manifest.accounts[0].email, "first@example.com");
    assert.ok(fs.existsSync(item.store.profileAuthPath(manifest.activeAccountId)));
    assert.equal(fs.readFileSync(item.store.manifestPath, "utf8").includes("access_token"), false);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test("switches live auth.json and keeps a recoverable backup", () => {
  const item = fixture();
  const secondFile = path.join(item.root, "second.json");
  try {
    fs.writeFileSync(path.join(item.codexHome, "auth.json"), JSON.stringify(auth("first@example.com", "plus", "first")));
    item.store.ensure();
    fs.writeFileSync(secondFile, JSON.stringify(auth("second@example.com", "pro", "second")));
    const second = item.store.addFromFile(secondFile);
    item.store.switchTo(second.id);
    const live = extractAuthMetadata(JSON.parse(fs.readFileSync(item.store.liveAuthPath, "utf8")));
    assert.equal(live.email, "second@example.com");
    assert.equal(item.store.readManifest().activeAccountId, second.id);
    assert.ok(fs.readdirSync(item.store.backupsRoot).some((name) => name.endsWith(".json")));
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test("reconciles an externally changed live login without overwriting another profile", () => {
  const item = fixture();
  try {
    fs.writeFileSync(path.join(item.codexHome, "auth.json"), JSON.stringify(auth("first@example.com", "plus", "first")));
    item.store.ensure();
    fs.writeFileSync(path.join(item.codexHome, "auth.json"), JSON.stringify(auth("second@example.com", "pro", "second")));
    const { manifest } = item.store.ensure();
    assert.equal(manifest.accounts.length, 2);
    assert.equal(manifest.accounts.find((entry) => entry.id === manifest.activeAccountId).email, "second@example.com");
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test("restores the original live credentials when post-write verification fails", () => {
  const item = fixture();
  const secondFile = path.join(item.root, "second.json");
  try {
    fs.writeFileSync(path.join(item.codexHome, "auth.json"), JSON.stringify(auth("first@example.com", "plus", "first")));
    item.store.ensure();
    fs.writeFileSync(secondFile, JSON.stringify(auth("second@example.com", "pro", "second")));
    const second = item.store.addFromFile(secondFile);
    const failingStore = new AccountStore({
      storeRoot: item.store.storeRoot,
      codexHome: item.codexHome,
      verifyLiveAuth: () => { throw new Error("simulated verification failure"); }
    });
    const originalActive = failingStore.readManifest().activeAccountId;
    assert.throws(() => failingStore.switchTo(second.id), /已恢复原凭据/);
    const live = extractAuthMetadata(JSON.parse(fs.readFileSync(failingStore.liveAuthPath, "utf8")));
    assert.equal(live.email, "first@example.com");
    assert.equal(failingStore.readManifest().activeAccountId, originalActive);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});
