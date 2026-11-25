// ClinicFlow Connect: log out.
// GT-136 A4: logout now invalidates the session server-side, not just in
// this browser. The record's keyHash is rotated to a fresh random key that
// is never issued to anyone, so every existing cf_clinic + cf_key cookie
// pair (including copies made before logout) stops working. The clinic's
// next Google login re-establishes a key through the callback path.
// Accepts GET (existing links) and POST (the dashboard control).
const store = require('./_store');
const clinicStore = require('./_clinic');
const {
  getClinicIdFromRequest,
  createClinicKey,
  hashClinicKey,
  clearClinicCookies,
  logServerError,
  redirect,
} = require('./_session');

module.exports = async (req, res) => {
  try {
    const storageInfo = store.getBackendInfo();
    const clinicId = storageInfo.configured ? getClinicIdFromRequest(req) : null;
    if (clinicId) {
      const meta = await clinicStore.getClinicSection(store, clinicId, 'meta');
      if (meta && meta.keyHash) {
        await clinicStore.saveClinicSection(store, clinicId, 'meta', {
          ...meta,
          keyHash: hashClinicKey(createClinicKey()),
          updatedAt: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    // Logout must never fail visibly: cookies are still cleared below.
    logServerError('logout_rotate', err);
  }

  clearClinicCookies(req, res);
  return redirect(res, '/');
};
