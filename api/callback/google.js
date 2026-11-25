// ClinicFlow Connect: Google OAuth callback.
// Exchanges the authorization code for access and refresh tokens, stores them
// on the clinic :google section key, and provisions the clinic Sheet if none is linked.
const store = require('../_store');
const clinicStore = require('../_clinic');
const {
  getOAuthBaseUrl,
  getClinicIdFromRequest,
  createClinicKey,
  hashClinicKey,
  setClinicCookie,
  setClinicKeyCookie,
  verifyState,
  consumeSingleUseState,
  wantsHtml,
  logServerError,
  renderStatusHtml,
  redirect,
} = require('../_session');
const {
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  createClinicSpreadsheet,
} = require('../_google');

function sendError(req, res, statusCode, heading, message, ref) {
  const finalMsg = ref ? `${message} (Reference: ${ref})` : message;
  if (wantsHtml(req)) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(
      renderStatusHtml({
        title: heading,
        heading,
        message: finalMsg,
        tone: 'error',
      })
    );
  }
  return res.status(statusCode).json({
    status: 'error',
    provider: 'google',
    message: finalMsg,
    ...(ref ? { ref } : {}),
  });
}

async function ensureMetaRecordOnCallback(req, res, clinicId) {
  const existingMeta = await clinicStore.getClinicSection(store, clinicId, 'meta');
  if (existingMeta && existingMeta.keyHash) {
    if (getClinicIdFromRequest(req) === clinicId) {
      setClinicCookie(req, res, clinicId);
    }
    return;
  }

  const nowIso = new Date().toISOString();
  const newKey = createClinicKey();
  await clinicStore.saveClinicSection(store, clinicId, 'meta', {
    clinicId,
    keyHash: hashClinicKey(newKey),
    createdAt: (existingMeta && existingMeta.createdAt) || nowIso,
    updatedAt: nowIso,
  });
  setClinicCookie(req, res, clinicId);
  setClinicKeyCookie(req, res, newKey);
}

// Adoption: the browser's cookies point at a different clinic record than the
// one this Google account owns. Point the session at the owned record and
// rotate its write key, because the browser cannot know the record's old key.
async function adoptClinicSession(req, res, clinicId) {
  const existingMeta = await clinicStore.getClinicSection(store, clinicId, 'meta');
  const nowIso = new Date().toISOString();
  const newKey = createClinicKey();
  await clinicStore.saveClinicSection(store, clinicId, 'meta', {
    clinicId,
    keyHash: hashClinicKey(newKey),
    createdAt: (existingMeta && existingMeta.createdAt) || nowIso,
    updatedAt: nowIso,
  });
  setClinicCookie(req, res, clinicId);
  setClinicKeyCookie(req, res, newKey);
}

module.exports = async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const storageInfo = store.getBackendInfo();
  const isHtml = wantsHtml(req);

  if (!clientId || !clientSecret || !storageInfo.configured) {
    const heading = 'This step is not switched on yet';
    const msg =
      'This part of ClinicFlow is still being set up on our side. Please go back and try again later. There is nothing wrong with your account.';
    if (isHtml) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(
        renderStatusHtml({
          title: heading,
          heading,
          message: msg,
          tone: 'warn',
        })
      );
    }
    return res.status(503).json({
      status: 'setup_pending',
      provider: 'google',
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
        'You closed the sign-in before finishing, so nothing was connected. Your accounts are unchanged. Tap the connect button whenever you are ready.'
      );
    }

    if (!query.code || !query.state) {
      return sendError(
        req,
        res,
        400,
        'That sign-in did not finish',
        'Google did not send you back properly. Please return to the ClinicFlow page and tap the connect button again.'
      );
    }

    const stateCheck = verifyState(String(query.state), 'google', clientSecret);
    if (!stateCheck.valid || !(await consumeSingleUseState(store, stateCheck.nonce))) {
      return sendError(
        req,
        res,
        400,
        'That sign-in link expired',
        'For your safety, each sign-in link works only once and only for a short time. Please return to the ClinicFlow page and tap the connect button again.'
      );
    }

    const clinicId = stateCheck.clinicId;
    const origin = getOAuthBaseUrl(req);
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
    let googleSub = null;
    try {
      const info = await fetchGoogleUserInfo(tokenData.access_token);
      email = info.email;
      googleSub = info.sub;
    } catch (infoErr) {
      logServerError('google_userinfo', infoErr);
    }

    // Login identity: a Google account owns exactly one clinic record. If
    // this account was bound before, adopt that record; otherwise bind the
    // account to the clinic carried by the OAuth state.
    const stateClinicId = clinicId;
    let effectiveClinicId = stateClinicId;
    if (googleSub) {
      const indexedClinicId = await clinicStore.getClinicIdByGoogleSub(store, googleSub);
      if (indexedClinicId) {
        effectiveClinicId = indexedClinicId;
      }
    }
    const adopted = effectiveClinicId !== stateClinicId;

    if (adopted) {
      // Carry over connections the browser-side clinic already made (profile,
      // Facebook Page, Telegram) when the adopted record does not have them
      // yet, so adopting never silently drops a working connection.
      for (const section of ['profile', 'facebook', 'telegram']) {
        const targetSection = await clinicStore.getClinicSection(store, effectiveClinicId, section);
        if (targetSection) continue;
        const sourceSection = await clinicStore.getClinicSection(store, stateClinicId, section);
        if (!sourceSection) continue;
        await clinicStore.saveClinicSection(store, effectiveClinicId, section, sourceSection);
        if (section === 'facebook' && sourceSection.pageId) {
          await store.put(`fb_page:${sourceSection.pageId}`, { clinicId: effectiveClinicId });
        }
      }
    }

    const [prevGoogle, prevProfile] = await Promise.all([
      clinicStore.getClinicSection(store, effectiveClinicId, 'google'),
      clinicStore.getClinicSection(store, effectiveClinicId, 'profile'),
    ]);
    const baseGoogle = prevGoogle || {};

    let spreadsheetId = baseGoogle.spreadsheetId || null;
    let spreadsheetUrl = baseGoogle.spreadsheetUrl || null;
    let sheetWarning = false;

    if (!spreadsheetId) {
      try {
        const created = await createClinicSpreadsheet(
          tokenData.access_token,
          prevProfile && prevProfile.name
        );
        spreadsheetId = created.spreadsheetId;
        spreadsheetUrl = created.spreadsheetUrl;
      } catch (sheetErr) {
        sheetWarning = true;
        logServerError('google_create_sheet', sheetErr);
      }
    }

    const nowIso = new Date().toISOString();
    const nextGoogle = {
      email: email || baseGoogle.email || null,
      googleSub: googleSub || baseGoogle.googleSub || null,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || baseGoogle.refreshToken || null,
      expiresAt: Date.now() + (Number(tokenData.expires_in) || 3600) * 1000,
      spreadsheetId,
      spreadsheetUrl,
      calendarId: baseGoogle.calendarId || 'primary',
      connectedAt: nowIso,
    };

    await clinicStore.saveClinicSection(store, effectiveClinicId, 'google', nextGoogle);

    if (googleSub) {
      if (baseGoogle.googleSub && baseGoogle.googleSub !== googleSub) {
        await clinicStore.unbindGoogleSub(store, baseGoogle.googleSub, effectiveClinicId);
      }
      await clinicStore.bindGoogleSub(store, googleSub, effectiveClinicId);
    }

    if (adopted) {
      await adoptClinicSession(req, res, effectiveClinicId);
    } else {
      await ensureMetaRecordOnCallback(req, res, effectiveClinicId);
    }

    if (isHtml) {
      const qs = sheetWarning ? '?connected=google&sheet_warning=1' : '?connected=google';
      return redirect(res, `/dashboard${qs}`);
    }

    return res.status(200).json({
      status: 'connected',
      provider: 'google',
      clinic_id: effectiveClinicId,
      email: nextGoogle.email,
      has_refresh_token: Boolean(nextGoogle.refreshToken),
      spreadsheet_id: nextGoogle.spreadsheetId,
      spreadsheet_url: nextGoogle.spreadsheetUrl,
      sheet_warning: sheetWarning,
    });
  } catch (err) {
    const ref = logServerError('callback_google', err);
    return sendError(
      req,
      res,
      500,
      'Google connection failed',
      'Something went wrong on our side while connecting. Please try again in a few minutes. Your accounts are unchanged and safe.',
      ref
    );
  }
};
