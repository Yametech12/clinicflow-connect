// ClinicFlow Connect: clinic session, OAuth state signing, and HTTP helpers.
const crypto = require('crypto');

const CLINIC_COOKIE_NAME = 'cf_clinic';
const CLINIC_ID_RE = /^cln_[A-Za-z0-9_-]{8,48}$/;

function getRequestOrigin(req) {
  const headers = (req && req.headers) || {};
  const rawHost = headers['x-forwarded-host'] || headers.host || 'localhost';
  const host = String(rawHost).split(',')[0].trim();

  const forwardedProto = headers['x-forwarded-proto'];
  let proto;
  if (forwardedProto) {
    proto = String(forwardedProto).split(',')[0].trim();
  } else if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
    proto = 'http';
  } else {
    proto = 'https';
  }

  return { proto, host, origin: `${proto}://${host}` };
}

function parseCookies(req) {
  const header = req && req.headers && req.headers.cookie;
  const out = {};
  if (!header || typeof header !== 'string') return out;

  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch (err) {
      out[key] = val;
    }
  }
  return out;
}

function isValidClinicId(id) {
  return typeof id === 'string' && CLINIC_ID_RE.test(id);
}

function createClinicId() {
  return `cln_${crypto.randomBytes(12).toString('base64url')}`;
}

function getClinicIdFromRequest(req) {
  const queryId = req && req.query && req.query.clinic_id;
  if (isValidClinicId(queryId)) {
    return queryId;
  }
  const cookies = parseCookies(req);
  if (isValidClinicId(cookies[CLINIC_COOKIE_NAME])) {
    return cookies[CLINIC_COOKIE_NAME];
  }
  return null;
}

function setClinicCookie(req, res, clinicId) {
  if (!res || typeof res.setHeader !== 'function' || !isValidClinicId(clinicId)) {
    return;
  }
  const { proto } = getRequestOrigin(req);
  const parts = [
    `${CLINIC_COOKIE_NAME}=${encodeURIComponent(clinicId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${30 * 24 * 60 * 60}`,
  ];
  if (proto === 'https') {
    parts.push('Secure');
  }
  const cookieValue = parts.join('; ');
  const existing =
    typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
  if (!existing) {
    res.setHeader('Set-Cookie', cookieValue);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieValue]);
  } else {
    res.setHeader('Set-Cookie', [existing, cookieValue]);
  }
}

function ensureClinicId(req, res) {
  const existing = getClinicIdFromRequest(req);
  if (existing) {
    return existing;
  }
  const created = createClinicId();
  setClinicCookie(req, res, created);
  return created;
}

function signState(clinicId, provider, secret) {
  if (!secret) {
    throw new Error(`Cannot sign OAuth state without secret for ${provider}`);
  }
  const payload = {
    c: clinicId,
    p: provider,
    n: crypto.randomBytes(8).toString('hex'),
    t: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyState(state, expectedProvider, secret, maxAgeMs = 30 * 60 * 1000) {
  if (!state || typeof state !== 'string' || !secret) {
    return { valid: false, reason: 'Missing state or secret' };
  }
  const dotIdx = state.indexOf('.');
  if (dotIdx <= 0) {
    return { valid: false, reason: 'Malformed state parameter' };
  }
  const encoded = state.slice(0, dotIdx);
  const providedSig = state.slice(dotIdx + 1);
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(encoded)
    .digest('base64url');

  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'Invalid state signature' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (err) {
    return { valid: false, reason: 'Unreadable state payload' };
  }

  if (!payload || payload.p !== expectedProvider || !isValidClinicId(payload.c)) {
    return { valid: false, reason: 'State provider or clinic mismatch' };
  }

  if (!Number.isFinite(payload.t) || Date.now() - payload.t > maxAgeMs) {
    return { valid: false, reason: 'State parameter expired' };
  }

  return { valid: true, clinicId: payload.c };
}

async function readRequestBody(req) {
  if (req && req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      return req.body;
    }
    const rawStr = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : String(req.body);
    return parseRawBody(rawStr, req.headers && req.headers['content-type']);
  }

  if (!req || typeof req.on !== 'function') {
    return {};
  }

  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  return parseRawBody(raw, req.headers && req.headers['content-type']);
}

function parseRawBody(raw, contentType) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return {};
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(trimmed));
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    if (trimmed.includes('=') && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return Object.fromEntries(new URLSearchParams(trimmed));
    }
    return {};
  }
}

function wantsHtml(req) {
  if (req && req.query && req.query.format === 'json') {
    return false;
  }
  const accept = String((req && req.headers && req.headers.accept) || '');
  return accept.includes('text/html');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStatusHtml({ title, heading, message, tone = 'info', backHref = '/', extraHtml = '' }) {
  const badgeBg = tone === 'error' ? '#fef2f2' : tone === 'warn' ? '#fdf3e3' : '#e9f6ec';
  const badgeInk = tone === 'error' ? '#991b1b' : tone === 'warn' ? '#b45309' : '#15803d';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — ClinicFlow PH</title>
<style>
  body{background:#faf8f3;color:#1c2420;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.55;margin:0;padding:32px 20px}
  .box{max-width:560px;margin:30px auto;background:#fff;border:1px solid #ddd6c9;border-top:4px solid #0f766e;padding:24px}
  h1{font-family:Georgia,"Times New Roman",serif;font-size:24px;margin:0 0 10px}
  .note{background:${badgeBg};color:${badgeInk};padding:10px 12px;border-radius:4px;font-size:14px;margin:12px 0}
  .btn{display:inline-block;background:#0f766e;color:#fff;text-decoration:none;border:none;border-radius:4px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;margin-top:12px}
  .btn:hover{background:#0b5a54}
  .page-item{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid #ddd6c9;border-radius:4px;margin-top:8px;cursor:pointer}
</style>
</head>
<body>
  <div class="box">
    <h1>${escapeHtml(heading)}</h1>
    <div class="note">${escapeHtml(message)}</div>
    ${extraHtml}
    <div><a class="btn" href="${escapeHtml(backHref)}">Back to ClinicFlow Connect</a></div>
  </div>
</body>
</html>`;
}

function maskChatId(chatId) {
  const s = String(chatId || '');
  if (!s) return null;
  if (s.length <= 4) return s;
  return `${'*'.repeat(Math.min(4, s.length - 4))}${s.slice(-4)}`;
}

function sanitizeClinicSummary(clinic) {
  const profile = (clinic && clinic.profile) || {};
  const fb = (clinic && clinic.facebook) || {};
  const google = (clinic && clinic.google) || {};
  const tg = (clinic && clinic.telegram) || {};

  return {
    clinic_id: clinic ? clinic.clinicId : null,
    profile: {
      name: profile.name || '',
      address: profile.address || '',
      hours: profile.hours || '',
      timezone: profile.timezone || 'Asia/Manila',
    },
    connections: {
      facebook: {
        connected: Boolean(fb.pageId && fb.pageAccessToken),
        page_id: fb.pageId || null,
        page_name: fb.pageName || null,
        subscribed: Boolean(fb.subscribed),
        connected_at: fb.connectedAt || null,
      },
      google: {
        connected: Boolean(google.accessToken || google.refreshToken),
        has_refresh_token: Boolean(google.refreshToken),
        email: google.email || null,
        spreadsheet_id: google.spreadsheetId || null,
        spreadsheet_url: google.spreadsheetUrl || null,
        calendar_id: google.calendarId || 'primary',
        connected_at: google.connectedAt || null,
      },
      telegram: {
        connected: Boolean(tg.chatId),
        username: tg.username || null,
        first_name: tg.firstName || null,
        chat_id_masked: tg.chatId ? maskChatId(tg.chatId) : null,
        linked_at: tg.linkedAt || null,
      },
    },
  };
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.end();
}

module.exports = {
  CLINIC_COOKIE_NAME,
  getRequestOrigin,
  parseCookies,
  isValidClinicId,
  createClinicId,
  getClinicIdFromRequest,
  setClinicCookie,
  ensureClinicId,
  signState,
  verifyState,
  readRequestBody,
  wantsHtml,
  escapeHtml,
  renderStatusHtml,
  sanitizeClinicSummary,
  redirect,
};
