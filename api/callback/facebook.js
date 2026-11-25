// ClinicFlow Connect: Facebook OAuth callback.
// Exchanges code -> user token -> long-lived user token -> /me/accounts Pages,
// subscribes the chosen Page to app webhooks, and stores the Page token in its
// dedicated clinic section key.
const crypto = require('crypto');
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
  readRequestBody,
  wantsHtml,
  escapeHtml,
  logServerError,
  renderStatusHtml,
  redirect,
} = require('../_session');

const GRAPH_VERSION = 'v21.0';

async function metaFetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = { raw: text };
  }
  if (!response.ok || (data && data.error)) {
    const errMsg =
      (data && data.error && (data.error.message || data.error.type)) ||
      text.slice(0, 300) ||
      `HTTP ${response.status}`;
    throw new Error(`Meta Graph API error (${response.status}): ${errMsg}`);
  }
  return data;
}

async function subscribePageToApp(pageId, pageAccessToken) {
  const body = new URLSearchParams({
    subscribed_fields: 'messages,messaging_postbacks',
    access_token: pageAccessToken,
  });

  const data = await metaFetchJson(
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}/subscribed_apps`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }
  );

  if (!data || data.success !== true) {
    throw new Error('Meta did not confirm Page webhook subscription (success !== true).');
  }
  return data;
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

async function completePageConnection({ req, res, clinicId, page, isHtml }) {
  await subscribePageToApp(page.id, page.access_token);

  const nowIso = new Date().toISOString();
  const prevFacebook = await clinicStore.getClinicSection(store, clinicId, 'facebook');

  if (prevFacebook && prevFacebook.pageId && prevFacebook.pageId !== String(page.id)) {
    const oldPageKey = `fb_page:${prevFacebook.pageId}`;
    const oldMapping = await store.get(oldPageKey);
    if (oldMapping && oldMapping.clinicId === clinicId) {
      await store.del(oldPageKey);
    }
  }

  const nextFacebook = {
    pageId: String(page.id),
    pageName: String(page.name || page.id),
    pageAccessToken: String(page.access_token),
    subscribed: true,
    connectedAt: nowIso,
  };

  await clinicStore.saveClinicSection(store, clinicId, 'facebook', nextFacebook);
  await store.put(`fb_page:${page.id}`, { clinicId });
  await ensureMetaRecordOnCallback(req, res, clinicId);

  if (isHtml) {
    return redirect(res, '/?connected=facebook');
  }

  return res.status(200).json({
    status: 'connected',
    provider: 'facebook',
    page_id: nextFacebook.pageId,
    page_name: nextFacebook.pageName,
    subscribed: true,
  });
}

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
    provider: 'facebook',
    message: finalMsg,
    ...(ref ? { ref } : {}),
  });
}

module.exports = async (req, res) => {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const storageInfo = store.getBackendInfo();
  const isHtml = wantsHtml(req);

  if (!appId || !appSecret || !storageInfo.configured) {
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
      provider: 'facebook',
      message: msg,
    });
  }

  try {
    // Handle Step 2 when user picked one of multiple Pages.
    if (req.method === 'POST' || (req.query && req.query.selection_token && req.query.page_id)) {
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const selectionToken = String(
        body.selection_token || (req.query && req.query.selection_token) || ''
      ).trim();
      const chosenPageId = String(
        body.page_id || (req.query && req.query.page_id) || ''
      ).trim();

      if (!selectionToken || !chosenPageId) {
        return sendError(
          req,
          res,
          400,
          'That Page was not in your list',
          'Facebook did not include that Page in the list it gave us. Please reconnect and pick your clinic Page from the list.'
        );
      }

      const pendingKey = `fb_pending:${selectionToken}`;
      const pending = await store.get(pendingKey);
      if (!pending || !Array.isArray(pending.pages) || !pending.clinicId) {
        return sendError(
          req,
          res,
          400,
          'Selection expired',
          'Your Page selection took too long and expired. Please reconnect Facebook from the home page and pick your Page again.'
        );
      }

      const chosenPage = pending.pages.find((p) => String(p.id) === chosenPageId);
      if (!chosenPage) {
        return sendError(
          req,
          res,
          400,
          'That Page was not in your list',
          'Facebook did not include that Page in the list it gave us. Please reconnect and pick your clinic Page from the list.'
        );
      }

      await completePageConnection({
        req,
        res,
        clinicId: pending.clinicId,
        page: chosenPage,
        isHtml,
      });
      await store.del(pendingKey);
      return;
    }

    const query = req.query || {};
    if (query.error) {
      return sendError(
        req,
        res,
        400,
        'Facebook sign-in cancelled',
        'You closed the sign-in before finishing, so nothing was connected. Your accounts are unchanged. Tap the connect button whenever you are ready.'
      );
    }

    if (!query.code || !query.state) {
      return sendError(
        req,
        res,
        400,
        'That sign-in did not finish',
        'Facebook did not send you back properly. Please return to the ClinicFlow page and tap the connect button again.'
      );
    }

    const stateCheck = verifyState(String(query.state), 'facebook', appSecret);
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
    const redirectUri = `${origin}/api/callback/facebook`;

    // 1. Exchange authorization code for short-lived user access token.
    const shortTokenParams = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      client_secret: appSecret,
      code: String(query.code),
    });
    const shortTokenData = await metaFetchJson(
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?${shortTokenParams.toString()}`
    );
    if (!shortTokenData.access_token) {
      throw new Error('Meta did not return a user access_token.');
    }

    // 2. Exchange short-lived user token for long-lived user token.
    const longTokenParams = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortTokenData.access_token,
    });
    const longTokenData = await metaFetchJson(
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token?${longTokenParams.toString()}`
    );
    const longUserToken = longTokenData.access_token;
    if (!longUserToken) {
      throw new Error('Meta did not return a long-lived user access_token.');
    }

    // 3. Fetch the user's Pages (Page tokens from long-lived user token do not expire).
    const accountsParams = new URLSearchParams({
      fields: 'id,name,access_token',
      limit: '100',
      access_token: longUserToken,
    });
    const accountsData = await metaFetchJson(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?${accountsParams.toString()}`
    );

    const pages = (Array.isArray(accountsData.data) ? accountsData.data : []).filter(
      (p) => p && p.id && p.access_token
    );

    if (pages.length === 0) {
      return sendError(
        req,
        res,
        400,
        'No Facebook Pages found',
        'We could not find a Facebook Page on this account. ClinicFlow needs a Page, not just a personal profile. If your clinic Page is managed from another account, please sign in with that account instead.'
      );
    }

    const requestedPageId = query.page_id ? String(query.page_id) : '';
    if (requestedPageId) {
      const matched = pages.find((p) => String(p.id) === requestedPageId);
      if (!matched) {
        return sendError(
          req,
          res,
          400,
          'That Page was not in your list',
          'Facebook did not include that Page in the list it gave us. Please reconnect and pick your clinic Page from the list.'
        );
      }
      return await completePageConnection({ req, res, clinicId, page: matched, isHtml });
    }

    if (pages.length === 1) {
      return await completePageConnection({ req, res, clinicId, page: pages[0], isHtml });
    }

    // Multiple Pages: persist temporary choices server-side (never expose Page tokens in HTML/JSON).
    const selectionToken = crypto.randomBytes(16).toString('base64url');
    await store.put(
      `fb_pending:${selectionToken}`,
      {
        clinicId,
        pages: pages.map((p) => ({
          id: String(p.id),
          name: String(p.name || p.id),
          access_token: String(p.access_token),
        })),
        createdAt: new Date().toISOString(),
      },
      { ttlSeconds: 600 }
    );
    await ensureMetaRecordOnCallback(req, res, clinicId);

    if (!isHtml) {
      return res.status(200).json({
        status: 'page_selection_required',
        provider: 'facebook',
        selection_token: selectionToken,
        pages: pages.map((p) => ({ id: String(p.id), name: String(p.name || p.id) })),
      });
    }

    const radios = pages
      .map(
        (p, idx) => `<label class="page-item">
          <input type="radio" name="page_id" value="${escapeHtml(p.id)}" ${idx === 0 ? 'checked' : ''} required>
          <span><strong>${escapeHtml(p.name || p.id)}</strong> <small>(ID: ${escapeHtml(p.id)})</small></span>
        </label>`
      )
      .join('\n');

    const formHtml = `<form method="POST" action="/api/callback/facebook">
      <input type="hidden" name="selection_token" value="${escapeHtml(selectionToken)}">
      ${radios}
      <p class="safety">Only the Page you pick gets connected. Your other Pages are not touched.</p>
      <button class="btn" type="submit">Connect selected Page</button>
    </form>`;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(
      renderStatusHtml({
        title: 'Choose Facebook Page',
        heading: 'Choose your clinic Facebook Page',
        message: 'We found multiple Pages on your Facebook account. Pick the one ClinicFlow should answer.',
        tone: 'info',
        extraHtml: formHtml,
      })
    );
  } catch (err) {
    const ref = logServerError('callback_facebook', err);
    return sendError(
      req,
      res,
      500,
      'Facebook connection failed',
      'Something went wrong on our side while connecting. Please try again in a few minutes. Your accounts are unchanged and safe.',
      ref
    );
  }
};
