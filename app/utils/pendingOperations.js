const pending = new Set();

function trackPendingOperation(promise) {
  if (!promise || typeof promise.then !== 'function') {
    return promise;
  }

  const tracked = Promise.resolve(promise)
    .finally(() => {
      pending.delete(tracked);
    });

  pending.add(tracked);
  return tracked;
}

async function waitForPendingOperations(timeoutMs = 30000) {
  const startedAt = Date.now();

  while (pending.size > 0) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }

    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise((resolve) => setTimeout(resolve, Math.min(500, remainingMs)))
    ]);
  }

  return pending.size === 0;
}

function getPendingOperationCount() {
  return pending.size;
}

module.exports = {
  trackPendingOperation,
  waitForPendingOperations,
  getPendingOperationCount
};
