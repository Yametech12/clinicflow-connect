// ClinicFlow Connect: storage layer.
// Uses an HTTPS key-value store (Upstash Redis / Vercel KV REST API) configured
// via environment variables so serverless functions share state without a
// persistent filesystem. Supports an explicit local JSON file backend via
// CLINICFLOW_LOCAL_STORE_FILE for offline local testing (never used on Vercel),
// and an in-memory adapter override for automated tests.
const fs = require('fs');
const path = require('path');

class StoreNotConfiguredError extends Error {
  constructor(message) {
    super(message || 'Storage backend is not configured.');
    this.name = 'StoreNotConfiguredError';
    this.code = 'STORE_NOT_CONFIGURED';
  }
}

let testAdapter = null;

function resolveKvConfig() {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

  return {
    url: url.trim().replace(/\/+$/, ''),
    token: token.trim(),
  };
}

function resolveLocalFile() {
  if (process.env.VERCEL === '1') {
    return '';
  }
  return (process.env.CLINICFLOW_LOCAL_STORE_FILE || '').trim();
}

function getBackendInfo() {
  if (testAdapter) {
    return { configured: true, backend: 'memory_test', missing: [] };
  }

  const kv = resolveKvConfig();
  if (kv.url && kv.token) {
    return { configured: true, backend: 'kv_rest', missing: [] };
  }

  const localFile = resolveLocalFile();
  if (localFile) {
    return { configured: true, backend: 'local_file', missing: [] };
  }

  const missing = [];
  if (!kv.url) missing.push('KV_REST_API_URL');
  if (!kv.token) missing.push('KV_REST_API_TOKEN');
  return { configured: false, backend: 'unconfigured', missing };
}

function isConfigured() {
  return getBackendInfo().configured;
}

async function runKvCommand(command) {
  const { url, token } = resolveKvConfig();
  if (!url || !token) {
    throw new StoreNotConfiguredError(
      'KV_REST_API_URL and KV_REST_API_TOKEN are required for persistent storage.'
    );
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`KV REST API returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok || parsed.error) {
    const detail = parsed.error || text.slice(0, 200) || `HTTP ${response.status}`;
    throw new Error(`KV REST API error (${response.status}): ${detail}`);
  }

  return parsed.result;
}

function readLocalMap(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = raw ? JSON.parse(raw) : {};
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    return {};
  }
}

function writeLocalMap(filePath, map) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(map, null, 2), 'utf8');
}

function pruneExpiredLocalEntries(map) {
  const now = Date.now();
  let changed = false;
  for (const key of Object.keys(map)) {
    const entry = map[key];
    if (entry && entry.expiresAt && entry.expiresAt <= now) {
      delete map[key];
      changed = true;
    }
  }
  return changed;
}

function serializeValue(value) {
  return JSON.stringify(value);
}

function deserializeValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return raw;
  }
}

async function get(key) {
  if (testAdapter) {
    return testAdapter.get(key);
  }

  const info = getBackendInfo();
  if (!info.configured) {
    throw new StoreNotConfiguredError();
  }

  if (info.backend === 'local_file') {
    const filePath = resolveLocalFile();
    const map = readLocalMap(filePath);
    if (pruneExpiredLocalEntries(map)) {
      writeLocalMap(filePath, map);
    }
    const entry = map[key];
    return entry ? deserializeValue(entry.value) : null;
  }

  const result = await runKvCommand(['GET', String(key)]);
  return deserializeValue(result);
}

async function put(key, value, options = {}) {
  const ttlSeconds =
    options && Number.isFinite(options.ttlSeconds) && options.ttlSeconds > 0
      ? Math.max(1, Math.floor(options.ttlSeconds))
      : null;

  if (testAdapter) {
    return testAdapter.put(key, value, { ttlSeconds });
  }

  const info = getBackendInfo();
  if (!info.configured) {
    throw new StoreNotConfiguredError();
  }

  if (info.backend === 'local_file') {
    const filePath = resolveLocalFile();
    const map = readLocalMap(filePath);
    pruneExpiredLocalEntries(map);
    map[key] = {
      value: serializeValue(value),
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    };
    writeLocalMap(filePath, map);
    return;
  }

  const cmd = ['SET', String(key), serializeValue(value)];
  if (ttlSeconds) {
    cmd.push('EX', ttlSeconds);
  }
  await runKvCommand(cmd);
}

async function putIfAbsent(key, value, options = {}) {
  const ttlSeconds =
    options && Number.isFinite(options.ttlSeconds) && options.ttlSeconds > 0
      ? Math.max(1, Math.floor(options.ttlSeconds))
      : null;

  if (testAdapter) {
    return testAdapter.putIfAbsent(key, value, { ttlSeconds });
  }

  const info = getBackendInfo();
  if (!info.configured) {
    throw new StoreNotConfiguredError();
  }

  if (info.backend === 'local_file') {
    const filePath = resolveLocalFile();
    const map = readLocalMap(filePath);
    pruneExpiredLocalEntries(map);
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      return false;
    }
    map[key] = {
      value: serializeValue(value),
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    };
    writeLocalMap(filePath, map);
    return true;
  }

  const cmd = ['SET', String(key), serializeValue(value)];
  if (ttlSeconds) {
    cmd.push('EX', ttlSeconds);
  }
  cmd.push('NX');
  const result = await runKvCommand(cmd);
  return result === 'OK';
}

async function del(key) {
  if (testAdapter) {
    return testAdapter.del(key);
  }

  const info = getBackendInfo();
  if (!info.configured) {
    throw new StoreNotConfiguredError();
  }

  if (info.backend === 'local_file') {
    const filePath = resolveLocalFile();
    const map = readLocalMap(filePath);
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      delete map[key];
      writeLocalMap(filePath, map);
    }
    return;
  }

  await runKvCommand(['DEL', String(key)]);
}

function _setAdapterForTests(adapter) {
  testAdapter = adapter || null;
}

module.exports = {
  StoreNotConfiguredError,
  isConfigured,
  getBackendInfo,
  get,
  put,
  putIfAbsent,
  del,
  _setAdapterForTests,
};
