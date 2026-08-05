const { AccountStore } = require("./account-store");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loginWithChatGPT } = require("./codex-login-service");
const { fetchSubscriptionMetadata } = require("./subscription-service");
const {
  normalizeSnapshot,
  requestRateLimits,
  requestRateLimitsFrom,
  resolveCodexCandidates
} = require("./quota-service");

class AccountService {
  constructor({
    store = new AccountStore(),
    candidates = null,
    requester = requestRateLimitsFrom,
    loginRequester = loginWithChatGPT,
    subscriptionRequester = fetchSubscriptionMetadata
  } = {}) {
    this.store = store;
    this.candidates = candidates;
    this.requester = requester;
    this.loginRequester = loginRequester;
    this.subscriptionRequester = subscriptionRequester;
    this.snapshots = new Map();
    this.switchingAccountId = null;
    this.addingAccount = false;
  }

  initialize() {
    this.store.ensure();
    return this.getState();
  }

  getState() {
    const manifest = this.store.readManifest();
    return {
      activeAccountId: manifest.activeAccountId,
      switchingAccountId: this.switchingAccountId,
      addingAccount: this.addingAccount,
      accounts: manifest.accounts.map((account) => {
        const snapshot = this.snapshots.get(account.id) || {};
        return {
          ...account,
          ...snapshot,
          planType: snapshot.planType || account.planType || null,
          isActive: account.id === manifest.activeAccountId
        };
      })
    };
  }

  async refreshAccount(accountId) {
    const manifest = this.store.readManifest();
    const account = manifest.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("账号不存在");
    let quotaPatch;
    try {
      const candidates = this.candidates || resolveCodexCandidates();
      const response = await requestRateLimits(candidates, (candidate) => this.requester(candidate, {
        env: { ...process.env, CODEX_HOME: this.store.profileDir(accountId) }
      }));
      const source = response?.rateLimitsByLimitId?.codex || response?.rateLimits;
      if (!source) throw new Error("Codex 未返回账号额度");
      const quota = normalizeSnapshot(source);
      quotaPatch = {
        quota,
        quotaUpdatedAt: quota.fetchedAt,
        quotaError: null,
        planType: source.planType || account.planType || (quota.planType === "unknown" ? null : quota.planType) || null
      };
    } catch (error) {
      const previous = this.snapshots.get(accountId) || {};
      quotaPatch = { ...previous, quotaError: error?.message || String(error), quotaUpdatedAt: previous.quotaUpdatedAt || null };
    }

    let subscription = {};
    try {
      const auth = this.store.readProfileAuth(accountId);
      subscription = await this.subscriptionRequester(auth);
    } catch (error) {
      subscription = { error: error?.message || String(error) };
    }
    const patch = {
      ...quotaPatch,
      planType: subscription.planType || quotaPatch.planType || account.planType || null,
      subscriptionExpiresAt: subscription.subscriptionExpiresAt || account.subscriptionExpiresAt || null,
      subscriptionSource: subscription.source || null,
      subscriptionError: subscription.error || null
    };
    this.snapshots.set(accountId, patch);
    const accountPatch = {};
    if (patch.planType && patch.planType !== account.planType) accountPatch.planType = patch.planType;
    if (patch.subscriptionExpiresAt && patch.subscriptionExpiresAt !== account.subscriptionExpiresAt) {
      accountPatch.subscriptionExpiresAt = patch.subscriptionExpiresAt;
    }
    if (Object.keys(accountPatch).length) this.store.updateAccount(accountId, accountPatch);
    return patch;
  }

  async refreshAll() {
    const { accounts } = this.store.readManifest();
    for (const account of accounts) await this.refreshAccount(account.id);
    return this.getState();
  }

  ingestActiveQuota(quota) {
    const activeAccountId = this.store.readManifest().activeAccountId;
    if (!activeAccountId || !quota) return;
    const snapshot = {
      quota,
      quotaUpdatedAt: quota.fetchedAt || new Date().toISOString(),
      quotaError: quota.quotaError || null
    };
    if (quota.planType && quota.planType !== "unknown") snapshot.planType = quota.planType;
    this.snapshots.set(activeAccountId, snapshot);
  }

  addFromFile(filePath) {
    const account = this.store.addFromFile(filePath);
    return account;
  }

  async addWithOfficialLogin(openExternal) {
    if (this.addingAccount) throw new Error("已有账号正在登录");
    this.addingAccount = true;
    const stagingRoot = path.join(this.store.storeRoot, "login-staging", crypto.randomUUID());
    const stagingAuthPath = path.join(stagingRoot, "auth.json");
    try {
      fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(stagingRoot, "config.toml"),
        'cli_auth_credentials_store = "file"\n',
        { encoding: "utf8", mode: 0o600 }
      );
      const result = await this.loginRequester({
        candidates: this.candidates || resolveCodexCandidates(),
        codexHome: stagingRoot,
        openExternal
      });
      if (!fs.existsSync(stagingAuthPath)) throw new Error("登录成功，但 Codex 未生成 auth.json");
      const account = this.store.addFromFile(stagingAuthPath, { source: "official-chatgpt-login" });
      const official = result?.account;
      if (official?.type === "chatgpt") {
        this.store.updateAccount(account.id, {
          email: official.email || account.email,
          name: account.name || official.email,
          planType: official.planType || account.planType
        });
      }
      await this.refreshAccount(account.id);
      return { accountId: account.id, state: this.getState() };
    } finally {
      this.addingAccount = false;
      try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch {}
    }
  }

  async switchTo(accountId) {
    if (this.switchingAccountId) throw new Error("另一个账号正在切换中");
    this.switchingAccountId = accountId;
    try {
      this.store.switchTo(accountId);
      await this.refreshAccount(accountId);
      return this.getState();
    } finally {
      this.switchingAccountId = null;
    }
  }
}

module.exports = { AccountService };
