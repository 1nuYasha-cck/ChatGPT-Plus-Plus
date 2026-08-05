const { extractAuthMetadata, normalizeSubscriptionExpiry } = require("./account-store");

const CHATGPT_ACCOUNTS_CHECK_URL = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function getChatGptCredentials(auth) {
  const tokens = auth?.tokens || {};
  const metadata = extractAuthMetadata(auth);
  return {
    accessToken: firstText(tokens.access_token, auth?.access_token),
    accountId: metadata.accountId,
    claimPlanType: metadata.planType,
    claimExpiresAt: metadata.subscriptionExpiresAt
  };
}

function selectAccountEntry(payload, accountId) {
  const accounts = payload?.accounts;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return null;
  return (accountId && accounts[accountId]) || accounts.default || Object.values(accounts)[0] || null;
}

function parseSubscriptionResponse(payload, accountId) {
  const entry = selectAccountEntry(payload, accountId);
  if (!entry || typeof entry !== "object") throw new Error("订阅接口未返回账号信息");
  return {
    planType: firstText(entry.account?.plan_type, entry.plan_type),
    subscriptionExpiresAt: normalizeSubscriptionExpiry(
      entry.entitlement?.expires_at ?? entry.subscription?.expires_at ?? entry.expires_at
    )
  };
}

async function fetchSubscriptionMetadata(auth, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const credentials = getChatGptCredentials(auth);
  const fallback = {
    planType: credentials.claimPlanType,
    subscriptionExpiresAt: credentials.claimExpiresAt,
    source: credentials.claimExpiresAt ? "id-token" : "unavailable"
  };
  if (!credentials.accessToken || !credentials.accountId || typeof fetchImpl !== "function") return fallback;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(CHATGPT_ACCOUNTS_CHECK_URL, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "chatgpt-account-id": credentials.accountId,
        accept: "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9",
        origin: "https://chatgpt.com",
        referer: "https://chatgpt.com/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
      }
    });
    if (!response.ok) throw new Error(`订阅接口返回 HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("订阅接口响应过大");
    const live = parseSubscriptionResponse(JSON.parse(text), credentials.accountId);
    return {
      planType: live.planType || fallback.planType,
      subscriptionExpiresAt: live.subscriptionExpiresAt || fallback.subscriptionExpiresAt,
      source: live.subscriptionExpiresAt ? "account-entitlement" : fallback.source
    };
  } catch (error) {
    return { ...fallback, error: error?.name === "AbortError" ? "订阅信息请求超时" : (error?.message || String(error)) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  CHATGPT_ACCOUNTS_CHECK_URL,
  fetchSubscriptionMetadata,
  getChatGptCredentials,
  parseSubscriptionResponse
};
