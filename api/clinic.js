// ClinicFlow Connect: clinic profile and connection summary endpoint.
// GET returns sanitized clinic profile, high-level provider readiness, and
// connection flags (redacting google email and spreadsheet_url unless the
// request presents a matching HttpOnly cf_key cookie).
// POST requires verified cf_clinic + cf_key cookies to persist profile updates.
const store = require('./_store');
const clinicStore = require('./_clinic');
const {
  getClinicIdFromRequest,
  getClinicKeyFromRequest,
  verifyClinicKeyHash,
  ensureClinicSession,
  readRequestBody,
  sanitizeClinicSummary,
  logServerError,
} = require('./_session');
const { extractSpreadsheetId } = require('./_google');

function getReadyFlags(storageConfigured) {
  return {
    facebook: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_USERNAME),
    storage: storageConfigured,
  };
}

module.exports = async (req, res) => {
  const storageInfo = store.getBackendInfo();
  const ready = getReadyFlags(storageInfo.configured);

  if (req.method === 'GET') {
    const session = await ensureClinicSession(req, res, store, clinicStore);

    if (!storageInfo.configured) {
      return res.status(200).json({
        status: 'storage_pending',
        storage_configured: false,
        session_issued: session.sessionIssued,
        ready,
        ...sanitizeClinicSummary({ clinicId: session.clinicId }, { includeSensitive: false }),
      });
    }

    try {
      const clinic = await clinicStore.getClinic(store, session.clinicId);
      const includeSensitive = Boolean(session.hasValidKey);

      return res.status(200).json({
        status: 'ok',
        storage_configured: true,
        session_issued: session.sessionIssued,
        authenticated: includeSensitive,
        ready,
        ...sanitizeClinicSummary(clinic || { clinicId: session.clinicId }, { includeSensitive }),
      });
    } catch (err) {
      const ref = logServerError('clinic_get', err);
      return res.status(500).json({
        status: 'error',
        message: `Could not load clinic record right now. Reference: ${ref}`,
      });
    }
  }

  if (req.method === 'POST') {
    if (!storageInfo.configured) {
      return res.status(503).json({
        status: 'setup_pending',
        storage_configured: false,
        message:
          'This step cannot save anything yet because our server storage is not switched on. There is nothing for you to fix; please check back shortly.',
      });
    }

    try {
      const clinicId = getClinicIdFromRequest(req);
      const clinicKey = getClinicKeyFromRequest(req);

      if (!clinicId || !clinicKey) {
        return res.status(403).json({
          status: 'forbidden',
          code: 'COOKIES_REQUIRED',
          message:
            'Browser cookies are required to save your clinic profile. Please enable cookies and reload the page.',
        });
      }

      const meta = await clinicStore.getClinicSection(store, clinicId, 'meta');
      if (!meta || !meta.keyHash || !verifyClinicKeyHash(clinicKey, meta.keyHash)) {
        return res.status(403).json({
          status: 'forbidden',
          code: 'INVALID_SESSION',
          message:
            'Your clinic session could not be verified. Please reload the page with cookies enabled and try again.',
        });
      }

      const body = await readRequestBody(req);
      const prevProfile = (await clinicStore.getClinicSection(store, clinicId, 'profile')) || {};
      const nextProfile = {
        name:
          body.name !== undefined
            ? String(body.name || '').trim().slice(0, 140)
            : prevProfile.name || '',
        address:
          body.address !== undefined
            ? String(body.address || '').trim().slice(0, 240)
            : prevProfile.address || '',
        hours:
          body.hours !== undefined
            ? String(body.hours || '').trim().slice(0, 160)
            : prevProfile.hours || '',
        timezone: 'Asia/Manila',
      };

      if (body.spreadsheet_id !== undefined && String(body.spreadsheet_id).trim() !== '') {
        const extracted = extractSpreadsheetId(body.spreadsheet_id);
        if (!extracted) {
          return res.status(400).json({
            status: 'error',
            message:
              'That does not look like a Google Sheet link. Paste the full link from your browser, or leave it blank and ClinicFlow will create the sheet when you connect Google.',
          });
        }
        const prevGoogle = (await clinicStore.getClinicSection(store, clinicId, 'google')) || {};
        await clinicStore.saveClinicSection(store, clinicId, 'google', {
          ...prevGoogle,
          spreadsheetId: extracted,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${extracted}`,
        });
      }

      await clinicStore.saveClinicSection(store, clinicId, 'profile', nextProfile);
      await clinicStore.saveClinicSection(store, clinicId, 'meta', {
        ...meta,
        updatedAt: new Date().toISOString(),
      });

      const updated = await clinicStore.getClinic(store, clinicId);

      return res.status(200).json({
        status: 'saved',
        storage_configured: true,
        ready,
        ...sanitizeClinicSummary(updated, { includeSensitive: true }),
      });
    } catch (err) {
      const ref = logServerError('clinic_post', err);
      return res.status(500).json({
        status: 'error',
        message: `Could not save just now. Your details are kept in this browser; please try again in a moment. Reference: ${ref}`,
      });
    }
  }

  return res.status(405).json({ status: 'method_not_allowed' });
};
