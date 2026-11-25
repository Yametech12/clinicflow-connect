// ClinicFlow Connect: health and configuration status.
// Returns booleans only. Env var values are never exposed.
const store = require('./_store');

module.exports = (req, res) => {
  const storageInfo = store.getBackendInfo();

  const configured = {
    META_APP_ID: Boolean(process.env.META_APP_ID),
    META_APP_SECRET: Boolean(process.env.META_APP_SECRET),
    META_VERIFY_TOKEN: Boolean(process.env.META_VERIFY_TOKEN),
    GOOGLE_CLIENT_ID: Boolean(process.env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
    GEMINI_MODEL: Boolean(process.env.GEMINI_MODEL),
    TELEGRAM_BOT_TOKEN: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    TELEGRAM_BOT_USERNAME: Boolean(process.env.TELEGRAM_BOT_USERNAME),
    KV_REST_API_URL: Boolean(
      process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
    ),
    KV_REST_API_TOKEN: Boolean(
      process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
    ),
  };

  const providers = {
    facebook: configured.META_APP_ID && configured.META_APP_SECRET,
    google: configured.GOOGLE_CLIENT_ID && configured.GOOGLE_CLIENT_SECRET,
    telegram: configured.TELEGRAM_BOT_TOKEN && configured.TELEGRAM_BOT_USERNAME,
    webhook: configured.META_VERIFY_TOKEN,
    ai: configured.GEMINI_API_KEY,
    storage: storageInfo.configured,
  };

  res.status(200).json({
    status: 'ok',
    service: 'clinicflow-connect',
    version: '1.0.0',
    configured,
    providers,
    storage_backend: storageInfo.backend,
    note: 'A provider marked false has missing server credentials or storage config, so its connect flow honestly reports setup pending.',
  });
};
