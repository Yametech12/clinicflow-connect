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

  // GT-136 A1: a pre-existing clinic record is only reachable with proof of
  // its cf_key. An id-only cookie (or a wrong key) gets a 403, so a leaked
  // clinic ID can no longer start a connect flow for someone else's clinic.
  // Brand-new sessions and records with no key yet (genuine first bind,
  // completed inside the OAuth callback) proceed.
  if (session.recordHasKeyHash && !session.hasValidKey) {
    return res.status(403).json({
      status: 'forbidden',
      code: 'INVALID_SESSION',
      provider: 'google',
      message:
        'Your clinic session could not be verified. Please reload the page with cookies enabled and try again.',
    });
  }

  const origin = getOAuthBaseUrl(req);
  const redirectUri = `${origin}/api/callback/google`;

  const scopes = [
    'openid',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
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
