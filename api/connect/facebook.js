// ClinicFlow Connect: start Facebook Login for a clinic Page.
// Builds the signed OAuth URL using PUBLIC_BASE_URL (or request origin fallback).
const store = require('../_store');
const clinicStore = require('../_clinic');
const { getOAuthBaseUrl, ensureClinicSession, signState } = require('../_session');

const MSG_APP_PENDING =
  'This step is not switched on yet on our side. Your account is safe and there is nothing for you to fix. Please check back shortly.';
const MSG_STORAGE_PENDING =
  'This step cannot save anything yet because our server storage is not switched on. There is nothing for you to fix; please check back shortly.';

module.exports = async (req, res) => {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const storageInfo = store.getBackendInfo();

  if (!appId || !appSecret) {
    return res.status(200).json({
      status: 'setup_pending',
      provider: 'facebook',
      message: MSG_APP_PENDING,
    });
  }

  if (!storageInfo.configured) {
    return res.status(200).json({
      status: 'setup_pending',
      provider: 'facebook',
      message: MSG_STORAGE_PENDING,
    });
  }

  const session = await ensureClinicSession(req, res, store, clinicStore);
  const origin = getOAuthBaseUrl(req);
  const redirectUri = `${origin}/api/callback/facebook`;
  const scopes = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata'];
  const state = signState(session.clinicId, 'facebook', appSecret);

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
    oauth_url: `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`,
    redirect_uri: redirectUri,
    scopes,
  });
};
