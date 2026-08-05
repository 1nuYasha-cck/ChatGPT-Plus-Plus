const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STORE_VERSION = 1;

function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function normalizeSubscriptionExpiry(value) {
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") return null;
  let date;
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    date = new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000);
  } else {
    date = new Date(value);
  }
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2020) return null;
  return date.toISOString();
}

function extractAuthMetadata(auth) {
  const tokens = auth?.tokens || {};
  const claims = [tokens.id_token, tokens.access_token, auth?.id_token, auth?.access_token]
    .map(decodeJwtPayload)
    .filter(Boolean);
  const authClaims = claims.map((claim) => claim["https://api.openai.com/auth"] || {});
  const profileClaims = claims.map((claim) => claim["https://api.openai.com/profile"] || {});
  const email = firstText(
    auth?.email,
    tokens?.email,
    ...claims.map((claim) => claim.email),
    ...profileClaims.map((claim) => claim.email)
  );
  const name = firstText(
    auth?.name,
    tokens?.name,
    ...claims.map((claim) => claim.name),
    ...profileClaims.map((claim) => claim.name),
    email
  );
  const planType = firstText(
    auth?.planType,
    auth?.plan_type,
    tokens?.planType,
    ...authClaims.map((claim) => claim.chatgpt_plan_type),
    ...claims.map((claim) => claim.chatgpt_plan_type)
  );
  const subscriptionExpiresAt = normalizeSubscriptionExpiry(firstText(
    auth?.subscriptionExpiresAt,
    auth?.subscription_expires_at,
    tokens?.subscriptionExpiresAt,
    tokens?.subscription_expires_at,
    ...authClaims.map((claim) => claim.chatgpt_subscription_active_until),
    ...claims.map((claim) => claim.chatgpt_subscription_active_until)
  ));
  const accountId = firstText(
    auth?.account_id,
    tokens?.account_id,
    ...authClaims.map((claim) => claim.chatgpt_account_id),
    ...claims.map((claim) => claim.sub)
  );
  return { email, name, planType, subscriptionExpiresAt, accountId };
}

function parseAuthJson(text, source = "auth.json") {
  let auth;
  try {
    auth = JSON.parse(text);
  } catch {
    throw new Error(`${source} 不是有效的 JSON 文件`);
  }
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error(`${source} 必须包含一个 JSON 对象`);
  }
  const hasCredential = Boolean(
    auth.OPENAI_API_KEY || auth.openai_api_key || auth.tokens?.access_token || auth.access_token
  );
  if (!hasCredential) throw new Error(`${source} 中未找到可用的 Codex 登录凭据`);
  return auth;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const previous = `${filePath}.${process.pid}.${crypto.randomUUID()}.previous`;
  let movedPrevious = false;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, previous);
      movedPrevious = true;
    }
    fs.renameSync(temporary, filePath);
    if (movedPrevious) fs.rmSync(previous, { force: true });
    try { fs.chmodSync(filePath, 0o600); } catch {}
  } catch (error) {
    if (movedPrevious && !fs.existsSync(filePath) && fs.existsSync(previous)) fs.renameSync(previous, filePath);
    throw error;
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    try { fs.rmSync(previous, { force: true }); } catch {}
  }
}

class AccountStore {
  constructor({
    storeRoot = process.env.CHATGPT_PLUS_PLUS_STORE_ROOT || path.join(os.homedir(), ".chatgpt-plus-plus"),
    codexHome = process.env.CHATGPT_PLUS_PLUS_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    verifyLiveAuth = null
  } = {}) {
    this.storeRoot = storeRoot;
    this.codexHome = codexHome;
    this.manifestPath = path.join(storeRoot, "accounts.json");
    this.profilesRoot = path.join(storeRoot, "profiles");
    this.backupsRoot = path.join(storeRoot, "backups");
    this.liveAuthPath = path.join(codexHome, "auth.json");
    this.verifyLiveAuth = verifyLiveAuth;
  }

  ensure() {
    fs.mkdirSync(this.profilesRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.backupsRoot, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.manifestPath)) {
      atomicWriteJson(this.manifestPath, { version: STORE_VERSION, activeAccountId: null, accounts: [] });
    }
    const manifest = this.readManifest();
    if (!manifest.accounts.length && fs.existsSync(this.liveAuthPath)) {
      const imported = this.addFromFile(this.liveAuthPath, { activate: true, source: "current-codex" });
      return { manifest: this.readManifest(), imported };
    }
    if (fs.existsSync(this.liveAuthPath)) {
      const raw = fs.readFileSync(this.liveAuthPath, "utf8");
      const auth = parseAuthJson(raw, "当前 auth.json");
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify(auth)).digest("hex");
      const metadata = extractAuthMetadata(auth);
      const idSeed = metadata.accountId || metadata.email || fingerprint;
      const expectedId = crypto.createHash("sha256").update(idSeed).digest("hex").slice(0, 16);
      const existing = manifest.accounts.find((item) =>
        item.fingerprint === fingerprint || item.id === expectedId || (metadata.email && item.email === metadata.email)
      );
      if (existing) {
        atomicWriteJson(this.profileAuthPath(existing.id), auth);
        existing.fingerprint = fingerprint;
        existing.name = metadata.name || existing.name;
        existing.email = metadata.email || existing.email;
        existing.planType = metadata.planType || existing.planType;
        existing.subscriptionExpiresAt = metadata.subscriptionExpiresAt || existing.subscriptionExpiresAt;
        existing.updatedAt = new Date().toISOString();
        manifest.activeAccountId = existing.id;
        this.writeManifest(manifest);
        return { manifest: this.readManifest(), imported: null };
      }
      const imported = this.addFromFile(this.liveAuthPath, { activate: true, source: "current-codex" });
      return { manifest: this.readManifest(), imported };
    }
    return { manifest, imported: null };
  }

  readManifest() {
    try {
      const value = JSON.parse(fs.readFileSync(this.manifestPath, "utf8"));
      const accounts = Array.isArray(value.accounts)
        ? value.accounts.map((account) => ({
            ...account,
            subscriptionExpiresAt: normalizeSubscriptionExpiry(account?.subscriptionExpiresAt)
          }))
        : [];
      return { version: STORE_VERSION, activeAccountId: value.activeAccountId || null, accounts };
    } catch {
      return { version: STORE_VERSION, activeAccountId: null, accounts: [] };
    }
  }

  writeManifest(manifest) {
    atomicWriteJson(this.manifestPath, { version: STORE_VERSION, ...manifest });
  }

  profileDir(accountId) {
    return path.join(this.profilesRoot, accountId);
  }

  profileAuthPath(accountId) {
    return path.join(this.profileDir(accountId), "auth.json");
  }

  readProfileAuth(accountId) {
    return parseAuthJson(
      fs.readFileSync(this.profileAuthPath(accountId), "utf8"),
      "账号 auth.json"
    );
  }

  addFromFile(filePath, { activate = false, source = "import" } = {}) {
    const raw = fs.readFileSync(filePath, "utf8");
    const auth = parseAuthJson(raw, path.basename(filePath));
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(auth)).digest("hex");
    const manifest = this.readManifest();
    const metadata = extractAuthMetadata(auth);
    const idSeed = metadata.accountId || metadata.email || fingerprint;
    const expectedId = crypto.createHash("sha256").update(idSeed).digest("hex").slice(0, 16);
    const duplicate = manifest.accounts.find((item) =>
      item.fingerprint === fingerprint || item.id === expectedId || (metadata.email && item.email === metadata.email)
    );
    if (duplicate) {
      atomicWriteJson(this.profileAuthPath(duplicate.id), auth);
      duplicate.fingerprint = fingerprint;
      duplicate.name = metadata.name || duplicate.name;
      duplicate.email = metadata.email || duplicate.email;
      duplicate.planType = metadata.planType || duplicate.planType;
      duplicate.subscriptionExpiresAt = metadata.subscriptionExpiresAt || duplicate.subscriptionExpiresAt;
      duplicate.source = source;
      duplicate.updatedAt = new Date().toISOString();
      if (activate && manifest.activeAccountId !== duplicate.id) {
        manifest.activeAccountId = duplicate.id;
      }
      this.writeManifest(manifest);
      return duplicate;
    }

    let accountId = expectedId;
    if (manifest.accounts.some((item) => item.id === accountId)) accountId = fingerprint.slice(0, 16);
    const profileDir = this.profileDir(accountId);
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    atomicWriteJson(this.profileAuthPath(accountId), auth);
    fs.writeFileSync(
      path.join(profileDir, "config.toml"),
      'cli_auth_credentials_store = "file"\n',
      { encoding: "utf8", mode: 0o600 }
    );

    const now = new Date().toISOString();
    const record = {
      id: accountId,
      fingerprint,
      name: metadata.name,
      email: metadata.email,
      planType: metadata.planType,
      subscriptionExpiresAt: metadata.subscriptionExpiresAt,
      addedAt: now,
      updatedAt: now,
      source
    };
    manifest.accounts.push(record);
    if (activate || !manifest.activeAccountId) manifest.activeAccountId = accountId;
    this.writeManifest(manifest);
    return record;
  }

  updateAccount(accountId, patch) {
    const manifest = this.readManifest();
    const index = manifest.accounts.findIndex((item) => item.id === accountId);
    if (index < 0) throw new Error("账号不存在");
    manifest.accounts[index] = { ...manifest.accounts[index], ...patch, id: accountId, updatedAt: new Date().toISOString() };
    this.writeManifest(manifest);
    return manifest.accounts[index];
  }

  switchTo(accountId) {
    const manifest = this.readManifest();
    const target = manifest.accounts.find((item) => item.id === accountId);
    if (!target) throw new Error("要切换的账号不存在");
    if (manifest.activeAccountId === accountId) return target;
    const targetAuth = parseAuthJson(fs.readFileSync(this.profileAuthPath(accountId), "utf8"), "目标账号 auth.json");
    fs.mkdirSync(this.codexHome, { recursive: true, mode: 0o700 });

    if (manifest.activeAccountId && fs.existsSync(this.liveAuthPath)) {
      const current = parseAuthJson(fs.readFileSync(this.liveAuthPath, "utf8"), "当前 auth.json");
      atomicWriteJson(this.profileAuthPath(manifest.activeAccountId), current);
      const currentRecord = manifest.accounts.find((item) => item.id === manifest.activeAccountId);
      if (currentRecord) {
        currentRecord.fingerprint = crypto.createHash("sha256").update(JSON.stringify(current)).digest("hex");
        currentRecord.updatedAt = new Date().toISOString();
      }
    }

    const backupPath = path.join(this.backupsRoot, `auth-${Date.now()}-${crypto.randomUUID()}.json`);
    const hadLiveAuth = fs.existsSync(this.liveAuthPath);
    if (hadLiveAuth) fs.copyFileSync(this.liveAuthPath, backupPath);
    try {
      atomicWriteJson(this.liveAuthPath, targetAuth);
      const written = parseAuthJson(fs.readFileSync(this.liveAuthPath, "utf8"), "切换后的 auth.json");
      const writtenHash = crypto.createHash("sha256").update(JSON.stringify(written)).digest("hex");
      const targetHash = crypto.createHash("sha256").update(JSON.stringify(targetAuth)).digest("hex");
      if (writtenHash !== targetHash) throw new Error("切换后的凭据校验失败");
      if (this.verifyLiveAuth) this.verifyLiveAuth({ accountId, authPath: this.liveAuthPath });
      manifest.activeAccountId = accountId;
      this.writeManifest(manifest);
      return target;
    } catch (error) {
      if (hadLiveAuth && fs.existsSync(backupPath)) {
        const backup = parseAuthJson(fs.readFileSync(backupPath, "utf8"), "备份 auth.json");
        atomicWriteJson(this.liveAuthPath, backup);
      } else if (!hadLiveAuth) {
        try { fs.rmSync(this.liveAuthPath, { force: true }); } catch {}
      }
      throw new Error(`账号切换失败，已恢复原凭据：${error?.message || error}`);
    }
  }
}

module.exports = {
  AccountStore,
  atomicWriteJson,
  decodeJwtPayload,
  extractAuthMetadata,
  normalizeSubscriptionExpiry,
  parseAuthJson
};
