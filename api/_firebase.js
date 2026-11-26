// ClinicFlow Connect: Firebase Authentication ID token verification.
// GT-139 FL139-08. Hand-rolled on Node built-ins only (no new npm
// dependencies), following the same pattern as the HMAC state signing in
// _session.js. Verifies the RS256 signature against Google's public
// certificates for Firebase tokens, then checks expiry, audience, and
// issuer. The Firebase project id comes from the FIREBASE_PROJECT_ID
// environment variable when set, and otherwise from the built-in
// ClinicFlow project id constant below (GT-140 S5b), so Firebase login
// is configured without any Vercel env change.
const crypto = require('crypto');
const { timedFetch } = require('./_http');

const CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const CERT_CACHE_MS = 60 * 60 * 1000;

let certCache = { fetchedAt: 0, certs: null };
let certFetcherForTests = null;

// GT-140 S5b: the ClinicFlow Firebase project id as the built-in
// fallback, so no Vercel env var is needed. An explicit
// FIREBASE_PROJECT_ID env value still takes precedence when set.
const DEFAULT_FIREBASE_PROJECT_ID = 'clinicflow-connect-515810';

function getFirebaseProjectId() {
  return (process.env.FIREBASE_PROJECT_ID || '').trim() || DEFAULT_FIREBASE_PROJECT_ID;
}

function isFirebaseConfigured() {
  return Boolean(getFirebaseProjectId());
}

async function fetchCerts() {
  if (certFetcherForTests) {
    return certFetcherForTests();
  }
  const now = Date.now();
  if (certCache.certs && now - certCache.fetchedAt < CERT_CACHE_MS) {
    return certCache.certs;
  }
  const response = await timedFetch(CERTS_URL, {}, 10000);
  if (!response.ok) {
    throw new Error(`Could not load Firebase token certificates (HTTP ${response.status}).`);
  }
  const certs = await response.json();
  certCache = { fetchedAt: now, certs };
  return certs;
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

// Returns { uid, email, googleSub, provider } for a valid token.
// Throws an Error with a stable message for every rejection reason.
async function verifyFirebaseIdToken(token) {
  const projectId = getFirebaseProjectId();
  if (!projectId) {
    const err = new Error('Firebase login is not configured.');
    err.code = 'FIREBASE_NOT_CONFIGURED';
    throw err;
  }
  if (!token || typeof token !== 'string') {
    throw new Error('Missing ID token.');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed ID token.');
  }

  let header;
  let payload;
  try {
    header = decodeSegment(parts[0]);
    payload = decodeSegment(parts[1]);
  } catch (parseErr) {
    throw new Error('Unreadable ID token.');
  }

  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new Error('Unexpected ID token header.');
  }

  const certs = await fetchCerts();
  const pem = certs && certs[header.kid];
  if (!pem) {
    throw new Error('Unknown ID token signing key.');
  }

  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  const signature = Buffer.from(parts[2], 'base64url');
  let signatureOk = false;
  try {
    signatureOk = crypto.verify('RSA-SHA256', signingInput, pem, signature);
  } catch (verifyErr) {
    signatureOk = false;
  }
  if (!signatureOk) {
    throw new Error('ID token signature did not verify.');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!payload || typeof payload !== 'object') {
    throw new Error('Unreadable ID token payload.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    throw new Error('ID token expired.');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSeconds + 300) {
    throw new Error('ID token issued in the future.');
  }
  if (payload.aud !== projectId) {
    throw new Error('ID token audience mismatch.');
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('ID token issuer mismatch.');
  }
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) {
    throw new Error('ID token has no subject.');
  }

  const identities =
    (payload.firebase && payload.firebase.identities) || {};
  const googleIds = Array.isArray(identities['google.com'])
    ? identities['google.com']
    : [];

  return {
    uid: payload.sub,
    email: payload.email ? String(payload.email) : null,
    googleSub: googleIds.length ? String(googleIds[0]) : null,
    provider:
      payload.firebase && payload.firebase.sign_in_provider
        ? String(payload.firebase.sign_in_provider)
        : null,
  };
}

module.exports = {
  CERTS_URL,
  getFirebaseProjectId,
  isFirebaseConfigured,
  verifyFirebaseIdToken,
  _setCertFetcherForTests(fn) {
    certFetcherForTests = fn || null;
    certCache = { fetchedAt: 0, certs: null };
  },
};
