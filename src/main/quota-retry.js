// Retry the first failure immediately as requested, then back off so a missing
// or broken Codex CLI cannot create an unbounded child-process/CPU storm. The
// last delay is reused indefinitely, so reads still continue until success.
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([0, 250, 1000, 5000, 15000, 30000]);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isQuotaSnapshotSuccessful(snapshot) {
  if (!snapshot || snapshot.quotaError) return false;
  return [
    snapshot.remainingPercent,
    snapshot.weekly?.remainingPercent,
    snapshot.fiveHour?.remainingPercent
  ].some((value) => typeof value === "number" && Number.isFinite(value));
}

function createQuotaRetryReader({
  read,
  onFailure = () => {},
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  waitFor = wait
}) {
  if (typeof read !== "function") throw new TypeError("read must be a function");
  let activeRequest = null;

  async function readUntilSuccess() {
    let failureCount = 0;
    while (true) {
      let snapshot;
      try {
        snapshot = await read();
      } catch (error) {
        snapshot = { quotaError: error?.message || String(error) };
      }

      if (isQuotaSnapshotSuccessful(snapshot)) return snapshot;

      failureCount += 1;
      try {
        await onFailure(snapshot, failureCount);
      } catch {
        // UI/status reporting must never terminate the required retry loop.
      }
      const delayIndex = Math.min(failureCount - 1, retryDelaysMs.length - 1);
      const delay = Math.max(0, Number(retryDelaysMs[delayIndex]) || 0);
      await waitFor(delay);
    }
  }

  return function getQuotaWithRetry() {
    if (activeRequest) return activeRequest;
    activeRequest = readUntilSuccess().finally(() => {
      activeRequest = null;
    });
    return activeRequest;
  };
}

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  createQuotaRetryReader,
  isQuotaSnapshotSuccessful
};
