// ClinicFlow Connect: start Google sign in for Sheets and Calendar.
// Builds the signed OAuth URL using PUBLIC_BASE_URL (or request origin fallback).
const store = require('../_store');
const clinicStore = require('../_clinic');
const { getOAuthBaseUrl, ensureClinicSession, signState } = require('../_session');

const MSG_APP_PENDING =
  'This step is not switched on yet on our side. Your account is safe and there is nothing for you to fix. Please check back shortly.';
const MSG_STORAGE_PENDING =
  'This step cannot save anything yet because our server storage is not switched on. There is nothing for you to fix; please check back shortly.';

module.exports = async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const storageInfo = store.getBackendInfo();

  if (!clientId || !clientSecret) {
    return res.status(200).json({
      status: 'setup_pending',
      provider: 'google',
      message: MSG_APP_PENDING,
    });
  }

  if (!storageInfo.configured) {
    return res.status(200).json({
      status: 'setup_pending',
      provider: 'google',
      message: MSG_STORAGE_PENDING,
    });
  }

  const session = await ensureClinicSession(req, res, store, clinicStore);
  const origin = getOAuthBaseUrl(req);
  const redirectUri = `${origin}/api/callback/google`;

  const scopes = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.email',
  ];

  const state = signState(session.clinicId, 'google', clientSecret);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  return res.status(200).json({
    status: 'ready',
    provider: 'google',
    oauth_url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    redirect_uri: redirectUri,
    scopes,
  });
};
