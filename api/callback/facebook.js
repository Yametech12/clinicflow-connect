// ClinicFlow Connect: Facebook OAuth callback.
// Exchanges code -> user token -> long-lived user token -> /me/accounts Pages,
// subscribes the chosen Page to app webhooks, and stores the Page token.
const crypto = require('crypto');
const store = require('../_store');
const {
  getRequestOrigin,
  setClinicCookie,
  verifyState,
  readRequestBody,
  wantsHtml,
  escapeHtml,
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

async function completePageConnection({ req, res, clinicId, page, isHtml }) {
  await subscribePageToApp(page.id, page.access_token);

  const clinicKey = `clinic:${clinicId}`;
  const nowIso = new Date().toISOString();
  const existing = (await store.get(clinicKey)) || {
    clinicId,
    createdAt: nowIso,
  };

  if (existing.facebook && existing.facebook.pageId && existing.facebook.pageId !== String(page.id)) {
    const oldPageKey = `fb_page:${existing.facebook.pageId}`;
    const oldMapping = await store.get(oldPageKey);
    if (oldMapping && oldMapping.clinicId === clinicId) {
      await store.del(oldPageKey);
    }
  }

  existing.facebook = {
    pageId: String(page.id),
    pageName: String(page.name || page.id),
    pageAccessToken: String(page.access_token),
    subscribed: true,
    connectedAt: nowIso,
  };
  existing.updatedAt = nowIso;

  await store.put(clinicKey, existing);
  await store.put(`fb_page:${page.id}`, { clinicId });
  setClinicCookie(req, res, clinicId);

  if (isHtml) {
    return redirect(res, '/?connected=facebook');
  }

  return res.status(200).json({
    status: 'connected',
    provider: 'facebook',
    clinic_id: clinicId,
    page_id: existing.facebook.pageId,
    page_name: existing.facebook.pageName,
    subscribed: true,
  });
}

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
    provider: 'facebook',
    message,
  });
}

module.exports = async (req, res) => {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const storageInfo = store.getBackendInfo();
  const isHtml = wantsHtml(req);

  const missing = [];
  if (!appId) missing.push('META_APP_ID');
  if (!appSecret) missing.push('META_APP_SECRET');
  if (!storageInfo.configured) missing.push(...storageInfo.missing);

  if (missing.length > 0) {
    const msg = `Server setup pending. Missing: ${missing.join(', ')}.`;
    if (isHtml) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(
        renderStatusHtml({
          title: 'Setup pending',
          heading: 'Facebook connect setup pending',
          message: msg,
          tone: 'warn',
        })
      );
    }
    return res.status(503).json({
      status: 'setup_pending',
      provider: 'facebook',
      missing,
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
          'Missing Page selection',
          'Please select a Facebook Page and submit again.'
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
          'Your Facebook Page selection session expired. Please reconnect Facebook from the home page.'
        );
      }

      const chosenPage = pending.pages.find((p) => String(p.id) === chosenPageId);
      if (!chosenPage) {
        return sendError(
          req,
          res,
          400,
          'Invalid Page',
          'The selected Facebook Page was not found in your authorized Page list.'
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
      const desc = query.error_description || query.error_reason || query.error;
      return sendError(req, res, 400, 'Facebook sign-in cancelled', String(desc));
    }

    if (!query.code || !query.state) {
      return sendError(
        req,
        res,
        400,
        'Incomplete Facebook callback',
        'Missing OAuth code or state parameter.'
      );
    }

    const stateCheck = verifyState(String(query.state), 'facebook', appSecret);
    if (!stateCheck.valid) {
      return sendError(
        req,
        res,
        400,
        'Invalid OAuth state',
        `OAuth state check failed (${stateCheck.reason}). Please restart Facebook Connect.`
      );
    }

    const clinicId = stateCheck.clinicId;
    const { origin } = getRequestOrigin(req);
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

    // 3. Fetch the user's Pages (Page tokens derived from a long-lived user token do not expire).
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
        'No manageable Facebook Pages were returned for this account. Make sure you own or manage a Facebook Page and granted Page permissions.'
      );
    }

    const requestedPageId = query.page_id ? String(query.page_id) : '';
    if (requestedPageId) {
      const matched = pages.find((p) => String(p.id) === requestedPageId);
      if (!matched) {
        return sendError(req, res, 400, 'Page not found', 'Requested page_id was not returned by Meta.');
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
    setClinicCookie(req, res, clinicId);

    if (!isHtml) {
      return res.status(200).json({
        status: 'page_selection_required',
        provider: 'facebook',
        clinic_id: clinicId,
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
    return sendError(
      req,
      res,
      500,
      'Facebook connection failed',
      err.message || 'Unexpected error during Facebook OAuth callback.'
    );
  }
};
