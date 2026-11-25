// ClinicFlow Connect: Google OAuth callback.
// Exchanges the authorization code for access and refresh tokens, stores them
// on the clinic record, and provisions the clinic Google Sheet if none is linked yet.
const store = require('../_store');
const {
  getRequestOrigin,
  setClinicCookie,
  verifyState,
  wantsHtml,
  renderStatusHtml,
  redirect,
} = require('../_session');
const {
  exchangeGoogleCode,
  fetchGoogleUserEmail,
  createClinicSpreadsheet,
} = require('../_google');

function sendError(req, res, statusCode, heading, message) {
  if (wantsHtml(req)) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(
      renderStatusHtml({
        title: heading,
        heading,
        message,
        tone: 'error',
      })
    );
  }
  return res.status(statusCode).json({
    status: 'error',
    provider: 'google',
    message,
  });
}

module.exports = async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const storageInfo = store.getBackendInfo();
  const isHtml = wantsHtml(req);

  const missing = [];
  if (!clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!storageInfo.configured) missing.push(...storageInfo.missing);

  if (missing.length > 0) {
    const msg = `Server setup pending. Missing: ${missing.join(', ')}.`;
    if (isHtml) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(
        renderStatusHtml({
          title: 'Setup pending',
          heading: 'Google connect setup pending',
          message: msg,
          tone: 'warn',
        })
      );
    }
    return res.status(503).json({
      status: 'setup_pending',
      provider: 'google',
      missing,
      message: msg,
    });
  }

  try {
    const query = req.query || {};
    if (query.error) {
      return sendError(
        req,
        res,
        400,
        'Google sign-in cancelled',
        String(query.error_description || query.error)
      );
    }

    if (!query.code || !query.state) {
      return sendError(
        req,
        res,
        400,
        'Incomplete Google callback',
        'Missing OAuth code or state parameter.'
      );
    }

    const stateCheck = verifyState(String(query.state), 'google', clientSecret);
    if (!stateCheck.valid) {
      return sendError(
        req,
        res,
        400,
        'Invalid OAuth state',
        `OAuth state check failed (${stateCheck.reason}). Please restart Google Connect.`
      );
    }

    const clinicId = stateCheck.clinicId;
    const { origin } = getRequestOrigin(req);
    const redirectUri = `${origin}/api/callback/google`;

    const tokenData = await exchangeGoogleCode({
      code: String(query.code),
      clientId,
      clientSecret,
      redirectUri,
    });

    if (!tokenData || !tokenData.access_token) {
      throw new Error('Google did not return an access_token.');
    }

    let email = null;
    try {
      email = await fetchGoogleUserEmail(tokenData.access_token);
    } catch (emailErr) {
      console.warn('[clinicflow] Google userinfo fetch failed:', emailErr.message);
    }

    const clinicKey = `clinic:${clinicId}`;
    const nowIso = new Date().toISOString();
    const existing = (await store.get(clinicKey)) || {
      clinicId,
      createdAt: nowIso,
    };
    const prevGoogle = existing.google || {};

    let spreadsheetId = prevGoogle.spreadsheetId || null;
    let spreadsheetUrl = prevGoogle.spreadsheetUrl || null;
    let sheetWarning = null;

    if (!spreadsheetId) {
      try {
        const created = await createClinicSpreadsheet(
          tokenData.access_token,
          existing.profile && existing.profile.name
        );
        spreadsheetId = created.spreadsheetId;
        spreadsheetUrl = created.spreadsheetUrl;
      } catch (sheetErr) {
        sheetWarning = sheetErr.message;
        console.warn('[clinicflow] Could not auto-create clinic Sheet:', sheetErr.message);
      }
    }

    existing.google = {
      email: email || prevGoogle.email || null,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || prevGoogle.refreshToken || null,
      expiresAt: Date.now() + (Number(tokenData.expires_in) || 3600) * 1000,
      spreadsheetId,
      spreadsheetUrl,
      calendarId: prevGoogle.calendarId || 'primary',
      connectedAt: nowIso,
    };
    existing.updatedAt = nowIso;

    await store.put(clinicKey, existing);
    setClinicCookie(req, res, clinicId);

    if (isHtml) {
      const qs = sheetWarning ? '?connected=google&sheet_warning=1' : '?connected=google';
      return redirect(res, `/${qs}`);
    }

    return res.status(200).json({
      status: 'connected',
      provider: 'google',
      clinic_id: clinicId,
      email: existing.google.email,
      has_refresh_token: Boolean(existing.google.refreshToken),
      spreadsheet_id: existing.google.spreadsheetId,
      spreadsheet_url: existing.google.spreadsheetUrl,
      sheet_warning: sheetWarning,
    });
  } catch (err) {
    return sendError(
      req,
      res,
      500,
      'Google connection failed',
      err.message || 'Unexpected error during Google OAuth callback.'
    );
  }
};
