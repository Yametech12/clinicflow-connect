// ClinicFlow Connect: start Facebook Login for a clinic Page.
// Builds the OAuth URL from the central Meta app (META_APP_ID / META_APP_SECRET).
// Returns setup_pending instead of a broken link if credentials or storage are missing.
const store = require('../_store');
const { getRequestOrigin, ensureClinicId, signState } = require('../_session');

module.exports = (req, res) => {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const storageInfo = store.getBackendInfo();

  const missing = [];
  if (!appId) missing.push('META_APP_ID');
  if (!appSecret) missing.push('META_APP_SECRET');
  if (!storageInfo.configured) missing.push(...storageInfo.missing);

  if (missing.length > 0) {
    return res.status(200).json({
      status: 'setup_pending',
      provider: 'facebook',
      missing,
      message: !appId || !appSecret
        ? 'The central Meta app is not configured yet, so Facebook connect is not live. Once META_APP_ID and META_APP_SECRET are set on the server, this button starts the real Facebook Login flow.'
        : 'Server storage is not configured yet, so Page tokens cannot be saved. Configure KV_REST_API_URL and KV_REST_API_TOKEN to enable connecting.',
    });
  }

  const clinicId = ensureClinicId(req, res);
  const { origin } = getRequestOrigin(req);
  const redirectUri = `${origin}/api/callback/facebook`;
  const scopes = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata'];
  const state = signState(clinicId, 'facebook', appSecret);

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(','),
    state,
  });

  return res.status(200).json({
    status: 'ready',
    provider: 'facebook',
    clinic_id: clinicId,
    oauth_url: `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`,
    redirect_uri: redirectUri,
    scopes,
    note: 'The clinic owner signs in with their own Facebook account and picks their own Page. The Page stays under the clinic account.',
  });
};
