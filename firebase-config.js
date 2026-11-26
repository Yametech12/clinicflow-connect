// ClinicFlow Connect: Firebase web configuration.
// GT-139 FL139-08 prepared the flow; GT-140 S5b fills the config now
// that the Firebase project exists (project "ClinicFlow Connect",
// clinicflow-connect-515810, web app "ClinicFlow Web"). These values are
// public identifiers, not secrets. With this config present, the login
// buttons use Firebase Authentication (Google provider, redirect flow)
// and the legacy Google sign-in flow remains in the pages as the
// fallback path; it is not retired by this change.
window.CF_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDfmZBYNlKkQUaXM5yOo-Ds9F5yx5ai_fE",
  authDomain: "clinicflow-connect-515810.firebaseapp.com",
  projectId: "clinicflow-connect-515810",
  storageBucket: "clinicflow-connect-515810.firebasestorage.app",
  messagingSenderId: "529154901919",
  appId: "1:529154901919:web:be5471b102ce6c3b2ddfaa"
};
