const test = require("node:test");
const assert = require("node:assert/strict");
const { createQuotaRetryReader, isQuotaSnapshotSuccessful } = require("../src/main/quota-retry");

test("quota retry immediately retries a failed read until it succeeds", async () => {
  const results = [
    { quotaError: "temporary failure" },
    { quotaError: "still unavailable" },
    { remainingPercent: 61 }
  ];
  const waits = [];
  const failures = [];
  const read = createQuotaRetryReader({
    read: async () => results.shift(),
    onFailure: (_snapshot, attempt) => failures.push(attempt),
    waitFor: async (delay) => waits.push(delay)
  });

  assert.deepEqual(await read(), { remainingPercent: 61 });
  assert.deepEqual(failures, [1, 2]);
  assert.equal(waits[0], 0);
  assert.equal(waits[1], 250);
});

test("quota retry caps its backoff while continuing until success", async () => {
  let attempts = 0;
  const waits = [];
  const read = createQuotaRetryReader({
    read: async () => (++attempts < 9 ? { quotaError: "offline" } : { remainingPercent: 7 }),
    waitFor: async (delay) => waits.push(delay)
  });

  assert.deepEqual(await read(), { remainingPercent: 7 });
  assert.deepEqual(waits, [0, 250, 1000, 5000, 15000, 30000, 30000, 30000]);
});

test("quota retry survives a status callback failure", async () => {
  let attempts = 0;
  const read = createQuotaRetryReader({
    read: async () => (++attempts === 1 ? { quotaError: "temporary" } : { remainingPercent: 9 }),
    onFailure: async () => { throw new Error("renderer disappeared"); },
    waitFor: async () => {}
  });

  assert.deepEqual(await read(), { remainingPercent: 9 });
});

test("quota retry shares one retry loop across concurrent callers", async () => {
  let attempts = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const read = createQuotaRetryReader({
    read: async () => {
      attempts += 1;
      if (attempts === 1) return { quotaError: "failed" };
      await gate;
      return { remainingPercent: 42 };
    },
    waitFor: async () => {}
  });

  const first = read();
  const second = read();
  assert.strictEqual(first, second);
  release();
  assert.deepEqual(await first, { remainingPercent: 42 });
  assert.equal(attempts, 2);
});

test("quota success requires a snapshot without quotaError", () => {
  assert.equal(isQuotaSnapshotSuccessful({ remainingPercent: 0 }), true);
  assert.equal(isQuotaSnapshotSuccessful({ quotaError: "no auth" }), false);
  assert.equal(isQuotaSnapshotSuccessful({}), false);
  assert.equal(isQuotaSnapshotSuccessful({ remainingPercent: null, weekly: null, fiveHour: null }), false);
  assert.equal(isQuotaSnapshotSuccessful(null), false);
});
