const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CHATGPT_ACCOUNTS_CHECK_URL,
  fetchSubscriptionMetadata,
  parseSubscriptionResponse
} = require("../src/main/subscription-service");

function jwt(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;
}

function chatGptAuth(expiry = "2030-08-05T00:00:00Z") {
  return {
    tokens: {
      id_token: jwt({
        email: "paid@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "account-123",
          chatgpt_plan_type: "plus",
          chatgpt_subscription_active_until: expiry
        }
      }),
      access_token: jwt({ sub: "token-subject" })
    }
  };
}

test("parses the selected entitlement expiry returned by ChatGPT", () => {
  const result = parseSubscriptionResponse({ accounts: {
    "account-123": { account: { plan_type: "pro" }, entitlement: { expires_at: "2031-01-02T03:04:05Z" } }
  } }, "account-123");
  assert.deepEqual(result, {
    planType: "pro",
    subscriptionExpiresAt: "2031-01-02T03:04:05.000Z"
  });
});

test("fetches live entitlement metadata without exposing credentials", async () => {
  let request;
  const result = await fetchSubscriptionMetadata(chatGptAuth(), { fetchImpl: async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ accounts: {
        "account-123": { account: { plan_type: "pro" }, entitlement: { expires_at: "2031-02-03T00:00:00Z" } }
      } })
    };
  } });
  assert.equal(request.url, CHATGPT_ACCOUNTS_CHECK_URL);
  assert.equal(request.options.headers["chatgpt-account-id"], "account-123");
  assert.match(request.options.headers.authorization, /^Bearer /);
  assert.deepEqual(result, {
    planType: "pro",
    subscriptionExpiresAt: "2031-02-03T00:00:00.000Z",
    source: "account-entitlement"
  });
});

test("falls back to the real ID-token expiry when the entitlement request fails", async () => {
  const result = await fetchSubscriptionMetadata(chatGptAuth(), { fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(result.subscriptionExpiresAt, "2030-08-05T00:00:00.000Z");
  assert.equal(result.source, "id-token");
  assert.match(result.error, /403/);
});
