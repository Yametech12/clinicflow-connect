// ClinicFlow Connect GT-134 verification harness.
// Zero dependencies. Uses the in-memory store adapter exposed by api/_store.js
// (_setAdapterForTests) and a routed global.fetch mock. Run: node tests/run-tests.js
'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');

// --- Environment (must be set before handlers read it at call time) ---
process.env.META_APP_ID = 'meta_app_123';
process.env.META_APP_SECRET = 'test_meta_secret';
process.env.META_VERIFY_TOKEN = 'test_verify_token';
process.env.GOOGLE_CLIENT_ID = 'google_client_123';
process.env.GOOGLE_CLIENT_SECRET = 'test_google_secret';
process.env.GEMINI_API_KEY = 'test_gemini_key';
process.env.TELEGRAM_BOT_TOKEN = 'test_tg_token';
process.env.TELEGRAM_BOT_USERNAME = 'clinicflowph_alerts_bot';
process.env.TELEGRAM_WEBHOOK_SECRET = 'test_tg_webhook_secret';
process.env.ADMIN_PROBE_TOKEN = 'test_admin_probe';
delete process.env.PUBLIC_BASE_URL;
delete process.env.GEMINI_MODEL;

// --- In-memory store adapter with TTL ---
function makeAdapter() {
  const map = new Map();
  const alive = (e) => e && (!e.exp || e.exp > Date.now());
  return {
    map,
    async get(key) {
      const e = map.get(key);
      if (!alive(e)) {
        map.delete(key);
        return null;
      }
      return e.value === undefined ? null : JSON.parse(JSON.stringify(e.value));
    },
    async put(key, value, opts = {}) {
      map.set(key, {
        value: value === undefined ? null : JSON.parse(JSON.stringify(value)),
        exp: opts.ttlSeconds ? Date.now() + opts.ttlSeconds * 1000 : null,
      });
    },
    async putIfAbsent(key, value, opts = {}) {
      const e = map.get(key);
      if (alive(e)) return false;
      await this.put(key, value, opts);
      return true;
    },
    async del(key) {
      map.delete(key);
    },
  };
}

const adapter = makeAdapter();
const store = require('../api/_store');
store._setAdapterForTests(adapter);

const session = require('../api/_session');
const clinicStore = require('../api/_clinic');
const pipeline = require('../api/_pipeline');
const google = require('../api/_google');
const webhookHandler = require('../api/webhook');
const clinicHandler = require('../api/clinic');
const healthHandler = require('../api/health');
const connectTelegram = require('../api/connect/telegram');
const callbackGoogle = require('../api/callback/google');
const logoutHandler = require('../api/logout');
const bookingsHandler = require('../api/bookings');

// --- fetch mock ---
const fetchLog = [];
let geminiBehavior = { mode: 'ok', payload: null };
let googleWriteBehavior = { calendar: 'ok', leads: 'ok', logs: 'ok' };
let googleTokenBehavior = { mode: 'ok' };
let userinfoBehavior = { sub: 'sub_owner_1', email: 'clinic.owner@example.com' };

function jsonResponse(status, obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
  };
}

global.fetch = async (url, options = {}) => {
  const u = String(url);
  fetchLog.push({ url: u, options });

  if (u.includes('generativelanguage.googleapis.com')) {
    if (geminiBehavior.mode === 'http500') {
      return jsonResponse(500, { error: { message: 'mock gemini outage' } });
    }
    const payload = geminiBehavior.payload || {
      reply: 'Hi po! How can we help with your smile today?',
      ready_to_book: false,
      booking: {},
    };
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    });
  }
  if (u.includes('graph.facebook.com') && u.includes('/me/messages')) {
    return jsonResponse(200, { recipient_id: 'x', message_id: 'm' });
  }
  if (u.includes('oauth2.googleapis.com/token')) {
    if (googleTokenBehavior.mode === 'fail') {
      return jsonResponse(500, { error: { message: 'mock token endpoint failure' } });
    }
    return jsonResponse(200, {
      access_token: 'ya29.mock_access',
      refresh_token: 'mock_refresh_new',
      expires_in: 3600,
    });
  }
  if (u.includes('oauth2/v2/userinfo')) {
    return jsonResponse(200, { email: userinfoBehavior.email, sub: userinfoBehavior.sub });
  }
  if (/sheets\.googleapis\.com\/v4\/spreadsheets\/?$/.test(u) && options.method === 'POST') {
    return jsonResponse(200, {
      spreadsheetId: 'sheet_created_1',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_created_1',
    });
  }
  if (u.includes('sheets.googleapis.com') && u.includes(':append')) {
    const isLeads = u.includes('Leads_Bookings');
    const isLogs = u.includes('System_Logs');
    if (isLeads && googleWriteBehavior.leads === 'fail') {
      return jsonResponse(500, { error: { message: 'mock leads append failure' } });
    }
    if (isLogs && googleWriteBehavior.logs === 'fail') {
      return jsonResponse(500, { error: { message: 'mock logs append failure' } });
    }
    return jsonResponse(200, { updates: { updatedRows: 1 } });
  }
  if (u.includes('sheets.googleapis.com') && u.includes('/values/')) {
    if (u.includes('Leads_Bookings')) {
      // Bookings read: rows controlled by leadRows global
      return jsonResponse(200, { values: global.__leadRows || [] });
    }
    // FAQ read: rows controlled by faqRows global
    return jsonResponse(200, { values: global.__faqRows || [] });
  }
  if (u.includes('sheets.googleapis.com')) {
    return jsonResponse(200, {});
  }
  if (u.includes('calendar/v3/calendars')) {
    if (googleWriteBehavior.calendar === 'fail') {
      return jsonResponse(500, { error: { message: 'mock calendar failure' } });
    }
    return jsonResponse(200, { id: 'evt_mock_1' });
  }
  if (u.includes('api.telegram.org')) {
    return jsonResponse(200, { ok: true, result: {} });
  }
  return jsonResponse(404, { error: { message: 'unmocked url: ' + u } });
};

// --- req/res mocks ---
function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[String(k).toLowerCase()];
    },
    end(payload) {
      if (payload !== undefined) this.body = payload;
      return this;
    },
  };
  return res;
}

function makeReq({ method = 'GET', query = {}, headers = {}, rawBody = null, body = undefined } = {}) {
  const req = { method, query, headers };
  if (rawBody) req.rawBody = rawBody;
  if (body !== undefined) req.body = body;
  return req;
}

function sign(rawBuf, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBuf).digest('hex');
}

function pageEvent({ pageId, senderId, mid, text }) {
  return {
    object: 'page',
    entry: [
      {
        id: pageId,
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: pageId },
            message: { mid, text },
          },
        ],
      },
    ],
  };
}

async function postWebhook(payloadObj, { secret = process.env.META_APP_SECRET, signature = 'valid' } = {}) {
  const raw = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const headers = { 'content-type': 'application/json' };
  if (signature === 'valid') headers['x-hub-signature-256'] = sign(raw, secret);
  if (signature === 'bad') headers['x-hub-signature-256'] = 'sha256=' + '0'.repeat(64);
  const req = makeReq({ method: 'POST', headers, rawBody: raw });
  const res = makeRes();
  await webhookHandler(req, res);
  return res;
}

async function seedClinic({ withGoogle = false } = {}) {
  const clinicId = session.createClinicId();
  const key = session.createClinicKey();
  await clinicStore.saveClinicSection(store, clinicId, 'meta', {
    clinicId,
    keyHash: session.hashClinicKey(key),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await clinicStore.saveClinicSection(store, clinicId, 'profile', {
    name: 'BrightSmile Dental Clinic',
    address: 'Quezon Ave., Iligan City',
    hours: 'Mon to Sat, 9:00 AM to 6:00 PM',
    timezone: 'Asia/Manila',
  });
  await clinicStore.saveClinicSection(store, clinicId, 'facebook', {
    pageId: 'page_1001',
    pageName: 'BrightSmile Dental',
    pageAccessToken: 'page_token_mock',
    subscribed: true,
    connectedAt: new Date().toISOString(),
  });
  await store.put('fb_page:page_1001', { clinicId });
  if (withGoogle) {
    await clinicStore.saveClinicSection(store, clinicId, 'google', {
      email: 'clinic.owner@example.com',
      accessToken: null,
      refreshToken: 'mock_refresh',
      expiresAt: 0,
      spreadsheetId: 'sheet_abc',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_abc',
      calendarId: 'primary',
      connectedAt: new Date().toISOString(),
    });
  }
  return { clinicId, key };
}

function graphReplies() {
  return fetchLog
    .filter((c) => c.url.includes('graph.facebook.com') && c.url.includes('/me/messages'))
    .map((c) => JSON.parse(c.options.body).message.text);
}

function telegramSends() {
  return fetchLog
    .filter((c) => c.url.includes('api.telegram.org'))
    .map((c) => JSON.parse(c.options.body));
}

// --- tiny test framework ---
const results = [];
async function test(name, fn) {
  fetchLog.length = 0;
  geminiBehavior = { mode: 'ok', payload: null };
  googleWriteBehavior = { calendar: 'ok', leads: 'ok', logs: 'ok' };
  googleTokenBehavior = { mode: 'ok' };
  userinfoBehavior = { sub: 'sub_owner_1', email: 'clinic.owner@example.com' };
  global.__faqRows = [];
  global.__leadRows = [];
  try {
    await fn();
    results.push(['PASS', name]);
    console.log('PASS  ' + name);
  } catch (err) {
    results.push(['FAIL', name + ' :: ' + err.message]);
    console.log('FAIL  ' + name + ' :: ' + err.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

(async () => {
  // 1. Webhook GET verification
  await test('webhook GET verification: right token echoes challenge, wrong token 403', async () => {
    let res = makeRes();
    await webhookHandler(
      makeReq({ query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'test_verify_token', 'hub.challenge': 'CHAL42' } }),
      res
    );
    assertEq(res.statusCode, 200, 'right token status');
    assertEq(res.body, 'CHAL42', 'challenge echoed');
    res = makeRes();
    await webhookHandler(
      makeReq({ query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'CHAL42' } }),
      res
    );
    assertEq(res.statusCode, 403, 'wrong token status');
  });

  // 2. Unsigned Meta POST fails closed when the app secret is set
  await test('webhook POST unsigned Meta payload -> 403 (fail closed)', async () => {
    await seedClinic();
    const res = await postWebhook(pageEvent({ pageId: 'page_1001', senderId: 'psid_1', mid: 'mid_u1', text: 'Pila ang cleaning?' }), { signature: 'none' });
    assertEq(res.statusCode, 403, 'unsigned status');
    assertEq(graphReplies().length, 0, 'no reply sent');
  });

  // 3. Bad signature -> 403
  await test('webhook POST bad signature -> 403', async () => {
    const res = await postWebhook(pageEvent({ pageId: 'page_1001', senderId: 'psid_1', mid: 'mid_u2', text: 'hi' }), { signature: 'bad' });
    assertEq(res.statusCode, 403, 'bad signature status');
  });

  // 4. Correctly signed Meta POST processes and replies; Gemini key sent as header, not URL
  await test('webhook POST signed Meta event -> 200, reply sent, Gemini key in header only', async () => {
    const res = await postWebhook(pageEvent({ pageId: 'page_1001', senderId: 'psid_1', mid: 'mid_s1', text: 'Pila ang cleaning?' }));
    assertEq(res.statusCode, 200, 'signed status');
    assertEq(res.body, 'EVENT_RECEIVED', 'ack body');
    const replies = graphReplies();
    assertEq(replies.length, 1, 'one reply');
    const geminiCall = fetchLog.find((c) => c.url.includes('generativelanguage.googleapis.com'));
    assert(geminiCall, 'gemini called');
    assert(!geminiCall.url.includes('key='), 'no key in Gemini URL');
    assertEq(geminiCall.options.headers['x-goog-api-key'], 'test_gemini_key', 'key header present');
    const genCfg = JSON.parse(geminiCall.options.body).generationConfig;
    assert(!('temperature' in genCfg), 'temperature removed from generationConfig');
  });

  // 5. Signed POST via the raw stream path (no req.rawBody, no req.body)
  await test('webhook POST signed via request stream -> 200', async () => {
    const payload = pageEvent({ pageId: 'page_1001', senderId: 'psid_2', mid: 'mid_s2', text: 'hello po' });
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = Readable.from([raw]);
    req.method = 'POST';
    req.query = {};
    req.headers = { 'x-hub-signature-256': sign(raw, process.env.META_APP_SECRET) };
    const res = makeRes();
    await webhookHandler(req, res);
    assertEq(res.statusCode, 200, 'stream status');
    assertEq(graphReplies().length, 1, 'reply sent via stream path');
  });

  // 6. Unparseable payload WITH a valid signature -> logged 200, not a crash
  await test('webhook POST unparseable body with valid signature -> 200 EVENT_RECEIVED', async () => {
    const raw = Buffer.from('this is not json', 'utf8');
    const req = makeReq({
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(raw, process.env.META_APP_SECRET) },
      rawBody: raw,
    });
    const res = makeRes();
    await webhookHandler(req, res);
    assertEq(res.statusCode, 200, 'unparseable signed status');
  });

  // 7. Dedup: same mid twice -> second is a no-op
  await test('dedup: duplicate mid processed once', async () => {
    const ev = pageEvent({ pageId: 'page_1001', senderId: 'psid_3', mid: 'mid_dup', text: 'Pila ang pasta?' });
    await postWebhook(ev);
    await postWebhook(ev);
    assertEq(graphReplies().length, 1, 'only one reply for duplicate mid');
  });

  // 8. Dedup release on Gemini failure + dead-letter record + retry succeeds
  await test('dedup released on Gemini failure, dead letter written, retry processes', async () => {
    geminiBehavior = { mode: 'http500' };
    const ev = pageEvent({ pageId: 'page_1001', senderId: 'psid_4', mid: 'mid_fail1', text: 'Pila ang cleaning?' });
    const res1 = await postWebhook(ev);
    assertEq(res1.statusCode, 200, 'webhook still acks');
    assertEq(graphReplies().length, 0, 'no reply while Gemini down');
    const dedupAfter = await store.get('msg_dedup:page_1001:mid_fail1');
    assertEq(dedupAfter, null, 'dedup key released after failure');
    const deadKeys = [...adapter.map.keys()].filter((k) => k.startsWith('dead:page_1001:'));
    assert(deadKeys.length >= 1, 'dead-letter record written');
    geminiBehavior = { mode: 'ok', payload: null };
    const res2 = await postWebhook(ev);
    assertEq(res2.statusCode, 200, 'retry status');
    assertEq(graphReplies().length, 1, 'retry produced a reply');
  });

  // 9. Booking fallback when every Google write fails
  await test('booking fallback: Google writes fail -> fallback reply, no guard, ERROR log attempted', async () => {
    const { clinicId } = await seedClinic({ withGoogle: true });
    void clinicId;
    googleWriteBehavior = { calendar: 'fail', leads: 'fail', logs: 'ok' };
    geminiBehavior = {
      mode: 'ok',
      payload: {
        reply: 'Booked na po! See you soon.',
        ready_to_book: true,
        booking: {
          patient_name: 'Juan Dela Cruz',
          mobile_number: '09171234567',
          service: 'Oral Prophylaxis (Teeth Cleaning)',
          preferred_datetime_text: 'tomorrow 2pm',
          iso_start_time: '2026-11-26T14:00:00+08:00',
          notes: '',
        },
      },
    };
    const res = await postWebhook(pageEvent({ pageId: 'page_1001', senderId: 'psid_5', mid: 'mid_b1', text: 'Book cleaning tomorrow 2pm, Juan Dela Cruz, 09171234567' }));
    assertEq(res.statusCode, 200, 'status');
    const replies = graphReplies();
    assertEq(replies.length, 1, 'one reply');
    assert(replies[0].includes('hindi pa ito naisulat sa booking system'), 'fallback reply text used, got: ' + replies[0]);
    const guard = await store.get('booked:page_1001:psid_5');
    assertEq(guard, null, 'booked guard NOT set when nothing was written');
    const logAppend = fetchLog.find((c) => c.url.includes('System_Logs') && c.url.includes(':append'));
    assert(logAppend, 'System_Logs append attempted');
    assert(JSON.parse(logAppend.options.body).values[0][1] === 'ERROR', 'log level is ERROR');
    const hist = await store.get('hist:page_1001:psid_5');
    assert(Array.isArray(hist) && hist.length === 2, 'history kept after failed booking');
  });

  // 10. Booking success after recovery: guard set only after a record is written
  await test('booking success: calendar + lead written, guard set, AI reply sent', async () => {
    geminiBehavior = {
      mode: 'ok',
      payload: {
        reply: 'Booked na po! See you soon.',
        ready_to_book: true,
        booking: {
          patient_name: 'Juan Dela Cruz',
          mobile_number: '09171234567',
          service: 'Oral Prophylaxis (Teeth Cleaning)',
          preferred_datetime_text: 'tomorrow 2pm',
          iso_start_time: '2026-11-26T14:00:00+08:00',
          notes: '',
        },
      },
    };
    const res = await postWebhook(pageEvent({ pageId: 'page_1001', senderId: 'psid_5', mid: 'mid_b2', text: 'Yes please book it' }));
    assertEq(res.statusCode, 200, 'status');
    const replies = graphReplies();
    assertEq(replies[0], 'Booked na po! See you soon.', 'AI confirmation reply sent');
    const guard = await store.get('booked:page_1001:psid_5');
    assertEq(guard, '1', 'booked guard set after successful write');
    const calCall = fetchLog.find((c) => c.url.includes('calendar/v3/calendars'));
    assert(calCall, 'calendar event created');
    const leadAppend = fetchLog.find((c) => c.url.includes('Leads_Bookings') && c.url.includes(':append'));
    assert(leadAppend, 'lead row appended');
    const hist = await store.get('hist:page_1001:psid_5');
    assertEq(hist, null, 'history cleared after confirmed booking');
  });

  // 11. Mobile validation unit cases (QA m10)
  await test('mobile validation: PH pattern cases', async () => {
    assert(pipeline.isValidPhilippineMobile('09171234567'), '0917... valid');
    assert(pipeline.isValidPhilippineMobile('+639171234567'), '+63917... valid');
    assert(pipeline.isValidPhilippineMobile('0917 123 4567'), 'spaces stripped');
    assert(!pipeline.isValidPhilippineMobile('12345'), '12345 invalid');
    assert(!pipeline.isValidPhilippineMobile('021234567'), 'landline invalid');
    assert(!pipeline.isValidPhilippineMobile(''), 'empty invalid');
    assert(
      !pipeline.hasCompleteBookingDetails({ patient_name: 'Ana', mobile_number: '12345', preferred_datetime_text: 'tomorrow' }),
      'booking incomplete with bad mobile'
    );
    assert(
      pipeline.hasCompleteBookingDetails({ patient_name: 'Ana', mobile_number: '09171234567', preferred_datetime_text: 'tomorrow' }),
      'booking complete with good mobile'
    );
  });

  // 12. Invalid mobile in a ready_to_book payload -> patient asked again, no writes
  await test('invalid mobile: no calendar/lead writes, patient re-asked', async () => {
    await seedClinic({ withGoogle: true });
    geminiBehavior = {
      mode: 'ok',
      payload: {
        reply: 'Booked!',
        ready_to_book: true,
        booking: {
          patient_name: 'Ana Santos',
          mobile_number: '12345',
          service: 'Cleaning',
          preferred_datetime_text: 'Friday 10am',
          iso_start_time: '2026-11-27T10:00:00+08:00',
          notes: '',
        },
      },
    };
    await postWebhook(pageEvent({ pageId: 'page_1001', senderId: 'psid_6', mid: 'mid_m1', text: 'book friday, Ana, 12345' }));
    const replies = graphReplies();
    assertEq(replies.length, 1, 'one reply');
    assert(replies[0].includes('Paki-check po ng mobile number'), 're-ask reply used');
    assert(!fetchLog.some((c) => c.url.includes('calendar/v3/calendars')), 'no calendar write');
    assert(!fetchLog.some((c) => c.url.includes('Leads_Bookings')), 'no lead write');
  });

  // 13. OAuth state: future timestamp rejected; nonce single-use
  await test('oauth state: future timestamp rejected, nonce consumed once', async () => {
    const secret = 'test_google_secret';
    const clinicId = session.createClinicId();
    const payload = { c: clinicId, p: 'google', n: crypto.randomBytes(12).toString('hex'), t: Date.now() + 10 * 60 * 1000 };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    const future = session.verifyState(`${encoded}.${sig}`, 'google', secret);
    assert(!future.valid, 'future-dated state rejected');

    const good = session.signState(clinicId, 'google', secret);
    const check = session.verifyState(good, 'google', secret);
    assert(check.valid, 'fresh state valid');
    const first = await session.consumeSingleUseState(store, check.nonce);
    const second = await session.consumeSingleUseState(store, check.nonce);
    assertEq(first, true, 'first consume ok');
    assertEq(second, false, 'second consume rejected');
  });

  // 14. Google callback end-to-end: state works once, replay returns 400
  await test('google callback: first use redirects, replayed state -> 400', async () => {
    const clinicId = session.createClinicId();
    const state = session.signState(clinicId, 'google', process.env.GOOGLE_CLIENT_SECRET);
    const mkReq = () =>
      makeReq({
        query: { code: 'mock_code', state },
        headers: { accept: 'text/html', host: 'clinicflow-connect-two.vercel.app', 'x-forwarded-proto': 'https' },
      });
    let res = makeRes();
    await callbackGoogle(mkReq(), res);
    assertEq(res.statusCode, 302, 'first callback redirects');
    assert(String(res.headers.location || '').includes('connected=google'), 'redirect to connected=google');
    const googleSection = await clinicStore.getClinicSection(store, clinicId, 'google');
    assert(googleSection && googleSection.accessToken === 'ya29.mock_access', 'tokens stored on google section');
    res = makeRes();
    await callbackGoogle(mkReq(), res);
    assertEq(res.statusCode, 400, 'replayed state rejected with 400');
  });

  // 15. Per-section keys: legacy migration + concurrent section writes both survive
  await test('clinic sections: legacy record migrates, concurrent google+telegram writes survive', async () => {
    const clinicId = session.createClinicId();
    await store.put(`clinic:${clinicId}`, {
      profile: { name: 'Legacy Clinic', address: 'Old address', hours: '9-5', timezone: 'Asia/Manila' },
      facebook: { pageId: 'page_legacy', pageName: 'Legacy', pageAccessToken: 'tok', subscribed: true },
      google: { email: 'legacy@example.com', spreadsheetId: 'sheet_legacy' },
      telegram: null,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    });
    const assembled = await clinicStore.getClinic(store, clinicId);
    assert(assembled && assembled.profile && assembled.profile.name === 'Legacy Clinic', 'legacy profile migrated');
    assertEq(await store.get(`clinic:${clinicId}`), null, 'legacy key removed after migration');
    await Promise.all([
      clinicStore.saveClinicSection(store, clinicId, 'google', { email: 'legacy@example.com', spreadsheetId: 'sheet_legacy', accessToken: 'fresh_tok' }),
      clinicStore.saveClinicSection(store, clinicId, 'telegram', { chatId: '777001', username: 'owner', firstName: 'Owner', linkedAt: new Date().toISOString() }),
    ]);
    const after = await clinicStore.getClinic(store, clinicId);
    assertEq(after.google.accessToken, 'fresh_tok', 'google write survived');
    assertEq(after.telegram.chatId, '777001', 'telegram write survived');
    assertEq(after.facebook.pageId, 'page_legacy', 'facebook section untouched');
  });

  // 16. Clinic identity lockdown
  await test('clinic identity: query-string id ignored, POST needs cf_key, legacy session binds key on GET', async () => {
    const { clinicId, key } = await seedClinic({ withGoogle: true });

    // GET with ?clinic_id= but no cookies must NOT return that clinic's data
    let res = makeRes();
    await clinicHandler(makeReq({ query: { clinic_id: clinicId }, headers: { host: 'x.example', 'x-forwarded-proto': 'https' } }), res);
    assert(res.body.clinic_id !== clinicId, 'query clinic_id not honored');
    assert(!JSON.stringify(res.body).includes('clinic.owner@example.com'), 'target clinic email not leaked');

    // POST without cookies -> 403
    res = makeRes();
    res.req = null;
    const postReq = makeReq({ method: 'POST', headers: { host: 'x.example', 'x-forwarded-proto': 'https' }, body: { name: 'Hacked Name' } });
    await clinicHandler(postReq, res);
    assertEq(res.statusCode, 403, 'POST without cookies forbidden');

    // POST with wrong cf_key -> 403
    res = makeRes();
    const wrongKeyReq = makeReq({
      method: 'POST',
      headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${clinicId}; cf_key=${session.createClinicKey()}` },
      body: { name: 'Hacked Name' },
    });
    await clinicHandler(wrongKeyReq, res);
    assertEq(res.statusCode, 403, 'POST with wrong key forbidden');

    // POST with correct cookies -> 200 saved
    res = makeRes();
    const goodReq = makeReq({
      method: 'POST',
      headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${clinicId}; cf_key=${key}` },
      body: { name: 'BrightSmile Dental Clinic', address: 'Quezon Ave., Iligan City', hours: 'Mon to Sat' },
    });
    await clinicHandler(goodReq, res);
    assertEq(res.statusCode, 200, 'POST with correct key saves');
    assertEq(res.body.status, 'saved', 'saved status');

    // Legacy clinic (v1 record, no keyHash): GET with only cf_clinic cookie binds a cf_key
    const legacyId = session.createClinicId();
    await store.put(`clinic:${legacyId}`, {
      profile: { name: 'V1 Clinic', address: '', hours: '', timezone: 'Asia/Manila' },
      google: { email: 'v1@example.com', spreadsheetId: 'sheet_v1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_v1' },
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
    });
    res = makeRes();
    await clinicHandler(
      makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${legacyId}` } }),
      res
    );
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie || '');
    assert(cookieStr.includes('cf_key='), 'cf_key cookie issued for legacy session');
    assertEq(res.body.connections.google.email, 'v1@example.com', 'legacy clinic sees its own sensitive fields after bind');
    // And the issued key can now POST
    const issuedKey = cookieStr.match(/cf_key=([^;]+)/)[1];
    res = makeRes();
    await clinicHandler(
      makeReq({
        method: 'POST',
        headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${legacyId}; cf_key=${decodeURIComponent(issuedKey)}` },
        body: { name: 'V1 Clinic Updated' },
      }),
      res
    );
    assertEq(res.statusCode, 200, 'legacy clinic can save after key bind');
  });

  // 17. Health endpoint: public minimal, admin probe detailed
  await test('health: public returns only status ok; admin probe returns detail', async () => {
    let res = makeRes();
    healthHandler(makeReq({ headers: {} }), res);
    assertEq(JSON.stringify(res.body), JSON.stringify({ status: 'ok' }), 'public health minimal');
    res = makeRes();
    healthHandler(makeReq({ headers: { 'x-admin-probe': 'test_admin_probe' } }), res);
    assert(res.body.providers && res.body.providers.storage === true, 'admin probe sees providers');
    res = makeRes();
    healthHandler(makeReq({ headers: { 'x-admin-probe': 'wrong' } }), res);
    assertEq(JSON.stringify(res.body), JSON.stringify({ status: 'ok' }), 'wrong probe token stays minimal');
  });

  // 18. Telegram linking: code issue, /start link, re-link notice, guess backoff
  await test('telegram: code issued with putIfAbsent, /start links, re-link notifies old chat, 5 bad guesses back off', async () => {
    const { clinicId, key } = await seedClinic();
    const cookie = `cf_clinic=${clinicId}; cf_key=${key}`;
    let res = makeRes();
    await connectTelegram(makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie } }), res);
    assertEq(res.body.status, 'ready', 'telegram connect ready');
    const code = res.body.linking_code;
    assert(code && code.length === 6, '6-char code issued');

    const tgUpdate = (chatId, text) => ({ update_id: 1, message: { chat: { id: chatId, type: 'private' }, from: { username: 'owner', first_name: 'Owner' }, text } });
    const postTg = async (update, secretHeader) => {
      const headers = { 'content-type': 'application/json' };
      if (secretHeader) headers['x-telegram-bot-api-secret-token'] = secretHeader;
      const r = makeReq({ method: 'POST', headers, rawBody: Buffer.from(JSON.stringify(update), 'utf8') });
      const s = makeRes();
      await webhookHandler(r, s);
      return s;
    };

    // Wrong webhook secret -> 403
    let s = await postTg(tgUpdate(555001, '/start ' + code), 'wrong_secret');
    assertEq(s.statusCode, 403, 'telegram webhook secret enforced');

    // Correct secret + /start -> linked
    s = await postTg(tgUpdate(555001, '/start ' + code), 'test_tg_webhook_secret');
    assertEq(s.statusCode, 200, 'telegram update ok');
    assertEq(s.body.status, 'linked', 'chat linked');
    let tgSection = await clinicStore.getClinicSection(store, clinicId, 'telegram');
    assertEq(tgSection.chatId, '555001', 'telegram section stored');

    // Re-link to a new chat -> old chat gets a notice
    res = makeRes();
    await connectTelegram(makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie } }), res);
    const code2 = res.body.linking_code;
    fetchLog.length = 0;
    s = await postTg(tgUpdate(555002, '/start ' + code2), 'test_tg_webhook_secret');
    assertEq(s.body.status, 'linked', 'second chat linked');
    const sends = telegramSends();
    assert(sends.some((m) => String(m.chat_id) === '555001' && /moved to a different Telegram chat/.test(m.text)), 'old chat notified of move');
    tgSection = await clinicStore.getClinicSection(store, clinicId, 'telegram');
    assertEq(tgSection.chatId, '555002', 'telegram section now points at new chat');

    // Guess backoff: 5 bad codes from a fresh chat, 6th is rate limited
    for (let i = 0; i < 5; i += 1) {
      s = await postTg(tgUpdate(555999, '/start ZZZZZ' + i), 'test_tg_webhook_secret');
      assertEq(s.body.status, 'invalid_or_expired_code', 'bad code rejected ' + i);
    }
    s = await postTg(tgUpdate(555999, '/start ZZZZZ9'), 'test_tg_webhook_secret');
    assertEq(s.body.status, 'rate_limited', 'sixth bad attempt rate limited');
  });

  // 20. GT-135: first Google login binds the account sub to the cookie clinic
  await test('google login: first login binds sub to state clinic, index written, redirect to /dashboard', async () => {
    userinfoBehavior.sub = 'sub_first_login';
    const clinicId = session.createClinicId();
    const state = session.signState(clinicId, 'google', process.env.GOOGLE_CLIENT_SECRET);
    const res = makeRes();
    await callbackGoogle(
      makeReq({
        query: { code: 'mock_code', state },
        headers: { accept: 'text/html', host: 'clinicflow-connect-two.vercel.app', 'x-forwarded-proto': 'https' },
      }),
      res
    );
    assertEq(res.statusCode, 302, 'callback redirects');
    assertEq(res.headers.location, '/dashboard?connected=google', 'redirect lands on dashboard');
    const googleSection = await clinicStore.getClinicSection(store, clinicId, 'google');
    assertEq(googleSection.googleSub, 'sub_first_login', 'sub stored on google section');
    assertEq(googleSection.email, 'clinic.owner@example.com', 'email stored');
    const index = await store.get('clinicByGoogleSub:sub_first_login');
    assert(index && index.clinicId === clinicId, 'google sub index points at the clinic');
    const lookedUp = await clinicStore.getClinicIdByGoogleSub(store, 'sub_first_login');
    assertEq(lookedUp, clinicId, 'index helper resolves the clinic');
  });

  // 21. GT-135: returning login adopts the record bound to the Google account
  await test('google login: returning account adopts its bound record and gets a working session', async () => {
    userinfoBehavior.sub = 'sub_returning';
    // Clinic A: the record this Google account already owns.
    const clinicA = session.createClinicId();
    const keyA = session.createClinicKey();
    await clinicStore.saveClinicSection(store, clinicA, 'meta', {
      clinicId: clinicA,
      keyHash: session.hashClinicKey(keyA),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await clinicStore.saveClinicSection(store, clinicA, 'google', {
      email: 'clinic.owner@example.com',
      googleSub: 'sub_returning',
      accessToken: 'old_access_token',
      refreshToken: 'mock_refresh',
      expiresAt: 0,
      spreadsheetId: 'sheet_A',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_A',
      calendarId: 'primary',
      connectedAt: new Date().toISOString(),
    });
    await clinicStore.bindGoogleSub(store, 'sub_returning', clinicA);

    // Clinic B: a fresh anonymous clinic carried by this login's state.
    const clinicB = session.createClinicId();
    const state = session.signState(clinicB, 'google', process.env.GOOGLE_CLIENT_SECRET);
    const res = makeRes();
    await callbackGoogle(
      makeReq({
        query: { code: 'mock_code', state },
        headers: { accept: 'text/html', host: 'clinicflow-connect-two.vercel.app', 'x-forwarded-proto': 'https' },
      }),
      res
    );
    assertEq(res.statusCode, 302, 'adoption callback redirects');
    assertEq(res.headers.location, '/dashboard?connected=google', 'redirect lands on dashboard');
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie || '');
    assert(cookieStr.includes(`cf_clinic=${clinicA}`), 'session cookie switched to the adopted record');
    const adoptedGoogle = await clinicStore.getClinicSection(store, clinicA, 'google');
    assertEq(adoptedGoogle.accessToken, 'ya29.mock_access', 'fresh tokens stored on adopted record');
    assertEq(adoptedGoogle.spreadsheetId, 'sheet_A', 'adopted record keeps its own sheet');
    const stateGoogle = await clinicStore.getClinicSection(store, clinicB, 'google');
    assertEq(stateGoogle, null, 'state clinic received no google section');

    // The rotated key issued during adoption can save the adopted record.
    const issuedKey = decodeURIComponent(cookieStr.match(/cf_key=([^;]+)/)[1]);
    const saveRes = makeRes();
    await clinicHandler(
      makeReq({
        method: 'POST',
        headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${clinicA}; cf_key=${issuedKey}` },
        body: { name: 'Adopted Clinic' },
      }),
      saveRes
    );
    assertEq(saveRes.statusCode, 200, 'adopted session can save profile');
  });

  // 22. GT-135: dashboard gate signals (logged_in flag + bookings 401)
  await test('dashboard gate: anonymous and unbound sessions are not logged in; bound session is', async () => {
    // No cookies at all -> bookings refuses, clinic reports logged_in false
    let res = makeRes();
    await bookingsHandler(makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https' } }), res);
    assertEq(res.statusCode, 401, 'bookings without session is 401');
    assertEq(res.body.status, 'login_required', 'login_required status');

    // Connected Google but never bound (no googleSub) -> still not logged in
    const { clinicId, key } = await seedClinic({ withGoogle: true });
    const cookie = `cf_clinic=${clinicId}; cf_key=${key}`;
    res = makeRes();
    await bookingsHandler(makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie } }), res);
    assertEq(res.statusCode, 401, 'bookings for unbound clinic is 401');
    res = makeRes();
    await clinicHandler(makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie } }), res);
    assertEq(res.body.logged_in, false, 'unbound clinic logged_in false');
    assertEq(res.body.connections.google.bound, false, 'bound flag false');

    // Bind the sub -> logged in everywhere
    const googleSection = await clinicStore.getClinicSection(store, clinicId, 'google');
    await clinicStore.saveClinicSection(store, clinicId, 'google', { ...googleSection, googleSub: 'sub_owner_1' });
    res = makeRes();
    await clinicHandler(makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie } }), res);
    assertEq(res.body.logged_in, true, 'bound clinic logged_in true');
    assertEq(res.body.connections.google.bound, true, 'bound flag true');
  });

  // 23. GT-135: logout clears both session cookies and redirects to /
  await test('logout: clears cf_clinic and cf_key, redirects to landing', async () => {
    const res = makeRes();
    await logoutHandler(
      makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: 'cf_clinic=cln_x; cf_key=abc' } }),
      res
    );
    assertEq(res.statusCode, 302, 'logout redirects');
    assertEq(res.headers.location, '/', 'logout lands on /');
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(' | ') : String(setCookie || '');
    assert(cookieStr.includes('cf_clinic='), 'cf_clinic cleared');
    assert(cookieStr.includes('cf_key='), 'cf_key cleared');
    assert((cookieStr.match(/Max-Age=0/g) || []).length >= 2, 'both cookies expired');
  });

  // 24. GT-135: recent bookings read (rows, empty, no sheet, refresh failure)
  await test('bookings read: last 10 rows newest first, empty sheet, no_sheet, token refresh failure honest', async () => {
    const { clinicId, key } = await seedClinic({ withGoogle: true });
    const googleSection = await clinicStore.getClinicSection(store, clinicId, 'google');
    await clinicStore.saveClinicSection(store, clinicId, 'google', { ...googleSection, googleSub: 'sub_owner_1' });
    const cookie = `cf_clinic=${clinicId}; cf_key=${key}`;
    const getBookings = async () => {
      const res = makeRes();
      await bookingsHandler(makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie } }), res);
      return res;
    };

    const mkRow = (n) => [
      `2026-11-25 09:0${n % 10}:00`, 'psid_x', `Patient ${n}`, '09171234567',
      'Cleaning', `Nov ${n} 2pm`, '', 'CONFIRMED', 'evt', '',
    ];
    global.__leadRows = Array.from({ length: 12 }, (_, i) => mkRow(i + 1));
    let res = await getBookings();
    assertEq(res.statusCode, 200, 'bookings ok status');
    assertEq(res.body.status, 'ok', 'bookings status ok');
    assertEq(res.body.bookings.length, 10, 'capped at 10 rows');
    assertEq(res.body.bookings[0].patient_name, 'Patient 12', 'newest row first');
    assertEq(res.body.bookings[9].patient_name, 'Patient 3', 'tenth row is the third oldest kept');
    assertEq(res.body.bookings[0].status, 'CONFIRMED', 'status column mapped');

    global.__leadRows = [];
    res = await getBookings();
    assertEq(res.body.status, 'ok', 'empty sheet still ok');
    assertEq(res.body.bookings.length, 0, 'empty sheet returns no rows');

    // Expire the stored token again so the next read must attempt a refresh.
    const freshGoogle = await clinicStore.getClinicSection(store, clinicId, 'google');
    await clinicStore.saveClinicSection(store, clinicId, 'google', { ...freshGoogle, accessToken: null, expiresAt: 0 });
    googleTokenBehavior = { mode: 'fail' };
    global.__leadRows = [mkRow(1)];
    res = await getBookings();
    assertEq(res.body.status, 'google_unavailable', 'refresh failure is an honest state');
    assertEq(res.body.bookings.length, 0, 'no invented rows on failure');
    googleTokenBehavior = { mode: 'ok' };

    const noSheet = await seedClinic();
    await clinicStore.saveClinicSection(store, noSheet.clinicId, 'google', {
      email: 'clinic.owner@example.com',
      googleSub: 'sub_owner_1',
      accessToken: 'tok',
      refreshToken: 'mock_refresh',
      expiresAt: Date.now() + 3600 * 1000,
      spreadsheetId: null,
      spreadsheetUrl: null,
      calendarId: 'primary',
      connectedAt: new Date().toISOString(),
    });
    res = makeRes();
    await bookingsHandler(
      makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${noSheet.clinicId}; cf_key=${noSheet.key}` } }),
      res
    );
    assertEq(res.body.status, 'no_sheet', 'bound clinic without sheet reports no_sheet');
  });

  // 19. FAQ cap: 250 rows -> at most 100 items + truncation note
  await test('faq cap: 250 sheet rows truncated to 100 with note', async () => {
    global.__faqRows = Array.from({ length: 250 }, (_, i) => ['Service ' + i, '100', '30', '']);
    const data = await google.loadFaqPrices('tok', 'sheet_x');
    assert(data.items.length <= 100, 'items capped at 100, got ' + data.items.length);
    assert(data.truncated === true, 'truncated flag set');
    assert(data.formattedText.includes('truncated'), 'truncation note in prompt text');
  });

  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('Harness crashed:', err);
  process.exitCode = 1;
});
