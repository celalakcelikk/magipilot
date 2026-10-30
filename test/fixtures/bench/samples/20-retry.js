'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls `fn` until it resolves, retrying up to `retries` times with exponential backoff.
 * @param {() => Promise<unknown>} fn
 * @param {{ retries?: number, baseDelayMs?: number }} [options]
 */
async function retry(fn, options = {}) {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 100;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        <FILL>await sleep(baseDelayMs * 2 ** attempt);</FILL>
      }
    }
  }
  throw lastError;
}

module.exports = { retry, sleep };
