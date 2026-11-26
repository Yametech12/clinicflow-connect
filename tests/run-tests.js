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
process.env.FIREBASE_PROJECT_ID = 'clinicflow-test-project';
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
const connectGoogle = require('../api/connect/google');
const connectFacebook = require('../api/connect/facebook');
const callbackGoogle = require('../api/callback/google');
const callbackFacebook = require('../api/callback/facebook');
const logoutHandler = require('../api/logout');
const bookingsHandler = require('../api/bookings');
const firebaseAuth = require('../api/_firebase');
const firebaseBridge = require('../api/auth/firebase');

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
  if (u.includes('graph.facebook.com') && u.includes('/oauth/access_token')) {
    return jsonResponse(200, { access_token: 'mock_fb_user_token', token_type: 'bearer', expires_in: 5184000 });
  }
  if (u.includes('graph.facebook.com') && u.includes('/me/accounts')) {
    return jsonResponse(200, {
      data: [
        { id: 'page_2001', name: 'Clinic Page One', access_token: 'pat_one' },
        { id: 'page_2002', name: 'Clinic Page Two', access_token: 'pat_two' },
      ],
    });
  }
  if (u.includes('graph.facebook.com') && u.includes('/subscribed_apps')) {
    return jsonResponse(200, { success: true });
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
    if (userinfoBehavior.mode === 'fail') {
      return jsonResponse(500, { error: { message: 'mock userinfo failure' } });
    }
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
  await test('clinic identity: query-string id ignored, POST needs cf_key', async () => {
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

  });

  // 16b. GT-136 A3: GET /api/clinic never binds a key on a read path
  await test('clinic GET never binds a key: legacy record stays unbound, fields redacted', async () => {
    const legacyId = session.createClinicId();
    await store.put(`clinic:${legacyId}`, {
      profile: { name: 'V1 Clinic', address: '', hours: '', timezone: 'Asia/Manila' },
      google: { email: 'v1@example.com', spreadsheetId: 'sheet_v1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_v1' },
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
    });
    const res = makeRes();
    await clinicHandler(
      makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${legacyId}` } }),
      res
    );
    assertEq(res.body.authenticated, false, 'legacy id-only session is not authenticated');
    assertEq(res.body.connections.google.email, null, 'legacy clinic email stays redacted on GET');
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie || '');
    assert(!cookieStr.includes('cf_key='), 'no cf_key cookie issued by a GET');
    const meta = await clinicStore.getClinicSection(store, legacyId, 'meta');
    assert(!meta || !meta.keyHash, 'record still has no keyHash after GET (binding is callbacks-only)');
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
    assertEq(res.body.authenticated, false, 'authenticated mirrors logged_in when unbound');
    assertEq(res.body.connections.google.bound, false, 'bound flag false');

    // Bind the sub -> logged in everywhere
    const googleSection = await clinicStore.getClinicSection(store, clinicId, 'google');
    await clinicStore.saveClinicSection(store, clinicId, 'google', { ...googleSection, googleSub: 'sub_owner_1' });
    res = makeRes();
    await clinicHandler(makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie } }), res);
    assertEq(res.body.logged_in, true, 'bound clinic logged_in true');
    assertEq(res.body.authenticated, true, 'authenticated mirrors logged_in when bound');
    assertEq(res.body.connections.google.bound, true, 'bound flag true');
  });

  // 23. GT-135 + GT-136 A4: logout clears cookies, redirects, and rotates the key server-side
  await test('logout: clears cookies, redirects, old key pair dies server-side', async () => {
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

    // Rotation: a bound clinic logs out (POST also accepted); the captured
    // cookie pair must stop working everywhere afterwards.
    const { clinicId, key } = await seedClinic({ withGoogle: true });
    const g = await clinicStore.getClinicSection(store, clinicId, 'google');
    await clinicStore.saveClinicSection(store, clinicId, 'google', { ...g, googleSub: 'sub_owner_1' });
    const pair = `cf_clinic=${clinicId}; cf_key=${key}`;
    const hashBefore = (await clinicStore.getClinicSection(store, clinicId, 'meta')).keyHash;
    const loRes = makeRes();
    await logoutHandler(
      makeReq({ method: 'POST', headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: pair } }),
      loRes
    );
    assertEq(loRes.statusCode, 302, 'POST logout redirects');
    const metaAfter = await clinicStore.getClinicSection(store, clinicId, 'meta');
    assert(metaAfter.keyHash && metaAfter.keyHash !== hashBefore, 'keyHash rotated on logout');
    const postRes = makeRes();
    await clinicHandler(
      makeReq({ method: 'POST', headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: pair }, body: { name: 'Nope' } }),
      postRes
    );
    assertEq(postRes.statusCode, 403, 'old key pair cannot save after logout');
    const bkRes = makeRes();
    await bookingsHandler(
      makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: pair } }),
      bkRes
    );
    assertEq(bkRes.statusCode, 401, 'old key pair cannot read bookings after logout');
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

  // 25. GT-136 A1: id-only cookie gets 403 from all three connect endpoints
  await test('connect gate: id-only cookie -> 403 on google, facebook, telegram connect', async () => {
    const { clinicId, key } = await seedClinic();
    const idOnly = { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${clinicId}` };
    let res = makeRes();
    await connectGoogle(makeReq({ headers: idOnly }), res);
    assertEq(res.statusCode, 403, 'google connect id-only 403');
    assertEq(res.body.code, 'INVALID_SESSION', 'google connect code');
    res = makeRes();
    await connectFacebook(makeReq({ headers: idOnly }), res);
    assertEq(res.statusCode, 403, 'facebook connect id-only 403');
    assertEq(res.body.code, 'INVALID_SESSION', 'facebook connect code');
    res = makeRes();
    await connectTelegram(makeReq({ headers: idOnly }), res);
    assertEq(res.statusCode, 403, 'telegram connect id-only 403');
    assert(![...adapter.map.keys()].some((k) => k.startsWith('tg_code:')), 'no linking code minted for id-only session');
    // The full pair still works.
    res = makeRes();
    await connectGoogle(
      makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${clinicId}; cf_key=${key}` } }),
      res
    );
    assertEq(res.body.status, 'ready', 'valid key pair still gets the OAuth URL');
  });

  // 26. GT-136 A2: bookings requires cf_key proof on a bound clinic
  await test('bookings gate: bound clinic with id-only or wrong-key cookie -> 401', async () => {
    const { clinicId, key } = await seedClinic({ withGoogle: true });
    const g = await clinicStore.getClinicSection(store, clinicId, 'google');
    await clinicStore.saveClinicSection(store, clinicId, 'google', { ...g, googleSub: 'sub_owner_1' });
    let res = makeRes();
    await bookingsHandler(
      makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${clinicId}` } }),
      res
    );
    assertEq(res.statusCode, 401, 'id-only cookie gets 401');
    res = makeRes();
    await bookingsHandler(
      makeReq({
        headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${clinicId}; cf_key=${session.createClinicKey()}` },
      }),
      res
    );
    assertEq(res.statusCode, 401, 'wrong key gets 401');
    res = makeRes();
    await bookingsHandler(
      makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${clinicId}; cf_key=${key}` } }),
      res
    );
    assertEq(res.statusCode, 200, 'valid key pair reads bookings');
  });

  // 27. GT-136 A5: adoption never moves the facebook section; profile/telegram still carry
  await test('adoption: facebook section stays with source clinic, profile and telegram carry over', async () => {
    userinfoBehavior.sub = 'sub_adopter';
    const clinicA = session.createClinicId();
    const keyA = session.createClinicKey();
    await clinicStore.saveClinicSection(store, clinicA, 'meta', {
      clinicId: clinicA, keyHash: session.hashClinicKey(keyA),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await clinicStore.saveClinicSection(store, clinicA, 'google', {
      email: 'clinic.owner@example.com', googleSub: 'sub_adopter',
      accessToken: 'old_access', refreshToken: 'mock_refresh', expiresAt: 0,
      spreadsheetId: 'sheet_A', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_A',
      calendarId: 'primary', connectedAt: new Date().toISOString(),
    });
    await clinicStore.bindGoogleSub(store, 'sub_adopter', clinicA);

    const clinicB = session.createClinicId();
    await clinicStore.saveClinicSection(store, clinicB, 'profile', {
      name: 'Browser Clinic', address: 'Somewhere', hours: '9-5', timezone: 'Asia/Manila',
    });
    await clinicStore.saveClinicSection(store, clinicB, 'facebook', {
      pageId: 'page_B', pageName: 'Browser Page', pageAccessToken: 'tok_B',
      subscribed: true, connectedAt: new Date().toISOString(),
    });
    await store.put('fb_page:page_B', { clinicId: clinicB });
    await clinicStore.saveClinicSection(store, clinicB, 'telegram', {
      chatId: '555000', username: 'owner', firstName: 'Owner', linkedAt: new Date().toISOString(),
    });

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
    const aFacebook = await clinicStore.getClinicSection(store, clinicA, 'facebook');
    assertEq(aFacebook, null, 'adopted record did NOT gain the facebook section');
    const fbIndex = await store.get('fb_page:page_B');
    assertEq(fbIndex.clinicId, clinicB, 'fb_page index still routes to the source clinic');
    const aProfile = await clinicStore.getClinicSection(store, clinicA, 'profile');
    assertEq(aProfile.name, 'Browser Clinic', 'profile carry-over still works for unbound source');
    const aTelegram = await clinicStore.getClinicSection(store, clinicA, 'telegram');
    assertEq(aTelegram.chatId, '555000', 'telegram carry-over still works for unbound source');
  });

  // 28. GT-136 A5: carry-over skipped entirely when the source clinic is bound to another account
  await test('adoption: carry-over skipped when source clinic is bound to a different Google account', async () => {
    userinfoBehavior.sub = 'sub_adopter2';
    const clinicA = session.createClinicId();
    await clinicStore.saveClinicSection(store, clinicA, 'google', {
      email: 'a@example.com', googleSub: 'sub_adopter2',
      accessToken: 'old_access', refreshToken: 'mock_refresh', expiresAt: 0,
      spreadsheetId: 'sheet_A2', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_A2',
      calendarId: 'primary', connectedAt: new Date().toISOString(),
    });
    await clinicStore.bindGoogleSub(store, 'sub_adopter2', clinicA);

    const clinicB = session.createClinicId();
    await clinicStore.saveClinicSection(store, clinicB, 'google', {
      email: 'b@example.com', googleSub: 'sub_someone_else',
      accessToken: 'tok_b', refreshToken: 'ref_b', expiresAt: 0,
      spreadsheetId: 'sheet_B2', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_B2',
      calendarId: 'primary', connectedAt: new Date().toISOString(),
    });
    await clinicStore.saveClinicSection(store, clinicB, 'profile', {
      name: 'Other Clinic', address: '', hours: '', timezone: 'Asia/Manila',
    });

    const state = session.signState(clinicB, 'google', process.env.GOOGLE_CLIENT_SECRET);
    const res = makeRes();
    await callbackGoogle(
      makeReq({
        query: { code: 'mock_code', state },
        headers: {
          accept: 'text/html', host: 'clinicflow-connect-two.vercel.app', 'x-forwarded-proto': 'https',
          cookie: `cf_clinic=${clinicB}; cf_key=${session.createClinicKey()}`,
        },
      }),
      res
    );
    // Adoption itself is legitimate (the signer proved control of the
    // account that owns clinic A), but because the source clinic is bound
    // to a different Google account, carry-over is skipped entirely.
    assertEq(res.statusCode, 302, 'adoption proceeds for the account owner');
    const aProfile = await clinicStore.getClinicSection(store, clinicA, 'profile');
    assertEq(aProfile, null, 'nothing carried into the adopted record');
    const bProfile = await clinicStore.getClinicSection(store, clinicB, 'profile');
    assertEq(bProfile.name, 'Other Clinic', 'source clinic record untouched');
  });

  // 29. GT-136 A8: Google account switch clears the stored spreadsheet pointer
  await test('google account switch: spreadsheetId cleared and re-provisioned under the new account', async () => {
    const { clinicId, key } = await seedClinic();
    await clinicStore.saveClinicSection(store, clinicId, 'google', {
      email: 'old@example.com', googleSub: 'sub_old_account',
      accessToken: 'old_access', refreshToken: 'mock_refresh', expiresAt: 0,
      spreadsheetId: 'sheet_old', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_old',
      calendarId: 'primary', connectedAt: new Date().toISOString(),
    });
    await clinicStore.bindGoogleSub(store, 'sub_old_account', clinicId);
    userinfoBehavior = { sub: 'sub_new_account', email: 'new@example.com' };
    const state = session.signState(clinicId, 'google', process.env.GOOGLE_CLIENT_SECRET);
    const res = makeRes();
    await callbackGoogle(
      makeReq({
        query: { code: 'mock_code', state },
        headers: {
          accept: 'text/html', host: 'clinicflow-connect-two.vercel.app', 'x-forwarded-proto': 'https',
          cookie: `cf_clinic=${clinicId}; cf_key=${key}`,
        },
      }),
      res
    );
    assertEq(res.statusCode, 302, 'account switch callback redirects');
    const g = await clinicStore.getClinicSection(store, clinicId, 'google');
    assertEq(g.googleSub, 'sub_new_account', 'record now bound to the new account');
    assertEq(g.email, 'new@example.com', 'email updated to the new account');
    assertEq(g.spreadsheetId, 'sheet_created_1', 'fresh sheet provisioned under the new account');
    assertEq(await clinicStore.getClinicIdByGoogleSub(store, 'sub_old_account'), null, 'old sub index removed');
    assertEq(await clinicStore.getClinicIdByGoogleSub(store, 'sub_new_account'), clinicId, 'new sub index points at the clinic');
  });

  // 30. GT-136 A8: userinfo failure surfaces an error and stores nothing
  await test('google callback: userinfo failure -> error page, no tokens stored, no binding', async () => {
    userinfoBehavior = { mode: 'fail', sub: null, email: null };
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
    assertEq(res.statusCode, 500, 'userinfo failure is an error, not a silent success');
    assert(String(res.body).includes('Google connection failed'), 'deck error page rendered');
    const g = await clinicStore.getClinicSection(store, clinicId, 'google');
    assertEq(g, null, 'no google section stored when identity is unknown');
  });

  // 31. GT-136 A6: Facebook Page selection is POST-only and session-bound
  await test('facebook selection: GET cannot complete, wrong session POST refused, owner POST connects', async () => {
    const { clinicId, key } = await seedClinic();
    const pair = `cf_clinic=${clinicId}; cf_key=${key}`;
    const state = session.signState(clinicId, 'facebook', process.env.META_APP_SECRET);
    let res = makeRes();
    await callbackFacebook(
      makeReq({
        query: { code: 'mock_code', state },
        headers: { accept: 'text/html', host: 'x.example', 'x-forwarded-proto': 'https', cookie: pair },
      }),
      res
    );
    assertEq(res.statusCode, 200, 'picker page renders');
    const m = String(res.body).match(/name="selection_token" value="([^"]+)"/);
    assert(m, 'selection token present in picker form');
    const token = m[1];

    // GET with the token in the URL must NOT complete the connection.
    res = makeRes();
    await callbackFacebook(
      makeReq({
        query: { selection_token: token, page_id: 'page_2001' },
        headers: { accept: 'text/html', host: 'x.example', 'x-forwarded-proto': 'https', cookie: pair },
      }),
      res
    );
    assertEq(res.statusCode, 400, 'GET completion refused');
    assertEq(await clinicStore.getClinicSection(store, clinicId, 'facebook') && (await clinicStore.getClinicSection(store, clinicId, 'facebook')).pageId, 'page_1001', 'facebook section untouched by GET attempt');

    // POST from a different session is refused.
    const other = await seedClinic();
    res = makeRes();
    await callbackFacebook(
      makeReq({
        method: 'POST',
        headers: {
          accept: 'text/html', host: 'x.example', 'x-forwarded-proto': 'https',
          cookie: `cf_clinic=${other.clinicId}; cf_key=${other.key}`,
        },
        body: { selection_token: token, page_id: 'page_2001' },
      }),
      res
    );
    assertEq(res.statusCode, 403, 'foreign session POST refused');

    // POST from the initiating session connects.
    res = makeRes();
    await callbackFacebook(
      makeReq({
        method: 'POST',
        headers: { accept: 'text/html', host: 'x.example', 'x-forwarded-proto': 'https', cookie: pair },
        body: { selection_token: token, page_id: 'page_2001' },
      }),
      res
    );
    assertEq(res.statusCode, 302, 'owner POST redirects');
    assertEq(res.headers.location, '/dashboard?connected=facebook', 'redirect to dashboard');
    const fb = await clinicStore.getClinicSection(store, clinicId, 'facebook');
    assertEq(fb.pageId, 'page_2001', 'chosen page stored');
    const idx = await store.get('fb_page:page_2001');
    assertEq(idx.clinicId, clinicId, 'fb_page index points at the clinic');
  });

  // 32. GT-136 A7: bookings read range is bounded
  await test('bookings read: outbound range capped, 5000-row sheet returns newest 10', async () => {
    const { clinicId, key } = await seedClinic({ withGoogle: true });
    const g = await clinicStore.getClinicSection(store, clinicId, 'google');
    await clinicStore.saveClinicSection(store, clinicId, 'google', { ...g, googleSub: 'sub_owner_1' });
    const mkRow = (n) => [
      '2026-11-25 09:00:00', 'psid_x', `Patient ${n}`, '09171234567',
      'Cleaning', 'Nov 26 2pm', '', 'CONFIRMED', 'evt', '',
    ];
    global.__leadRows = Array.from({ length: 5000 }, (_, i) => mkRow(i + 1));
    const res = makeRes();
    await bookingsHandler(
      makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${clinicId}; cf_key=${key}` } }),
      res
    );
    assertEq(res.body.status, 'ok', 'bookings ok');
    assertEq(res.body.bookings.length, 10, 'still capped at 10 rows');
    assertEq(res.body.bookings[0].patient_name, 'Patient 5000', 'newest row first');
    const readCall = fetchLog.find((c) => c.url.includes('Leads_Bookings') && c.url.includes('/values/'));
    assert(readCall, 'sheet read happened');
    assert(decodeURIComponent(readCall.url).includes('Leads_Bookings!A2:J5001'), 'range bounded at row 5001, got: ' + readCall.url);
  });

  // 19. FAQ cap: 250 rows -> at most 100 items + truncation note
  await test('faq cap: 250 sheet rows truncated to 100 with note', async () => {
    global.__faqRows = Array.from({ length: 250 }, (_, i) => ['Service ' + i, '100', '30', '']);
    const data = await google.loadFaqPrices('tok', 'sheet_x');
    assert(data.items.length <= 100, 'items capped at 100, got ' + data.items.length);
    assert(data.truncated === true, 'truncated flag set');
    assert(data.formattedText.includes('truncated'), 'truncation note in prompt text');
  });

  // 20. GT-137 design gate: no side accent stripes in the shipped pages.
  // border-left wider than 1px is banned in index.html and dashboard.html
  // (1px hairline column rules inside ledger-style layouts stay allowed).
  await test('design gate: no border-left wider than 1px in index.html or dashboard.html', async () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['index.html', 'dashboard.html']) {
      const css = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const hits = css.match(/border-left\s*:\s*(?:[2-9]|\d{2,})px/g) || [];
      assertEq(hits.length, 0, file + ' has side accent stripes: ' + hits.join(', '));
    }
  });

  // 21. GT-138: branded 404 page ships at the repo root, links home, and
  // carries no em dash character.
  await test('branded 404: 404.html exists, links to /, no em dash', async () => {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, '..', '404.html');
    assert(fs.existsSync(file), '404.html exists at repo root');
    const html = fs.readFileSync(file, 'utf8');
    assert(/href="\/"/.test(html), '404.html contains a link to /');
    assert(!html.includes('\u2014'), '404.html contains no em dash character');
  });

  // 22. GT-138: icon declarations are not duplicated. Each page carries
  // exactly one SVG icon link pointing at /favicon.svg and no data URI
  // icon link.
  await test('icon declarations: one /favicon.svg link per page, no data URI icon', async () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['index.html', 'dashboard.html']) {
      const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const svgIcons = html.match(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/g) || [];
      assertEq(svgIcons.length, 1, file + ' has exactly one /favicon.svg icon link');
      assert(!html.includes('href="data:image/svg+xml'), file + ' has no data URI icon link');
    }
  });

  // 23. GT-139 FL139-01: numbering unification gate. Profile is Step 1,
  // cards are Steps 2 to 4, welcome points at Step 2.
  await test('numbering gate FL139-01: STEP 1 in profile, STEP 2/3/4 in cards, welcome Step 2', async () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
    const count = (s) => (html.match(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assertEq(count('STEP 1'), 1, 'STEP 1 appears exactly once');
    const profileSection = html.slice(html.indexOf('<section id="profile">'), html.indexOf('<section id="connect">'));
    assert(profileSection.includes('<div class="stepnum">STEP 1</div>'), 'STEP 1 sits inside section#profile');
    const fb = html.slice(html.indexOf('id="card-facebook"'), html.indexOf('id="card-google"'));
    assert(fb.includes('<div class="stepnum">STEP 2</div>'), 'STEP 2 in #card-facebook');
    const gg = html.slice(html.indexOf('id="card-google"'), html.indexOf('id="card-telegram"'));
    assert(gg.includes('<div class="stepnum">STEP 3</div>'), 'STEP 3 in #card-google');
    const tg = html.slice(html.indexOf('id="card-telegram"'), html.indexOf('<section id="pilot">'));
    assert(tg.includes('<div class="stepnum">STEP 4</div>'), 'STEP 4 in #card-telegram');
    assert(html.includes('Start with Step 2 on the Facebook card'), 'welcome contains the Step 2 pointer');
    assert(html.includes('Four steps turn your bot on: save your clinic profile'), 'welcome order wording per lead AE-2 decision');
    assert(html.includes('>1 Profile<') && html.includes('>2 Facebook<') && html.includes('>3 Google<') && html.includes('>4 Telegram<'), 'numbered segment labels present');
    assert(html.includes('connCount === 3 && profileDone'), 'AE-3 welcome hide condition requires profileDone');
  });

  // 24. GT-139 FL139-02: stamp unification gate.
  await test('stamp gate FL139-02: pills and summary are unfilled stamps, live summary border', async () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
    assert(html.includes('background:transparent;border:1px solid var(--muted);color:var(--muted)'), 'base pill is a muted stamp');
    assert(html.includes('.pill.pending{background:transparent;border-color:var(--amber);color:var(--amber)}'), 'pending pill stamp');
    assert(html.includes('.pill.ready{background:transparent;border-color:var(--ink);color:var(--ink)}'), 'ready pill stamp');
    assert(html.includes('.pill.linked{background:transparent;border-color:var(--green);color:var(--green)}'), 'linked pill stamp');
    assert(html.includes('border:1px solid var(--status-muted);'), 'summary bordered in status-muted');
    assert(html.includes('.status-summary.live{border-color:var(--green)}'), 'live summary rule present');
    assert(html.includes("summaryEl.className = 'status-summary show live'"), 'all connected state adds live class');
    assert(!/\.pill[^{]*\{[^}]*var\(--green-bg\)/.test(html), 'pill no longer consumes green-bg fill');
  });

  // 25. GT-139 FL139-04: improvement moves 1 to 4 gate.
  await test('improvement gate FL139-04: hero demo up 18px, teal demo buttons, demo anchor, next-action strings', async () => {
    const fs = require('fs');
    const path = require('path');
    const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const dash = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
    assert(idx.includes('.hero{padding:32px 0 24px'), 'hero padding tightened');
    assert(idx.includes('margin-top:12px;border:1px solid var(--line);border-top:2px solid var(--rule);background:var(--card)'), 'demo panel margin 12px');
    assert(idx.includes('.demo-panel button.savebtn{background:var(--teal);color:var(--btn-text)}'), 'demo buttons teal');
    assert(idx.includes('.demo-panel button.savebtn:hover,.demo-panel button.savebtn:active{background:var(--teal-dark)}'), 'demo buttons teal hover');
    assert(idx.includes('<a class="demo-jump" href="#demo">See the demo</a>'), 'See the demo anchor present');
    assert(idx.includes('.demo-jump:focus-visible{outline:2px solid var(--teal);outline-offset:2px}'), 'demo anchor focus rule');
    assert(dash.includes('<div class="next-action" id="nextAction" role="status"></div>'), 'next-action element present');
    assert(dash.includes('.next-action:empty{display:none}'), 'empty next-action hidden');
    for (const s of [
      'Next step: Step 1, save your clinic profile.',
      'Next step: Step 2, connect Facebook.',
      'Next step: Step 3, connect Google.',
      'Next step: Step 4, link Telegram.',
      'All four steps done. Your bot is live.',
    ]) {
      assert(dash.includes(s), 'next-action string present: ' + s);
    }
  });

  // 26. GT-139 FL139-05: 360px progress bar gate (static shape; rendered
  // acceptance measured by the builder and re-measured by Fresh-Eye).
  await test('progress bar gate FL139-05: narrow-width wrap rule present, anchors keep 44px rule', async () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
    assert(html.includes('@media (max-width:480px)'), '480px breakpoint present');
    const block = html.slice(html.indexOf('@media (max-width:480px)'));
    assert(block.includes('.progress-inner{flex-wrap:wrap}'), 'count wraps to its own line');
    assert(block.includes('.progress-segments{min-width:0;flex:1 1 100%'), 'segments take the full row and can shrink');
    assert(html.includes('a.seg{text-decoration:none;cursor:pointer;min-height:44px'), 'segment anchors keep the 44px rule');
  });

  // 27. GT-139 FL139-06: method discipline on connect routes and health.
  await test('method discipline FL139-06: non-GET on facebook/google/telegram connect and health -> 405', async () => {
    for (const [name, handler] of [['facebook', connectFacebook], ['google', connectGoogle], ['telegram', connectTelegram]]) {
      for (const method of ['POST', 'DELETE', 'PUT']) {
        const res = makeRes();
        await handler(makeReq({ method, headers: { host: 'x.example', 'x-forwarded-proto': 'https' } }), res);
        assertEq(res.statusCode, 405, name + ' connect ' + method + ' is 405');
        assertEq(res.body.status, 'method_not_allowed', name + ' connect ' + method + ' body');
      }
    }
    for (const method of ['POST', 'DELETE']) {
      const res = makeRes();
      healthHandler(makeReq({ method, headers: {} }), res);
      assertEq(res.statusCode, 405, 'health ' + method + ' is 405');
    }
    const okRes = makeRes();
    healthHandler(makeReq({ method: 'GET', headers: {} }), okRes);
    assertEq(okRes.statusCode, 200, 'health GET still works');
  });

  // 28. GT-139 FL139-07: unknown clinic id rotates to a fresh session.
  await test('session rotation FL139-07: GET with nonexistent clinic cookie issues a fresh server session', async () => {
    const ghostId = 'cln_DOESNOTEXIST99';
    const res = makeRes();
    await clinicHandler(
      makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${ghostId}` } }),
      res
    );
    assertEq(res.statusCode, 200, 'rotation response ok');
    assert(res.body.clinic_id !== ghostId, 'caller-supplied id not echoed');
    assertEq(res.body.session_issued, true, 'session_issued true after rotation');
    assertEq(res.body.logged_in, false, 'rotated session is logged out');
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie || '');
    assert(cookieStr.includes(`cf_clinic=${res.body.clinic_id}`), 'new clinic cookie issued');
    assert(cookieStr.includes('cf_key='), 'new key cookie issued');
    const meta = await clinicStore.getClinicSection(store, res.body.clinic_id, 'meta');
    assert(meta && meta.keyHash, 'rotated session record exists server-side');
    // A second read with the rotated pair is stable (no second rotation).
    const issuedKey = decodeURIComponent(cookieStr.match(/cf_key=([^;]+)/)[1]);
    const res2 = makeRes();
    await clinicHandler(
      makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: `cf_clinic=${res.body.clinic_id}; cf_key=${issuedKey}` } }),
      res2
    );
    assertEq(res2.body.clinic_id, res.body.clinic_id, 'rotated session is stable on re-read');
    assertEq(res2.body.session_issued, false, 'no second rotation');
  });

  // 29. GT-139 FL139-08: Firebase ID token verification (hand-rolled).
  await test('firebase verify FL139-08: valid token passes, expired/wrong-audience/bad-signature rejected', async () => {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
    firebaseAuth._setCertFetcherForTests(async () => ({ testkid: publicPem }));
    const projectId = 'clinicflow-test-project';
    const mint = (overrides = {}) => {
      const now = Math.floor(Date.now() / 1000);
      const header = { alg: 'RS256', kid: 'testkid', typ: 'JWT' };
      const payload = {
        iss: `https://securetoken.google.com/${projectId}`,
        aud: projectId,
        sub: 'uid_test_1',
        iat: now - 10,
        exp: now + 3600,
        email: 'firebase.owner@example.com',
        firebase: { identities: { 'google.com': ['sub_fb_1'] }, sign_in_provider: 'google.com' },
        ...overrides,
      };
      const enc = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
      const data = `${enc(header)}.${enc(payload)}`;
      const sig = crypto.sign('RSA-SHA256', Buffer.from(data, 'utf8'), pair.privateKey).toString('base64url');
      return `${data}.${sig}`;
    };
    const claims = await firebaseAuth.verifyFirebaseIdToken(mint());
    assertEq(claims.uid, 'uid_test_1', 'uid extracted');
    assertEq(claims.email, 'firebase.owner@example.com', 'email extracted');
    assertEq(claims.googleSub, 'sub_fb_1', 'google sub extracted from provider identities');

    let rejected = 0;
    for (const bad of [mint({ exp: Math.floor(Date.now() / 1000) - 60 }), mint({ aud: 'other-project' }), mint({ iss: 'https://securetoken.google.com/other-project' })]) {
      try { await firebaseAuth.verifyFirebaseIdToken(bad); } catch (e) { rejected += 1; }
    }
    assertEq(rejected, 3, 'expired, wrong audience, and wrong issuer all rejected');
    const good = mint();
    const tampered = good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    let tamperRejected = false;
    try { await firebaseAuth.verifyFirebaseIdToken(tampered); } catch (e) { tamperRejected = true; }
    assert(tamperRejected, 'tampered signature rejected');
    global.__mintFirebase = mint;
  });

  // 30. GT-139 FL139-08: bridge binds, adopts by Google sub, rejects bad tokens.
  await test('firebase bridge FL139-08: bind sets session contract, adoption by sub, bad token sets nothing', async () => {
    const mint = global.__mintFirebase;
    assert(mint, 'firebase mint helper available');
    const postBridge = async (token, cookie) => {
      const res = makeRes();
      await firebaseBridge(
        makeReq({
          method: 'POST',
          headers: { host: 'x.example', 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}) },
          body: { id_token: token },
        }),
        res
      );
      return res;
    };

    // Method discipline on the bridge itself.
    const getRes = makeRes();
    await firebaseBridge(makeReq({ method: 'GET', headers: {} }), getRes);
    assertEq(getRes.statusCode, 405, 'bridge GET is 405');

    // Bad token: 401, no cookies, no auth section anywhere new.
    const badRes = await postBridge('not-a-token', null);
    assertEq(badRes.statusCode, 401, 'bad token rejected');
    assertEq(badRes.headers['set-cookie'], undefined, 'bad token sets no cookies');

    // Bind: a fresh anonymous session binds the uid to its own clinic.
    const bindRes = await postBridge(mint(), null);
    assertEq(bindRes.statusCode, 200, 'bind ok');
    assertEq(bindRes.body.status, 'signed_in', 'bind status');
    assertEq(bindRes.body.logged_in, true, 'bind logged_in true');
    assertEq(bindRes.body.authenticated, true, 'bind authenticated true');
    const boundId = bindRes.body.clinic_id;
    const authSection = await clinicStore.getClinicSection(store, boundId, 'auth');
    assertEq(authSection.firebaseUid, 'uid_test_1', 'auth section stored');
    assertEq(await clinicStore.getClinicIdByFirebaseUid(store, 'uid_test_1'), boundId, 'uid index resolves');

    // Contract: GET /api/clinic with the issued pair reports logged in,
    // with the same field names as before the migration.
    const bindCookies = bindRes.headers['set-cookie'];
    const bindCookieStr = Array.isArray(bindCookies) ? bindCookies.join(';') : String(bindCookies || '');
    const pairCookie = bindCookieStr.split(';').filter((p) => p.includes('cf_clinic=') || p.includes('cf_key=')).map((p) => p.split(';')[0].trim()).join('; ');
    const clinicRes = makeRes();
    await clinicHandler(makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https', cookie: pairCookie } }), clinicRes);
    assertEq(clinicRes.body.logged_in, true, 'clinic logged_in via firebase binding');
    assertEq(clinicRes.body.authenticated, true, 'clinic authenticated mirrors logged_in');
    assertEq(clinicRes.body.connections.google.bound, true, 'bound flag via auth binding');
    assertEq(clinicRes.body.connections.google.email, 'firebase.owner@example.com', 'email read from auth binding');
    for (const key of ['clinic_id', 'profile', 'connections', 'ready', 'storage_configured', 'session_issued']) {
      assert(key in clinicRes.body, 'clinic payload keeps field: ' + key);
    }

    // Adoption: a clinic already bound to the token's Google sub is
    // adopted by a different browser clinic, with a rotated key. Uses a
    // fresh uid and sub so the uid index from the bind case above does
    // not win resolution first (uid resolution is checked separately).
    const clinicA = session.createClinicId();
    await clinicStore.saveClinicSection(store, clinicA, 'google', {
      email: 'firebase.owner@example.com', googleSub: 'sub_fb_2',
      accessToken: 'tok_a', refreshToken: 'ref_a', expiresAt: 0,
      spreadsheetId: 'sheet_A', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_A',
      calendarId: 'primary', connectedAt: new Date().toISOString(),
    });
    await clinicStore.bindGoogleSub(store, 'sub_fb_2', clinicA);
    const clinicB = session.createClinicId();
    const keyB = session.createClinicKey();
    await clinicStore.saveClinicSection(store, clinicB, 'meta', {
      clinicId: clinicB, keyHash: session.hashClinicKey(keyB),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const adoptToken = mint({
      sub: 'uid_test_2',
      firebase: { identities: { 'google.com': ['sub_fb_2'] }, sign_in_provider: 'google.com' },
    });
    const adoptRes = await postBridge(adoptToken, `cf_clinic=${clinicB}; cf_key=${keyB}`);
    assertEq(adoptRes.body.clinic_id, clinicA, 'adoption lands on the sub-bound clinic');
    const adoptCookies = adoptRes.headers['set-cookie'];
    const adoptCookieStr = Array.isArray(adoptCookies) ? adoptCookies.join(';') : String(adoptCookies || '');
    assert(adoptCookieStr.includes(`cf_clinic=${clinicA}`), 'adoption cookie points at adopted clinic');
    const adoptedAuth = await clinicStore.getClinicSection(store, clinicA, 'auth');
    assertEq(adoptedAuth.firebaseUid, 'uid_test_2', 'uid recorded on adopted clinic');
  });

  // 31. GT-139 FL139-08: pages carry the provider flow; logged-out gate holds.
  await test('firebase pages FL139-08: login page renders provider flow, dashboard gated when logged out', async () => {
    const fs = require('fs');
    const path = require('path');
    const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert(idx.includes('/firebase-config.js'), 'landing loads the firebase config');
    assert(idx.includes("'/api/auth/firebase'") || idx.includes('/api/auth/firebase'), 'landing posts to the bridge');
    assert(idx.includes('signInWithRedirect'), 'landing uses the redirect flow');
    assert(idx.includes("fetchWithTimeout('/api/connect/google'"), 'legacy google flow kept as fallback while config is null');
    const dash = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
    assert(dash.includes('/firebase-config.js'), 'dashboard loads the firebase config');
    assert(dash.includes("clinic.logged_in !== true") || dash.includes('logged_in'), 'dashboard gate still keys off logged_in');
    const cfg = fs.readFileSync(path.join(__dirname, '..', 'firebase-config.js'), 'utf8');
    assert(!cfg.includes('window.CF_FIREBASE_CONFIG = null'), 'config placeholder replaced by the real config (GT-140 S5b)');
    assert(cfg.includes('projectId: "clinicflow-connect-515810"'), 'config carries the ClinicFlow project id');
    assert(cfg.includes('authDomain: "clinicflow-connect-515810.firebaseapp.com"'), 'config carries the project auth domain');
    assert(cfg.includes('apiKey: "AIzaSyDfmZBYNlKkQUaXM5yOo-Ds9F5yx5ai_fE"'), 'config carries the web app api key (public identifier)');
    assertEq(firebaseAuth.getFirebaseProjectId(), 'clinicflow-test-project', 'env FIREBASE_PROJECT_ID keeps precedence over the fallback constant');
    const fbjs = fs.readFileSync(path.join(__dirname, '..', 'api', '_firebase.js'), 'utf8');
    assert(fbjs.includes("const DEFAULT_FIREBASE_PROJECT_ID = 'clinicflow-connect-515810';"), 'project id fallback constant present in _firebase.js');
    const vercel = fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8');
    assert(vercel.includes('frame-src https://apis.google.com https://clinicflow-connect-515810.firebaseapp.com'), 'CSP frame-src pinned to the single Firebase domain (F139-FE-2)');
    assert(!vercel.includes('*.firebaseapp.com'), 'CSP wildcard removed');
    // Logged-out dashboard contract: anonymous clinic read is logged out.
    const res = makeRes();
    await clinicHandler(makeReq({ headers: { host: 'x.example', 'x-forwarded-proto': 'https' } }), res);
    assertEq(res.body.logged_in, false, 'anonymous session logged_in false');
    assertEq(res.body.authenticated, false, 'anonymous session authenticated false');
  });


  // 32. GT-140 FL140-01: dashboard shell shows a single loading label.
  await test('loading label FL140-01: dashboard shell has one loading text, retry and redirect intact', async () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
    assert(!html.includes('Loading your dashboard'), 'duplicate loading label removed');
    assert(html.includes('<span class="pill checking">Loading</span>'), 'single Loading pill remains');
    assert(html.includes('id="shellRetry"'), 'timeout retry state still present');
    assert(html.includes("window.location.replace('/?login=1')"), 'logged out redirect still present');
  });

  // 33. GT-140 FL140-02: CTA labels unified with one named exception.
  await test('cta gate FL140-02: landing data-login buttons read Start a pilot except the return sign in banner', async () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const labels = [...html.matchAll(/<button[^>]*data-login[^>]*>([^<]+)<\/button>/g)].map((m) => m[1].trim());
    assertEq(labels.length, 5, 'five data-login buttons on the landing');
    assertEq(labels.filter((l) => l === 'Start a pilot').length, 4, 'four buttons read Start a pilot');
    assertEq(labels.filter((l) => l === 'Log in with Google').length, 1, 'one named exception keeps Log in with Google');
    const banner = html.slice(html.indexOf('id="loginBanner"'), html.indexOf('class="hero"'));
    assert(banner.includes('>Log in with Google</button>'), 'the exception is the login banner button');
    const header = html.slice(html.indexOf('<header class="top">'), html.indexOf('</header>'));
    assert(header.includes('>Start a pilot</button>'), 'header button reads Start a pilot');
  });

  // 34. GT-140 FL140-03: header lockup nowrap rules on all three pages.
  await test('header gate FL140-03: nowrap lockup, brand shrink 0, topnote hidden at 820, busy min-width', async () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['index.html', 'dashboard.html', '404.html']) {
      const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const head = html.slice(html.indexOf('header.top{'), html.indexOf('.brand{'));
      assert(head.includes('flex-wrap:nowrap'), file + ' header never wraps');
      assert(head.includes('gap:12px'), file + ' header gap 12px');
      assert(html.includes('white-space:nowrap;flex-shrink:0'), file + ' brand nowrap and shrink 0');
      assert(html.includes('.brand{font-size:20px}'), file + ' brand 20px at 560 and below');
    }
    const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert(idx.includes('.head-actions .topnote{display:none}'), 'landing topnote hidden at 820 and below');
    assert(idx.includes('button.loginbtn:disabled{min-width:132px}'), 'busy header button min-width 132px');
    assert(idx.includes('header.top button.loginbtn{padding:11px 16px}'), 'header login padding 16px');
    const dash = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
    assert(dash.includes('#signedInAs{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}'), 'signed in note truncates');
    assert(dash.includes('.head-actions .topnote{display:none}'), 'dashboard topnote hidden at 820 and below');
  });

  // 35. GT-140 FL140-04: Booked Tooth mark, icon set, manifest, stroke system.
  await test('icon gate FL140-04: Booked Tooth everywhere, old bubble gone, icon files at specced sizes', async () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..');
    const tooth = 'M21 9h22c6 0 11 4.6 11 11';
    const oldBubble = 'M8 10h16a2 2 0 0 1 2 2v8';
    for (const file of ['index.html', 'dashboard.html', '404.html', 'favicon.svg']) {
      const html = fs.readFileSync(path.join(root, file), 'utf8');
      assert(html.includes(tooth), file + ' carries the Booked Tooth path');
      assert(!html.includes(oldBubble), file + ' has no old bubble path');
    }
    for (const file of ['index.html', 'dashboard.html', '404.html']) {
      const html = fs.readFileSync(path.join(root, file), 'utf8');
      assert(html.includes('.brand-check{stroke:var(--teal)}'), file + ' brand-check rule present');
    }
    const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert(!idx.includes('stroke-width="3"'), 'no stroke width 3 icons remain on the landing');
    assertEq((idx.match(/stroke-width="2" stroke-linecap="round"/g) || []).length, 3, 'three trust checks at stroke width 2');
    const pngSize = (f) => {
      const b = fs.readFileSync(path.join(root, f));
      assertEq(b.toString('ascii', 1, 4), 'PNG', f + ' is a PNG');
      return [b.readUInt32BE(16), b.readUInt32BE(20)];
    };
    assertEq(JSON.stringify(pngSize('icon-192.png')), JSON.stringify([192, 192]), 'icon-192 is 192x192');
    assertEq(JSON.stringify(pngSize('icon-512.png')), JSON.stringify([512, 512]), 'icon-512 is 512x512');
    assertEq(JSON.stringify(pngSize('apple-touch-icon.png')), JSON.stringify([180, 180]), 'apple touch icon is 180x180');
    assertEq(JSON.stringify(pngSize('icon-maskable-512.png')), JSON.stringify([512, 512]), 'maskable icon is 512x512');
    const ico = fs.readFileSync(path.join(root, 'favicon.ico'));
    assertEq(ico.readUInt16LE(4), 3, 'ICO has exactly 3 entries');
    const icoSizes = [0, 1, 2].map((i) => ico[6 + i * 16]);
    assertEq(JSON.stringify(icoSizes), JSON.stringify([16, 32, 48]), 'ICO entries are 16, 32, 48');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
    const maskable = manifest.icons.filter((i) => i.purpose === 'maskable');
    assertEq(maskable.length, 1, 'one maskable manifest entry');
    assertEq(maskable[0].src, '/icon-maskable-512.png', 'maskable entry points at the padded file');
  });

  // 36. GT-140 FL140-05 + FL140-06 + FL140-07: demo dedup, toggle, staged reveal.
  await test('demo gate FL140-05/06/07: badge gone, toggle strings verbatim, three beat reveal with reset', async () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert(!html.includes('demo-badge'), 'demo badge element and rule removed');
    assertEq((html.match(/Sample demo with sample prices/g) || []).length, 1, 'sample prices sentence appears once');
    assert(html.includes('The bot answers in Tagalog or Bisaya, matching your patients.'), 'selling point sentence in the demo sub');
    assert(html.includes('<button type="button" class="langbtn" data-lang="bis" aria-pressed="true">Bisaya</button>'), 'Bisaya is the pressed default');
    assert(html.includes('<button type="button" class="langbtn" data-lang="tl" aria-pressed="false">Tagalog</button>'), 'Tagalog toggle present');
    for (const str of [
      'Magkano po ang cleaning?',
      'Ang dental cleaning namin ay {price} po',
      'Mag-book po ako bukas, 10 AM. Maria Clara, 0917 123 4567.',
      'Na-book na po kayo bukas, 10:00 AM',
      'New booking: Maria Clara, Dental Cleaning, tomorrow 10:00 AM.',
      'Pila ang cleaning?',
      'Hi! Ang among dental cleaning kay {price}. Kung gusto ka mag-book, palihug ipadala lang ang imong full name, mobile number, ug preferred schedule.',
      'Mag-book ko ugma, 10 AM. Maria Clara, 0917 123 4567.',
      'Salamat, Maria. Na-book na ka ugma, 10:00 AM, para sa dental cleaning. Na-save na ni sa booking sheet sa clinic.',
      'Bag-ong booking: Maria Clara, Dental Cleaning, ugma 10:00 AM.',
    ]) {
      assert(html.includes(str), 'demo string present: ' + str.slice(0, 40));
    }
    assert(html.includes("DEMO_STRINGS[demoLang].botPrice.replace('{price}', val)"), 'price reply rebuilt through renderDemoReply from the template');
    assert(html.includes('id="demoAlertText"'), 'alert line has a swappable span');
    assert(html.includes('Confirm the booking'), 'beat 1 relabel present');
    assert(html.includes('id="demoResetBtn"') && html.includes('Reset the demo'), 'reset control present');
    assert(html.includes('var demoBeat = 0;'), 'reveal keyed off one beat state variable');
  });

  // 37. GT-140 FL140-08 + FL140-09 + E-7: heading, timeline, deposit figure.
  await test('structure gate FL140-08/09: How it works heading, setup timeline both pages, peso deposit both pages', async () => {
    const fs = require('fs');
    const path = require('path');
    const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert(idx.includes('<h2 class="how-title">How it works</h2>'), 'How it works h2 present');
    assert(idx.indexOf('How it works') < idx.indexOf('class="howseq"'), 'heading sits before the flow');
    for (const file of ['index.html', 'dashboard.html']) {
      const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      assert(html.includes('class="setup-timeline'), file + ' has the setup timeline');
      for (const label of ['YOUR PART (ABOUT 15 MINUTES)', 'OUR PART (3 DAYS)', 'TOGETHER (LIVE WALKTHROUGH)']) {
        assert(html.includes(label), file + ' timeline label: ' + label);
      }
      assert(html.includes('<div class="pilot-deposit">₱2,750 deposit to start</div>'), file + ' priceblock states the peso deposit');
      assert(html.includes('50 percent deposit (₱2,750) by GCash, Maya, or InstaPay to start'), file + ' terms sentence carries the peso figure');
    }
    const dash = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
    assert(dash.includes('class="setup-timeline dash"'), 'dashboard timeline is the compact one column version');
    assert(dash.includes('Live walkthrough: you see the bot answer on your Page; the balance is due then.'), 'dashboard compact walkthrough sentence');
  });

  // 38. GT-140 FL140-10 + FL140-11: contact route, legal pages, footer links, no em dashes.
  await test('contact and legal gate FL140-10/11: mailto present, privacy and terms real practices, footer links, zero em dashes', async () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..');
    for (const file of ['index.html', 'dashboard.html']) {
      const html = fs.readFileSync(path.join(root, file), 'utf8');
      assert(html.includes('href="mailto:epimetheus.support@gmail.com"'), file + ' carries the contact mailto');
      assert(html.includes('href="/privacy"') && html.includes('href="/terms"'), file + ' footer links to both legal pages');
    }
    for (const file of ['privacy.html', 'terms.html']) {
      assert(fs.existsSync(path.join(root, file)), file + ' exists at repo root');
      const html = fs.readFileSync(path.join(root, file), 'utf8');
      assert(html.includes('href="/privacy"') && html.includes('href="/terms"'), file + ' cross links the legal pages');
      assert(!html.includes('\u2014'), file + ' has no em dash');
    }
    const privacy = fs.readFileSync(path.join(root, 'privacy.html'), 'utf8');
    for (const fact of ["clinic's own Google Sheet", "clinic's own Google Calendar", "clinic's own Telegram", "never sees or stores their passwords", 'Disconnect anytime']) {
      assert(privacy.includes(fact), 'privacy states the real practice: ' + fact);
    }
    const terms = fs.readFileSync(path.join(root, 'terms.html'), 'utf8');
    for (const fact of ['₱5,500 one time', '50 percent deposit (₱2,750)', 'Setup takes 3 days']) {
      assert(terms.includes(fact), 'terms states the published fact: ' + fact);
    }
    for (const file of ['index.html', 'dashboard.html', '404.html', 'privacy.html', 'terms.html']) {
      const html = fs.readFileSync(path.join(root, file), 'utf8');
      assert(!html.includes('\u2014'), file + ' has no em dash character');
      const hits = html.match(/border-left\s*:\s*(?:[2-9]|\d{2,})px/g) || [];
      assertEq(hits.length, 0, file + ' has no side accent stripes');
    }
  });

  // 39. GT-140 FL140-12: hero paragraph moved below the demo panel.
  await test('first screen gate FL140-12: third hero paragraph sits under the demo panel, hero keeps two ledes', async () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const hero = html.slice(html.indexOf('class="hero"'), html.indexOf('<section id="demo">'));
    assert(!hero.includes('Built for independent dental clinics'), 'moved paragraph is out of the hero');
    assert(html.indexOf('Built for independent dental clinics') > html.indexOf('id="demoPayoff"'), 'moved paragraph sits under the demo panel');
    assert(html.indexOf('Built for independent dental clinics') < html.indexOf('This sample shows three services'), 'moved paragraph precedes the demo note');
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
