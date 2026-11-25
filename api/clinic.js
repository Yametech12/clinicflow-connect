// ClinicFlow Connect: clinic profile and connection summary endpoint.
// GET returns sanitized clinic profile and connection flags (never tokens).
// POST persists clinic profile fields (and optional existing Google Sheet ID/URL).
const store = require('./_store');
const {
  ensureClinicId,
  readRequestBody,
  sanitizeClinicSummary,
} = require('./_session');
const { extractSpreadsheetId } = require('./_google');

module.exports = async (req, res) => {
  const clinicId = ensureClinicId(req, res);
  const storageInfo = store.getBackendInfo();

  if (req.method === 'GET') {
    if (!storageInfo.configured) {
      return res.status(200).json({
        status: 'storage_pending',
        storage_configured: false,
        missing: storageInfo.missing,
        ...sanitizeClinicSummary({ clinicId }),
      });
    }

    try {
      const clinic = await store.get(`clinic:${clinicId}`);
      return res.status(200).json({
        status: 'ok',
        storage_configured: true,
        ...sanitizeClinicSummary(clinic || { clinicId }),
      });
    } catch (err) {
      return res.status(500).json({
        status: 'error',
        message: 'Could not load clinic record from storage.',
      });
    }
  }

  if (req.method === 'POST') {
    if (!storageInfo.configured) {
      return res.status(503).json({
        status: 'setup_pending',
        storage_configured: false,
        missing: storageInfo.missing,
        message: 'Server storage is not configured yet, so clinic details cannot be saved.',
      });
    }

    try {
      const body = await readRequestBody(req);
      const key = `clinic:${clinicId}`;
      const nowIso = new Date().toISOString();
      const existing = (await store.get(key)) || {
        clinicId,
        createdAt: nowIso,
      };

      const prevProfile = existing.profile || {};
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

      existing.profile = nextProfile;

      if (body.spreadsheet_id !== undefined && String(body.spreadsheet_id).trim() !== '') {
        const extracted = extractSpreadsheetId(body.spreadsheet_id);
        if (!extracted) {
          return res.status(400).json({
            status: 'error',
            message: 'Invalid Google Sheet URL or spreadsheet ID.',
          });
        }
        existing.google = {
          ...(existing.google || {}),
          spreadsheetId: extracted,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${extracted}`,
        };
      }

      existing.updatedAt = nowIso;
      await store.put(key, existing);

      return res.status(200).json({
        status: 'saved',
        storage_configured: true,
        ...sanitizeClinicSummary(existing),
      });
    } catch (err) {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to save clinic profile.',
      });
    }
  }

  return res.status(405).json({ status: 'method_not_allowed' });
};
