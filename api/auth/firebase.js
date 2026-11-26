// ClinicFlow Connect: Firebase Authentication login bridge.
// GT-139 FL139-08. POST only. The browser signs in with Firebase
// (Google provider, redirect flow), then posts the Firebase ID token
// here. This handler verifies the token with api/_firebase.js, resolves
// the clinic, and issues the EXISTING cf_clinic and cf_key session, so
// GET /api/clinic keeps returning authenticated and logged_in with the
// same names and meanings as before the migration.
//
// Resolution order (auth-research.md section 6, step 2):
//   (i)   clinic already bound to this Firebase uid: adopt it
//   (ii)  clinic bound to this Google sub: adopt it, record the uid
//   (iii) the browser's current cookie clinic: bind uid and sub to it
//   (iv)  a fresh clinic record (ensureClinicSession already made one)
// Adoption rotates the record's key, mirroring the Google callback.
const store = require('../_store');
const clinicStore = require('../_clinic');
const {
  ensureClinicSession,
  createClinicKey,
  hashClinicKey,
  setClinicCookie,
  setClinicKeyCookie,
  readRequestBody,
  logServerError,
} = require('../_session');
const { getFirebaseProjectId, verifyFirebaseIdToken } = require('../_firebase');

const MSG_SETUP_PENDING =
  'This step is not switched on yet on our side. Your account is safe and there is nothing for you to fix. Please check back shortly.';
const MSG_STORAGE_PENDING =
  'This step cannot save anything yet because our server storage is not switched on. There is nothing for you to fix; please check back shortly.';

async function rotateSessionKey(req, res, clinicId) {
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
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'method_not_allowed' });
  }

  const storageInfo = store.getBackendInfo();
  if (!storageInfo.configured) {
    return res.status(200).json({
      status: 'setup_pending',
      provider: 'firebase',
      message: MSG_STORAGE_PENDING,
    });
  }

  if (!getFirebaseProjectId()) {
    return res.status(200).json({
      status: 'setup_pending',
      provider: 'firebase',
      message: MSG_SETUP_PENDING,
    });
  }

  try {
    const body = await readRequestBody(req);
    const token = body.id_token || body.idToken || '';

    let claims;
    try {
      claims = await verifyFirebaseIdToken(String(token));
    } catch (verifyErr) {
      return res.status(401).json({
        status: 'invalid_token',
        provider: 'firebase',
        message: 'That sign-in could not be verified. Please try signing in again.',
      });
    }

    const session = await ensureClinicSession(req, res, store, clinicStore);

    let effectiveClinicId = null;
    const byUid = await clinicStore.getClinicIdByFirebaseUid(store, claims.uid);
    if (byUid) {
      effectiveClinicId = byUid;
    } else if (claims.googleSub) {
      const bySub = await clinicStore.getClinicIdByGoogleSub(store, claims.googleSub);
      if (bySub) {
        effectiveClinicId = bySub;
      }
    }

    if (!effectiveClinicId) {
      // Bind to the cookie clinic only when the caller owns it: a valid
      // key for a keyed record, or a genuine first bind (fresh session
      // or a record with no key yet). Same gate as the Google callback.
      if (session.recordHasKeyHash && !session.hasValidKey) {
        return res.status(403).json({
          status: 'forbidden',
          code: 'INVALID_SESSION',
          provider: 'firebase',
          message:
            'Your clinic session could not be verified. Please reload the page with cookies enabled and try again.',
        });
      }
      effectiveClinicId = session.clinicId;
    }

    const adopted = effectiveClinicId !== session.clinicId;
    const nowIso = new Date().toISOString();
    const prevAuth =
      (await clinicStore.getClinicSection(store, effectiveClinicId, 'auth')) || {};
    await clinicStore.saveClinicSection(store, effectiveClinicId, 'auth', {
      ...prevAuth,
      firebaseUid: claims.uid,
      email: claims.email || prevAuth.email || null,
      googleSub: claims.googleSub || prevAuth.googleSub || null,
      provider: claims.provider || prevAuth.provider || 'google.com',
      boundAt: prevAuth.boundAt || nowIso,
      updatedAt: nowIso,
    });
    await clinicStore.bindFirebaseUid(store, claims.uid, effectiveClinicId);

    if (adopted) {
      await rotateSessionKey(req, res, effectiveClinicId);
    } else if (!session.recordHasKeyHash && !session.sessionIssued) {
      // Legacy record with no key yet: first bind issues a key, the same
      // recovery the Google callback performs on first touch.
      await rotateSessionKey(req, res, effectiveClinicId);
    }

    return res.status(200).json({
      status: 'signed_in',
      provider: 'firebase',
      clinic_id: effectiveClinicId,
      authenticated: true,
      logged_in: true,
    });
  } catch (err) {
    const ref = logServerError('auth_firebase', err);
    return res.status(500).json({
      status: 'error',
      provider: 'firebase',
      message: `Sign-in could not finish just now. Please try again in a moment. Reference: ${ref}`,
    });
  }
};
