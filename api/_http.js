// ClinicFlow Connect: outbound fetch with a hard timeout (pro max).
// Node 18+ built-ins only. Every provider call goes through timedFetch
// so a hung upstream (Gemini, Google, Meta, Telegram, KV, certs) cannot
// hold a serverless invocation until the platform kills it. Callers pass
// their own budget; the default is 15 seconds.
const DEFAULT_TIMEOUT_MS = 15000;

function timedFetch(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ms =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  if (options && options.signal) {
    return fetch(url, options);
  }
  if (
    typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.timeout === 'function'
  ) {
    return fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
  }
  return fetch(url, options);
}

module.exports = { DEFAULT_TIMEOUT_MS, timedFetch };
