// ClinicFlow Connect: Meta Messenger & Telegram bot webhook receiver.
// GET: Meta verification handshake against META_VERIFY_TOKEN.
// POST:
//   - Disables platform bodyParser to verify X-Hub-Signature-256 HMAC SHA256
//     over raw request bytes when META_APP_SECRET is set (fail closed 403).
//   - Parses JSON manually; unparseable signed/non-Meta payloads get a logged
//     200 (ignored) instead of a crash or 400 retry storm.
//   - Meta Messenger events (object === 'page'): runs the AI FAQ + booking pipeline.
//   - Telegram Bot updates (update_id / message.chat): verifies optional
//     TELEGRAM_WEBHOOK_SECRET and handles /start linking codes.
const crypto = require('crypto');
const store = require('./_store');
const { logServerError } = require('./_session');
const { processMessengerEvent, handleTelegramUpdate } = require('./_pipeline');

async function readRawBodyBuffer(req) {
  if (Buffer.isBuffer(req.rawBody)) {
    return req.rawBody;
  }
  if (typeof req.rawBody === 'string') {
    return Buffer.from(req.rawBody, 'utf8');
  }
  // If the platform already materialized the body (its JSON parser stayed
  // active), use it instead of consuming a possibly drained stream.
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
    if (typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      return Buffer.from(JSON.stringify(req.body), 'utf8');
    }
  }
  if (typeof req.on === 'function') {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
    return Buffer.from(JSON.stringify(req.body), 'utf8');
  }
  return Buffer.alloc(0);
}

function verifyHmacSignature(rawBuf, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBuf).digest('hex');
  const a = Buffer.from(String(signatureHeader).trim(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isTelegramUpdatePayload(body) {
  if (!body || typeof body !== 'object' || body.object === 'page') {
    return false;
  }
  return (
    typeof body.update_id === 'number' ||
    Boolean((body.message && body.message.chat) || (body.edited_message && body.edited_message.chat))
  );
}

const handler = async (req, res) => {
  if (req.method === 'GET') {
    const verifyToken = process.env.META_VERIFY_TOKEN;

    if (!verifyToken) {
      return res.status(503).json({
        status: 'setup_pending',
        provider: 'webhook',
        message: 'Webhook verification is not switched on yet on our side.',
      });
    }

    const mode = req.query && req.query['hub.mode'];
    const token = req.query && req.query['hub.verify_token'];
    const challenge = req.query && req.query['hub.challenge'];

    if (mode === 'subscribe' && token === verifyToken) {
      return res.status(200).send(String(challenge));
    }
    return res.status(403).send('Invalid verify token');
  }

  if (req.method === 'POST') {
    const rawBuf = await readRawBodyBuffer(req);
    const appSecret = process.env.META_APP_SECRET;
    const signatureHeader = req.headers && req.headers['x-hub-signature-256'];
    const tgSecretHeader = req.headers && req.headers['x-telegram-bot-api-secret-token'];

    let body = null;
    let jsonValid = false;
    try {
      const rawText = rawBuf.toString('utf8').trim();
      if (rawText) {
        body = JSON.parse(rawText);
        jsonValid = true;
      }
    } catch (err) {
      jsonValid = false;
    }

    // If X-Hub-Signature-256 is present, always verify HMAC against META_APP_SECRET.
    if (signatureHeader) {
      if (!appSecret || !verifyHmacSignature(rawBuf, signatureHeader, appSecret)) {
        return res.status(403).send('Invalid signature');
      }
      if (!jsonValid) {
        console.warn('[clinicflow] Ignored unparseable signed Meta payload');
        return res.status(200).send('EVENT_RECEIVED');
      }
    } else if (tgSecretHeader || (jsonValid && isTelegramUpdatePayload(body))) {
      // Telegram webhook updates do not include Meta's X-Hub-Signature-256 header.
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (secret && tgSecretHeader !== secret) {
        return res.status(403).json({ ok: false, error: 'Invalid Telegram secret token' });
      }
      if (!jsonValid || !isTelegramUpdatePayload(body)) {
        console.warn('[clinicflow] Ignored invalid Telegram webhook payload');
        return res.status(200).json({ ok: true, status: 'ignored' });
      }
      try {
        const result = await handleTelegramUpdate({ update: body, store });
        return res.status(200).json({ ok: true, ...result });
      } catch (err) {
        const ref = logServerError('telegram_webhook', err);
        return res.status(200).json({ ok: false, error: 'Internal error', ref });
      }
    } else if (appSecret) {
      // Fail closed when META_APP_SECRET is set and X-Hub-Signature-256 is missing.
      return res.status(403).send('Missing signature');
    } else if (!jsonValid) {
      console.warn('[clinicflow] Ignored unparseable webhook payload');
      return res.status(200).send('EVENT_RECEIVED');
    }

    // Path A: Meta Messenger Graph API webhook (signature verified if secret is configured)
    if (body && body.object === 'page' && Array.isArray(body.entry)) {
      const tasks = [];
      for (const entry of body.entry) {
        const entryPageId = entry && entry.id ? String(entry.id) : '';
        const messaging = Array.isArray(entry && entry.messaging) ? entry.messaging : [];

        for (const event of messaging) {
          if (!event || !event.message || event.message.is_echo || !event.message.text) {
            continue;
          }
          const senderId = event.sender && event.sender.id ? String(event.sender.id) : '';
          const pageId =
            entryPageId ||
            (event.recipient && event.recipient.id ? String(event.recipient.id) : '');
          const messageId = event.message.mid ? String(event.message.mid) : '';
          const userText = String(event.message.text).trim();

          if (!senderId || !pageId || !userText) {
            continue;
          }

          tasks.push(
            processMessengerEvent({
              pageId,
              senderId,
              messageId,
              userText,
              store,
            }).catch((err) => {
              const ref = logServerError('webhook_event', err);
              return { status: 'error', ref };
            })
          );
        }
      }

      await Promise.all(tasks);
      return res.status(200).send('EVENT_RECEIVED');
    }

    console.log(
      '[clinicflow] ignored webhook payload shape:',
      JSON.stringify({
        object: body && body.object ? body.object : null,
        keys: body && typeof body === 'object' ? Object.keys(body).slice(0, 10) : [],
      })
    );
    return res.status(200).send('EVENT_RECEIVED');
  }

  return res.status(405).json({ status: 'method_not_allowed' });
};

handler.config = {
  api: {
    bodyParser: false,
  },
};

module.exports = handler;
