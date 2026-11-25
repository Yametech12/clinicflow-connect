// ClinicFlow Connect: Meta Messenger & Telegram bot webhook receiver.
// GET: Meta verification handshake against META_VERIFY_TOKEN.
// POST:
//   - Meta Messenger events (object === 'page'): runs the AI FAQ + booking pipeline.
//   - Telegram Bot updates (update_id / message.chat): handles /start linking codes.
const crypto = require('crypto');
const store = require('./_store');
const { readRequestBody } = require('./_session');
const { processMessengerEvent, handleTelegramUpdate } = require('./_pipeline');

function verifyMetaSignatureIfAvailable(req) {
  const signature = req && req.headers && req.headers['x-hub-signature-256'];
  const appSecret = process.env.META_APP_SECRET;
  if (!signature || !appSecret || !req.rawBody) {
    return true;
  }
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
  const a = Buffer.from(String(signature), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const verifyToken = process.env.META_VERIFY_TOKEN;

    if (!verifyToken) {
      return res.status(503).json({
        status: 'setup_pending',
        provider: 'webhook',
        missing: ['META_VERIFY_TOKEN'],
        message:
          'META_VERIFY_TOKEN is not set on the server, so webhook verification cannot run yet.',
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
    const body = await readRequestBody(req);

    // Path A: Meta Messenger Graph API webhook
    if (body && body.object === 'page' && Array.isArray(body.entry)) {
      if (!verifyMetaSignatureIfAvailable(req)) {
        return res.status(403).send('Invalid signature');
      }

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
              console.error('[clinicflow] Messenger event processing error:', err.message);
              return { status: 'error', error: err.message };
            })
          );
        }
      }

      await Promise.all(tasks);
      // Always return HTTP 200 'EVENT_RECEIVED' so Meta does not retry or disable webhook.
      return res.status(200).send('EVENT_RECEIVED');
    }

    // Path B: Telegram Bot webhook update (/start linking code)
    const isTelegramUpdate =
      body &&
      (typeof body.update_id === 'number' ||
        ((body.message || body.edited_message) && body.object !== 'page'));

    if (isTelegramUpdate) {
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (secret) {
        const headerToken = req.headers && req.headers['x-telegram-bot-api-secret-token'];
        if (headerToken !== secret) {
          return res.status(403).json({ ok: false, error: 'Invalid Telegram secret token' });
        }
      }

      try {
        const result = await handleTelegramUpdate({ update: body, store });
        return res.status(200).json({ ok: true, ...result });
      } catch (err) {
        console.error('[clinicflow] Telegram webhook error:', err.message);
        return res.status(200).json({ ok: false, error: err.message });
      }
    }

    console.log('[clinicflow] ignored webhook payload shape:', JSON.stringify({
      object: body && body.object ? body.object : null,
      keys: body && typeof body === 'object' ? Object.keys(body).slice(0, 10) : [],
    }));
    return res.status(200).send('EVENT_RECEIVED');
  }

  return res.status(405).json({ status: 'method_not_allowed' });
};
