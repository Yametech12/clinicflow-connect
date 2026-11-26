// ClinicFlow Connect: Telegram alert linking.
// Generates a short linking code stored with putIfAbsent (retrying on collision)
// and returns a deep link (?start=<code>) to the central bot.
const crypto = require('crypto');
const store = require('../_store');
const clinicStore = require('../_clinic');
const { ensureClinicSession, logServerError } = require('../_session');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L lookalikes
const CODE_TTL_SECONDS = 600;
const MAX_CODE_ATTEMPTS = 6;

const MSG_APP_PENDING =
  'This step is not switched on yet on our side. Your account is safe and there is nothing for you to fix. Please check back shortly.';
const MSG_STORAGE_PENDING =
  'This step cannot save anything yet because our server storage is not switched on. There is nothing for you to fix; please check back shortly.';
const MSG_CODE_ERROR = 'We could not create your linking code. Please try again in a moment.';

function generateCode() {
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'method_not_allowed' });
  }
  const rawUsername = process.env.TELEGRAM_BOT_USERNAME || '';
  const botUsername = rawUsername.trim().replace(/^@+/, '');
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const storageInfo = store.getBackendInfo();

  if (!botUsername || !botToken) {
    return res.status(200).json({
      status: 'setup_pending',
      provider: 'telegram',
      message: MSG_APP_PENDING,
    });
  }

  if (!storageInfo.configured) {
    return res.status(200).json({
      status: 'setup_pending',
      provider: 'telegram',
      message: MSG_STORAGE_PENDING,
    });
  }

  const session = await ensureClinicSession(req, res, store, clinicStore);

  // GT-136 A1: same key-proof gate as the OAuth connect handlers. Without
  // it, anyone holding a clinic ID could mint a linking code and divert
  // that clinic's booking alerts to their own Telegram chat.
  if (session.recordHasKeyHash && !session.hasValidKey) {
    return res.status(403).json({
      status: 'forbidden',
      code: 'INVALID_SESSION',
      provider: 'telegram',
      message:
        'Your clinic session could not be verified. Please reload the page with cookies enabled and try again.',
    });
  }

  const now = Date.now();
  const expiresAt = new Date(now + CODE_TTL_SECONDS * 1000);

  let code = '';
  try {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const candidate = generateCode();
      const inserted = await store.putIfAbsent(
        `tg_code:${candidate}`,
        {
          clinicId: session.clinicId,
          createdAt: new Date(now).toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        { ttlSeconds: CODE_TTL_SECONDS }
      );
      if (inserted) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      throw new Error('Exhausted Telegram linking code collision retries.');
    }
  } catch (err) {
    const ref = logServerError('connect_telegram', err);
    return res.status(500).json({
      status: 'error',
      provider: 'telegram',
      message: MSG_CODE_ERROR,
      ref,
    });
  }

  const botLink = `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(code)}`;

  return res.status(200).json({
    status: 'ready',
    provider: 'telegram',
    bot_username: botUsername,
    bot_link: botLink,
    linking_code: code,
    expires_at: expiresAt.toISOString(),
    expires_in_seconds: CODE_TTL_SECONDS,
    verification: 'pending_chat_start',
  });
};
