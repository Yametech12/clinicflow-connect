# ClinicFlow Connect improvement brief (GT-20261125-134)

You already built v1 in this workspace. Three Ghostname Team audits (design, QA, copy) reviewed v1 in code and live. Implement the fixes below. Full audit reports, including a paste-ready copy deck, are at:
- ~/workspace/ghostname-team/jobs/GT-20261125-134-reports/qa.md
- ~/workspace/ghostname-team/jobs/GT-20261125-134-reports/design.md
- ~/workspace/ghostname-team/jobs/GT-20261125-134-reports/copy.md

Read all three before editing. Where this brief and a report disagree, this brief wins. Hard rules: zero new npm dependencies; no em dash character anywhere in user-facing text or code comments you add; secrets only from env; do NOT deploy; run node --check on every file you touch and update TESTING.md with the new tests.

## Part A: Security and correctness (from QA report)

1. C1 (Critical): Enforce Meta webhook signatures. In api/webhook.js add module.exports.config = { api: { bodyParser: false } }, read the raw body yourself, verify X-Hub-Signature-256 as HMAC SHA256 over the raw bytes with META_APP_SECRET, fail closed with 403 when the secret is set and the signature is missing or wrong. Parse JSON manually after verification; unparseable payloads get a logged 200 (ignored), not a crash. Keep GET verification unchanged.
2. M2: Booking success semantics must match Code.gs. In api/_pipeline.js, acquire the 10-minute booked guard only AFTER at least the Calendar event or the Sheet lead row succeeds. If no record was written, replace the outgoing reply with an honest fallback (staff will confirm by text), write an ERROR row to System_Logs, send a Telegram operator alert if a chat is linked, and keep conversation history.
3. M3: On any processing exception, delete the msg_dedup key so Meta retries can reprocess, and write a visible failure record (System_Logs ERROR row when Google is available, else a KV dead-letter key dead:<pageId>:<mid> with the error and 24h TTL).
4. M4: Clinic identity lockdown. Stop honoring ?clinic_id= as session identity outside the OAuth callbacks. At clinic creation also set a random cf_key HttpOnly cookie and store its SHA256 hash on the clinic record; POST /api/clinic must verify it (403 without). Redact google email and spreadsheet_url from GET /api/clinic responses when the cf_key cookie is absent.
5. M5: Split the clinic record into per-section keys (clinic:<id>:profile, :facebook, :google, :telegram) with a read helper that assembles the existing summary shape, so concurrent writers cannot clobber each other. Migrate on read: if only the old clinic:<id> key exists, split it on first access. All existing callers keep working through the helper.
6. M6 (minimum variant, no new dependencies): In processMessengerEvent, send the Messenger reply BEFORE the System_Logs append and other non-essential writes. Do not add @vercel/functions.
7. m1: Callers never see raw upstream error text. Log full errors server-side with a short correlation ID; user-facing pages and JSON show a generic message plus that ID.
8. m2: Remove temperature from the Gemini generationConfig in api/_pipeline.js.
9. m3: Telegram linking: store codes with putIfAbsent and regenerate on collision; count failed code attempts per chat ID in KV and back off after 5; when a clinic re-links to a new chat, send a notice to the old chat that alerts moved.
10. m4: OAuth state: reject timestamps more than 2 minutes in the future; store state:<nonce> with putIfAbsent at callback time so each state is single-use (second use returns 400).
11. m5: /api/health returns only { status: "ok" } publicly. The detailed configured map requires an x-admin-probe header equal to a new env ADMIN_PROBE_TOKEN (if that env is unset, no detailed view at all).
12. m7: Cap FAQ loading at 100 rows and truncate the formatted price text at about 6000 characters with a truncation note in the prompt.
13. m8: Send the Gemini key in the x-goog-api-key header, not as a URL query parameter.
14. m9: Pin the canonical origin with a new env PUBLIC_BASE_URL used for all OAuth redirect_uri construction; fall back to the request origin only when the env is unset.
15. m10: Validate the booking mobile against ^(\+63|0)9\d{9}$ after stripping spaces and dashes; an invalid mobile makes the booking incomplete so the patient is asked again, with no Calendar or Sheet writes.
16. Telegram secret (code side only): the existing TELEGRAM_WEBHOOK_SECRET enforcement stays; nothing to change. The parent will set the env and re-register the webhook after deploy.

## Part B: Design and page mechanism (from design report)

1. C1 demo panel: Add a self-contained demo panel between the hero and the clinic profile section. A phone-shaped chat mock with a scripted exchange (patient asks "Pila ang cleaning?", the bot answers with a price), an editable Cleaning price field prefilled with a sample value, and an "Ask again" button. Pure front-end JavaScript with a small sample price table; editing the price and asking again re-renders the bot bubble with the new price. Label it honestly as a sample demo with sample prices. No backend calls.
2. C2 progress: Add a slim sticky progress bar at the top of the wrap: four labeled segments (Profile, Facebook, Google, Telegram) filled when complete, plus a count label like "2 of 4 done", driven by the existing render state.
3. M1: Restyle the "how it works" strip as a horizontal numbered sequence (single bordered block, large Georgia numerals, thin vertical separators on desktop, vertical list on mobile) so only one three-column card grid remains.
4. M2 dark scheme: Add a prefers-color-scheme dark block remapping the CSS variables per the design report (paper #141a17, card #1d2420, ink #ece8dd, muted #9aa79f, line #333d38, teal lightened #2dd4bf, darkened pill backgrounds), and make input backgrounds use var(--card).
5. M3: All buttons min-height 48px with flex centering; at least 8px vertical gaps between stacked interactive elements on mobile.
6. M4: One primary hero button under the lede anchoring to the profile section; add id="profile" and id="connect" anchors with scroll-margin-top.
7. M5: Reduce the bottom status panel to the copy deck's status section (completion line, progress line, one row per connection with a colored state dot). Cards remain the single source of detailed status.
8. M6: Wrap the /api/health and /api/clinic fetches in an 8000ms AbortController timeout routed to the existing unavailable state; add a gentle pulse on pills while checking, respecting prefers-reduced-motion.
9. M7: Unify all responsive breakpoints at 820px.
10. Minors: theme-color meta and an inline SVG favicon plus basic Open Graph tags; :focus-visible outlines on buttons; input font-size 16px; reserve the Telegram code box space at rest (visibility hidden, fixed min-height) so the card does not jump.

## Part C: Copy (from copy report, paste-ready)

Apply the copy deck in Part 2 of copy.md word for word: header top note, hero (headline, lede), how-it-works texts, profile section (sub, labels, placeholder, form notes), connect intro plus the "Connect all three" line, per-card body, safety lines, buttons, pill states, card messages, the new pilot strip section (exact prices ₱5,500 pilot, ₱12,000 regular), the connection status section texts, the return banners, the callback status page texts (Part 1, M4 replacements), and the footer trust line. Specifically:
1. Return banners: on page load read the connected URL parameter (and sheet_warning) and show the matching banner from the deck at the top of the connect section.
2. Connect endpoints (api/connect/*.js): replace every setup_pending and storage_pending message with the deck's plain-language replacements. No env var names in any user-facing string anywhere (page, endpoints, callbacks).
3. Callbacks: replace headings and messages with the M4 replacements; stop passing raw error text (aligns with QA m1); the Page picker gains the safety line from m4 of the copy report.
4. api/_session.js: the status page tab title joins with a colon, not an em dash.
5. api/clinic.js: replace the invalid Sheet message with the deck's replacement.

## Finish

- node --check every touched file; grep the repo for env var names appearing in user-facing strings and for the em dash character; both must be clean.
- Extend your local mocked test harness for the new behaviors (signature 403 and 200 paths, booking fallback, dedup release, state single-use, mobile validation, section-key merge) and record results in TESTING.md.
- Final summary: files changed, which brief items shipped, any item you could not implement and why, test results, and the new env vars (PUBLIC_BASE_URL, ADMIN_PROBE_TOKEN) the parent must set.
