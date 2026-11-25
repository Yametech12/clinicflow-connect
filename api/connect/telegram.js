// ClinicFlow Connect: Telegram alert linking.
// Generates a short linking code, persists it against the clinic ID with a
// 10-minute TTL, and returns a deep link (?start=<code>) to the central bot.
const crypto = require('crypto');
const store = require('../_store');
const { ensureClinicId } = require('../_session');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L lookalikes
const CODE_TTL_SECONDS = 600;

function generateCode() {
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

module.exports = async (req, res) => {
  const rawUsername = process.env.TELEGRAM_BOT_USERNAME || '';
  const botUsername = rawUsername.trim().replace(/^@+/, '');
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const storageInfo = store.getBackendInfo();

  const missing = [];
  if (!botUsername) missing.push('TELEGRAM_BOT_USERNAME');
  if (!botToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!storageInfo.configured) missing.push(...storageInfo.missing);

  if (missing.length > 0) {
    return res.status(200).json({
      status: 'setup_pending',
      provider: 'telegram',
      missing,
      message: !botUsername || !botToken
        ? 'The central Telegram bot is not configured yet, so Telegram linking is not live. Once TELEGRAM_BOT_USERNAME and TELEGRAM_BOT_TOKEN are set on the server, this step shows a real bot deep link.'
        : 'Server storage is not configured yet, so Telegram linking codes cannot be verified. Configure KV_REST_API_URL and KV_REST_API_TOKEN to enable linking.',
    });
  }

  const clinicId = ensureClinicId(req, res);
  const code = generateCode();
  const now = Date.now();
  const expiresAt = new Date(now + CODE_TTL_SECONDS * 1000);

  try {
    await store.put(
      `tg_code:${code}`,
      {
        clinicId,
        createdAt: new Date(now).toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
      { ttlSeconds: CODE_TTL_SECONDS }
    );
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      provider: 'telegram',
      message: 'Failed to store Telegram linking code.',
    });
  }

  const botLink = `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(code)}`;

  return res.status(200).json({
    status: 'ready',
    provider: 'telegram',
    clinic_id: clinicId,
    bot_username: botUsername,
    bot_link: botLink,
    linking_code: code,
    expires_at: expiresAt.toISOString(),
    expires_in_seconds: CODE_TTL_SECONDS,
    instructions: [
      `Open the bot link: ${botLink}`,
      'Tap Start in Telegram to send the linking code automatically.',
      `Or send /start ${code} directly to @${botUsername}.`,
      'Booking alerts will then go to that Telegram chat.',
    ],
    verification: 'pending_chat_start',
  });
};
