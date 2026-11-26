// ClinicFlow Connect: Firebase web configuration.
// GT-139 FL139-08. These values are public identifiers, not secrets.
// This stays null until the ClinicFlow Firebase project exists and its
// web app is registered. The exact remaining setup steps are recorded
// in the GT-20261126-139 builder report. While this is null, the login
// buttons keep using the existing Google sign-in flow, unchanged.
// When the project exists, replace null with the web app config object:
// { apiKey, authDomain, projectId, appId } from the Firebase console.
window.CF_FIREBASE_CONFIG = null;
