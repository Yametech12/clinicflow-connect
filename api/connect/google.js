// ClinicFlow Connect: start Google sign in for Sheets and Calendar.
// Builds the OAuth URL from the central Google OAuth client.
// Returns setup_pending instead of a broken link if credentials or storage are missing.
const store = require('../_store');
const { getRequestOrigin, ensureClinicId, signState } = require('../_session');

module.exports = (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const storageInfo = store.getBackendInfo();

  const missing = [];
  if (!clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!storageInfo.configured) missing.push(...storageInfo.missing);

  if (missing.length > 0) {
    return res.status(200).json({
      status: 'setup_pending',
      provider: 'google',
      missing,
      message: !clientId || !clientSecret
        ? 'The central Google OAuth client is not configured yet, so Google connect is not live. Once GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set on the server, this button starts the real Google sign in flow.'
        : 'Server storage is not configured yet, so Google tokens cannot be saved. Configure KV_REST_API_URL and KV_REST_API_TOKEN to enable connecting.',
    });
  }

  const clinicId = ensureClinicId(req, res);
  const { origin } = getRequestOrigin(req);
  const redirectUri = `${origin}/api/callback/google`;

  const scopes = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.email',
  ];

  const state = signState(clinicId, 'google', clientSecret);

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
    clinic_id: clinicId,
    oauth_url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    redirect_uri: redirectUri,
    scopes,
    note: 'The clinic owner signs in with their own Google account. The booking sheet and calendar are created inside that account, not ours.',
  });
};
