// ClinicFlow Connect: log out.
// Clears the clinic session cookies and returns the browser to the landing page.
const { clearClinicCookies, redirect } = require('./_session');

module.exports = async (req, res) => {
  clearClinicCookies(req, res);
  return redirect(res, '/');
};
