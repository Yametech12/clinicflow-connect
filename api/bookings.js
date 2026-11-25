// ClinicFlow Connect: recent bookings for the client dashboard.
// GET only. Requires a clinic session whose record is bound to a Google
// account (googleSub set by the Google login callback); anything else gets
// 401 login_required and the dashboard sends the visitor to log in.
// Reads the clinic's own Leads_Bookings sheet with its stored Google
// credentials (refreshing the access token when needed). Read-only: this
// endpoint never writes to the sheet, the calendar, or any clinic section
// except the token refresh merge inside getValidGoogleAccessToken.
const store = require('./_store');
const clinicStore = require('./_clinic');
const { getClinicIdFromRequest, logServerError } = require('./_session');
const { getValidGoogleAccessToken, readRecentBookings } = require('./_google');

const MSG_GOOGLE_UNAVAILABLE =
  'We could not read your booking sheet right now. Please reconnect Google and try again.';

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'method_not_allowed' });
  }

  const storageInfo = store.getBackendInfo();
  const clinicId = storageInfo.configured ? getClinicIdFromRequest(req) : null;
  if (!clinicId) {
    return res.status(401).json({ status: 'login_required', bookings: [] });
  }

  try {
    const clinic = await clinicStore.getClinic(store, clinicId);
    const google = (clinic && clinic.google) || null;

    if (!google || !google.googleSub) {
      return res.status(401).json({ status: 'login_required', bookings: [] });
    }

    if (!google.spreadsheetId) {
      return res.status(200).json({ status: 'no_sheet', bookings: [] });
    }

    let accessToken = null;
    try {
      accessToken = await getValidGoogleAccessToken(clinicId, clinic, store);
    } catch (refreshErr) {
      logServerError('bookings_token_refresh', refreshErr);
      return res.status(200).json({
        status: 'google_unavailable',
        bookings: [],
        message: MSG_GOOGLE_UNAVAILABLE,
      });
    }

    if (!accessToken) {
      return res.status(200).json({
        status: 'google_unavailable',
        bookings: [],
        message: MSG_GOOGLE_UNAVAILABLE,
      });
    }

    const bookings = await readRecentBookings(accessToken, google.spreadsheetId, 10);
    return res.status(200).json({ status: 'ok', bookings });
  } catch (err) {
    const ref = logServerError('bookings_read', err);
    return res.status(200).json({
      status: 'google_unavailable',
      bookings: [],
      message: MSG_GOOGLE_UNAVAILABLE,
      ref,
    });
  }
};
