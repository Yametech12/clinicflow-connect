// ClinicFlow Connect: per-section clinic record helpers.
// Splits clinic data into disjoint KV keys (meta, profile, facebook, google, telegram)
// so concurrent writers never clobber each other. Migrates legacy clinic:<id>
// records on first read.
const SECTIONS = ['meta', 'profile', 'facebook', 'google', 'telegram'];

function sectionKey(clinicId, section) {
  return `clinic:${clinicId}:${section}`;
}

function legacyKey(clinicId) {
  return `clinic:${clinicId}`;
}

async function migrateLegacyClinicIfNeeded(store, clinicId) {
  if (!store || !clinicId) return null;
  const legacy = await store.get(legacyKey(clinicId));
  if (!legacy || typeof legacy !== 'object') {
    return null;
  }

  const nowIso = new Date().toISOString();
  const meta = {
    clinicId,
    keyHash: legacy.keyHash || null,
    createdAt: legacy.createdAt || nowIso,
    updatedAt: legacy.updatedAt || nowIso,
  };

  const writes = [store.put(sectionKey(clinicId, 'meta'), meta)];
  if (legacy.profile) {
    writes.push(store.put(sectionKey(clinicId, 'profile'), legacy.profile));
  }
  if (legacy.facebook) {
    writes.push(store.put(sectionKey(clinicId, 'facebook'), legacy.facebook));
  }
  if (legacy.google) {
    writes.push(store.put(sectionKey(clinicId, 'google'), legacy.google));
  }
  if (legacy.telegram) {
    writes.push(store.put(sectionKey(clinicId, 'telegram'), legacy.telegram));
  }

  await Promise.all(writes);
  await store.del(legacyKey(clinicId));

  return {
    clinicId,
    meta,
    profile: legacy.profile || null,
    facebook: legacy.facebook || null,
    google: legacy.google || null,
    telegram: legacy.telegram || null,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

async function getClinic(store, clinicId) {
  if (!store || !clinicId) return null;

  const [meta, profile, facebook, google, telegram] = await Promise.all(
    SECTIONS.map((sec) => store.get(sectionKey(clinicId, sec)))
  );

  if (!meta && !profile && !facebook && !google && !telegram) {
    return migrateLegacyClinicIfNeeded(store, clinicId);
  }

  return {
    clinicId,
    meta: meta || null,
    profile: profile || null,
    facebook: facebook || null,
    google: google || null,
    telegram: telegram || null,
    createdAt: (meta && meta.createdAt) || null,
    updatedAt: (meta && meta.updatedAt) || null,
  };
}

async function getClinicSection(store, clinicId, section) {
  if (!store || !clinicId || !SECTIONS.includes(section)) return null;
  let value = await store.get(sectionKey(clinicId, section));
  if (value !== null) {
    return value;
  }
  const migrated = await migrateLegacyClinicIfNeeded(store, clinicId);
  return migrated ? migrated[section] || null : null;
}

async function saveClinicSection(store, clinicId, section, data) {
  if (!store || !clinicId || !SECTIONS.includes(section)) {
    throw new Error(`Invalid clinic section write: ${section}`);
  }
  await migrateLegacyClinicIfNeeded(store, clinicId);
  await store.put(sectionKey(clinicId, section), data);
  return data;
}

// Google identity index: maps a Google account (userinfo `sub`) to the clinic
// record that account owns, so a returning clinic that logs in with Google
// lands on its existing record instead of a fresh anonymous one.
function googleSubIndexKey(sub) {
  return `clinicByGoogleSub:${sub}`;
}

async function getClinicIdByGoogleSub(store, sub) {
  if (!store || !sub) return null;
  const record = await store.get(googleSubIndexKey(String(sub)));
  return record && record.clinicId ? record.clinicId : null;
}

async function bindGoogleSub(store, sub, clinicId) {
  if (!store || !sub || !clinicId) return;
  await store.put(googleSubIndexKey(String(sub)), { clinicId });
}

async function unbindGoogleSub(store, sub, clinicId) {
  if (!store || !sub) return;
  const record = await store.get(googleSubIndexKey(String(sub)));
  if (record && record.clinicId === clinicId) {
    await store.del(googleSubIndexKey(String(sub)));
  }
}

module.exports = {
  SECTIONS,
  sectionKey,
  googleSubIndexKey,
  getClinic,
  getClinicSection,
  saveClinicSection,
  migrateLegacyClinicIfNeeded,
  getClinicIdByGoogleSub,
  bindGoogleSub,
  unbindGoogleSub,
};
