# GT-136 Improvement Brief: fix ALL errors (owner: full force, fix all, anti-slop)

Sources: ~/workspace/ghostname-team/jobs/GT-20261125-136-reports/{qa,design,copy,perf}.md
Totals: QA C1 M2 m8; Design C1 M6 m10; Copy C3 M7 m6; Perf C0 M4 m8.
Rule: implement EVERY Critical, Major, and Minor in the four reports unless this brief says otherwise. Anything you cannot implement goes in your completion record with the reason. Paste-ready texts in the reports are used word for word. No new npm dependencies. No em dashes. All 24 existing tests keep passing; add the new cases named below.

## PART A: QA/security (do first, in this order)

A1. (C1) Enforce cf_key proof in api/connect/google.js, api/connect/facebook.js, api/connect/telegram.js: when the session clinic pre-existed and session.hasValidKey is false, return 403 with the deck-style plain message. Gate the Google callback: token storage and bindGoogleSub only when the caller owns the state clinic's key OR it is a genuine first bind (record has no keyHash and no googleSub yet). Same ownership gate on the Facebook callback token storage.
A2. (M1) api/bookings.js: verify cf_key against the record keyHash before reading the Sheet; id-only cookie on a bound clinic returns 401. Add the missing test.
A3. (M2) Remove the first-touch key bind from GET /api/clinic (and any read path). Binding happens only inside OAuth callbacks per A1. Legacy keyHash-less clinics recover by logging in with Google.
A4. (m2) Logout rotates the record keyHash server-side; accept POST as well as GET.
A5. (m1) Adoption carry-over: drop the facebook section from carry-over entirely; skip ALL carry-over when the source clinic is bound to a different googleSub.
A6. (m3) Facebook Page selection: require POST (or a per-session nonce) and session binding; no token-in-URL GET completion.
A7. (m4) Bookings read: bound the Sheet range (e.g. read a capped tail range) instead of the entire Leads_Bookings range.
A8. (m5) Google account switch: when the callback's googleSub/email differs from the record's bound account, clear the stored spreadsheetId before provisioning; a userinfo failure must surface an honest error page (deck style), never a silent success redirect.
A9. (m7) Timing-safe comparison for the Telegram webhook secret and the Meta verify token (crypto.timingSafeEqual with length guard).
A10. (m8) bindGoogleSub: make index and record writes consistent (write record first, then index, and on lookup verify the record's googleSub matches the index; self-heal by rewriting the index from the record when they disagree).
New tests: id-only cookie gets 403 from all three connect endpoints; id-only cookie gets 401 from /api/bookings on a bound clinic; GET /api/clinic never binds a key; logout rotation invalidates the old key; adoption does not move a facebook section; account switch clears spreadsheetId.

## PART B: Performance/SEO/technical (paste-ready in perf.md)

B1. Security headers via vercel.json exactly as specified in perf.md (CSP tuned to zero external origins, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy), plus /api/(.*) Cache-Control: private, no-store and X-Robots-Tag: noindex.
B2. robots.txt and sitemap.xml as specified; dashboard gets noindex meta + X-Robots-Tag header.
B3. Social sharing: full og/Twitter tag block from perf.md + copy.md M7 preview wording; generate og-image.png 1200x630 with Python PIL: cream background matching the site palette, ink serif headline "Reply to every patient in seconds." plus a teal accent rule and "ClinicFlow PH" wordmark; typographic only, no stock imagery, no gradients. Verify the file renders (open it) before shipping.
B4. Semantics: add <main> landmarks both pages, dashboard h1, landing how-it-works titles become real headings, canonical link, meta description per perf.md.
B5. Perf minors: favicon files (favicon.ico/png + apple-touch-icon, generate simple ink "C" glyph via PIL), JSON-LD per perf.md if specified, CLS fixes for login banner and demo bubble (reserve space), dashboard status changes wrapped in aria-live regions, amber contrast pair nudged to pass AA with margin.

## PART C: Design (within current language; the named direction is NOT in this brief)

C1. (Critical) Dashboard loading shell: visible branded shell (wordmark + skeleton lines + "Loading your dashboard") outside #dashWrap from first paint; gate failure shows an inline retry state, never a silent bounce to the login banner on a transient error. Distinguish "not logged in" (redirect) from "could not check" (retry).
C2. (M1 + Copy M4) Demo becomes the full three-beat loop, front-end only, sample-labeled: (1) price quote with the editable price, (2) bot collects name/mobile/schedule with sample patient replies, (3) booking lands: a row appears in the mini sheet AND a Telegram alert mock slides in. Beats advance by button/step clicks; keep it compact.
C3. (M2) Demo proof moment: green flash highlight on the bot bubble and sheet cell when the price changes; re-render on input (debounced) and on Enter.
C4. (M3) Pilot price as display type: ₱5,500 at 34px Georgia in a two-column pilot box, "Regular setup ₱12,000" as its own line, on landing and dashboard (combine with Part D pilot copy).
C5. (M4) Mobile order: demo section above the how-it-works sequence on small screens.
C6. (M5) Dark mode --rule token: rules/frames keep an ink-toned rule color in dark instead of flipping to near-white glow.
C7. (M6) Trust row near the hero CTA and the pilot CTA: three checkmark items using only existing true claims (accounts stay yours; prices only from your sheet; disconnect anytime).
C8. Minors: button hover/active transitions, login button busy label, favicon glyph also in headers as brand mark, mobile header wrap fix, login banner contrast bump, dashboard progress segments become anchor links to their cards, bookings loading/empty/error states visually distinct (skeleton rows, empty illustration-free state, error with retry).

## PART D: Copy/conversion (paste-ready in copy.md)

D1. (C1) Pilot payment clarity: pilot box gains the payment paragraph (connecting is free and starts no payment; pilot is 50 percent deposit via GCash, Maya, or InstaPay, balance at the live walkthrough) and button microcopy "Free to log in and connect. You pay only when you confirm your pilot." Use copy.md's full version (deposit terms ARE published; they are the lane's recorded terms).
D2. (C2) Full pilot box replacement from copy.md: deliverables list, 3-day setup, prices, what she provides.
D3. (C3) Contact path, PARENT ADJUDICATION: there is no ClinicFlow PH Facebook Page yet, so use copy.md's reply-based variant only ("Questions first? Reply to the message that sent you this link..."). Do NOT invent a Page name or URL. Dashboard footer help line uses the same reply-based wording.
D4. (M6) All-connected pilot line, PARENT ADJUDICATION on the differentiator: self-connect stays free to try; the paid pilot is done-for-you (we load her full real price list, configure her real profile, test end to end on her real Page, and do the live walkthrough). Use copy.md's replacement line; if its wording conflicts with this adjudication, follow the adjudication and note the deviation.
D5. (M3) Hero microcopy line under Start a pilot with the ₱5,500 anchor + free-login reassurance (from copy.md).
D6. (M5) Dashboard welcome block for first-time clinics: the four steps in order, Facebook + Google named as the bot-on gate (from copy.md).
D7. (M1) Fix the stale landing pilot wording ("connected to your own accounts above" is wrong since the split; cards live on the dashboard).
D8. (M2) "Clinics like yours" fit line from copy.md (independent dental and aesthetic clinics, 1 to 3 branches; no invented clients).
D9. (M7) Title/og preview copy from copy.md (also feeds B3).
D10. Minors: remove "Sprint 1" jargon for visitors (keep it only where copy.md allows), closing CTA at the page foot, Taglish warmth edits, all per copy.md.

## Verification (builder)

- tests/run-tests.js: all previous tests + Part A new cases pass; report the count.
- node --check on api/ and tests/; both pages' inline scripts parse.
- Greps: em dash zero; env var names zero in user-facing strings; no "Sprint 1" on the landing.
- Local checks that headers/robots/sitemap/og files exist and are wired (vercel.json valid JSON).
- Update TESTING.md, README.md, and append the completion record to GT-20261125-136.md: items shipped by part, anything not implemented with reason, test results, risks.
- Do NOT commit or deploy.
