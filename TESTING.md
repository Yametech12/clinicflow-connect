# ClinicFlow Connect: Local Testing & Live Verification Guide

## 1. Local Checks Run

All syntax and local integration checks were executed after the final edit on Node `v24.22.1` (zero external dependencies).

### Syntax verification (`node --check`)
Ran `node --check` on every `.js` file under `api/`:
- `api/_google.js`: PASS
- `api/_pipeline.js`: PASS
- `api/_session.js`: PASS
- `api/_store.js`: PASS
- `api/callback/facebook.js`: PASS
- `api/callback/google.js`: PASS
- `api/clinic.js`: PASS
- `api/connect/facebook.js`: PASS
- `api/connect/google.js`: PASS
- `api/connect/telegram.js`: PASS
- `api/health.js`: PASS
- `api/webhook.js`: PASS

Also validated the inline `<script>` block inside `index.html` using Node's `vm.Script`.

### Local functional flows tested (with mocked `fetch` / HTTP handlers)

1. **Unconfigured / honest degraded state (zero env vars)**
   - `GET /api/health` returns `200` with `{ "status": "ok" }` only (GT-134: the detailed `configured.*` map now requires the `x-admin-probe` header matching `ADMIN_PROBE_TOKEN`; with it, the booleans show `false` and `storage_backend: "unconfigured"`).
   - `GET /api/clinic` returns `200` with `status: "storage_pending"` and sets `cf_clinic` + `cf_key` session cookies.
   - `POST /api/clinic` returns `503` `setup_pending`.
   - `GET /api/connect/facebook`, `GET /api/connect/google`, `GET /api/connect/telegram` each return `200` with `status: "setup_pending"` and a plain-language message (no environment variable names are shown to visitors).
   - `GET /api/callback/facebook`, `GET /api/callback/google`, and `GET /api/webhook` return `503` `setup_pending`.

2. **Storage layer (`api/_store.js`)**
   - Verified Upstash/Vercel KV HTTPS REST commands (`GET`, `SET ... EX`, `SET ... EX ... NX`, `DEL`) with `Authorization: Bearer ...` against a mocked KV endpoint.
   - Verified local JSON file storage (`CLINICFLOW_LOCAL_STORE_FILE`) with `put`, `get`, `putIfAbsent`, `del`, and TTL cleanup.

3. **Clinic profile (`api/clinic.js`)**
   - Tested saving clinic name, address, hours, and extracting spreadsheet IDs from full Google Sheets URLs.
   - Verified `GET /api/clinic` never exposes stored Facebook Page tokens or Google OAuth access/refresh tokens.

4. **Facebook OAuth (`api/connect/facebook.js` & `api/callback/facebook.js`)**
   - Verified signed HMAC `state` generation and rejection of tampered `state` (`400`).
   - Verified `code` -> short-lived user token -> long-lived user token (`fb_exchange_token`) -> `/me/accounts` flow.
   - Verified multi-Page HTML picker rendering (confirming Page `access_token` is never leaked into HTML) and `POST /api/callback/facebook` Page selection (`application/x-www-form-urlencoded`).
   - Verified Page webhook subscription (`POST /v21.0/{page_id}/subscribed_apps` with `messages,messaging_postbacks`), `clinic:<clinicId>` + `fb_page:<pageId>` storage, and `302` redirect to `/?connected=facebook`.

5. **Google OAuth & token refresh (`api/connect/google.js` & `api/callback/google.js`)**
   - Verified `access_type=offline`, `prompt=consent`, and signed `state`.
   - Verified `POST https://oauth2.googleapis.com/token` code exchange, `userinfo.email` fetch, automatic Google Sheet creation (`FAQ_Prices` with 8 sample dental services, `Leads_Bookings`, `System_Logs`), token storage, and `302` redirect to `/?connected=google`.
   - Verified expired access token renewal using stored `refresh_token`.

6. **Telegram deep linking (`api/connect/telegram.js` & `api/webhook.js`)**
   - Verified `GET /api/connect/telegram` stores `tg_code:<code>` with 600s TTL and returns `https://t.me/<bot>?start=<code>`.
   - Verified `POST /api/webhook` handles Telegram `/start <code>` updates, checks `X-Telegram-Bot-Api-Secret-Token` when `TELEGRAM_WEBHOOK_SECRET` is configured, links `chatId` onto the clinic record's `clinic:<clinicId>:telegram` section key, deletes the one-time code, and sends confirmation via Telegram `sendMessage`.
   - Verified invalid, expired, and reused codes are rejected cleanly.

7. **Webhook verification & Messenger AI pipeline (`api/webhook.js`)**
   - Verified `GET /api/webhook` returns exact `hub.challenge` (`200`) when `hub.verify_token` matches `META_VERIFY_TOKEN`, and `403` otherwise.
   - Verified `POST /api/webhook` ignores `is_echo` messages and deduplicates repeated `message.mid` deliveries.
   - Verified multi-turn FAQ inquiry -> loads `FAQ_Prices` from the clinic's Sheet, calls Gemini (`gemini-3.5-flash-lite` or `GEMINI_MODEL` override), saves conversation turn, and replies via the Page's stored token without creating premature bookings.
   - Verified incomplete-booking guard (`ready_to_book: true` without `mobile_number` does not trigger booking).
   - Verified confirmed booking (name + mobile + preferred schedule) creates a Google Calendar event (`Asia/Manila`), appends a row to `Leads_Bookings` (`valueInputOption=RAW`), sends a Telegram alert to the linked `chatId`, clears conversation history, and prevents duplicate re-booking for 10 minutes.
   - Verified `[VERIFY TIME]` Calendar fallback when `iso_start_time` is unparseable.
   - Verified real Node `http.createServer` socket request/response flow for `index.html`, `/api/health`, `/api/clinic`, `/api/connect/telegram`, and `/api/webhook`.

---

## 2. How to Run Local Tests Yourself

### Quick syntax check
```bash
for f in $(find api -name '*.js' | sort); do node --check "$f"; done
```

### Local interactive UI + local JSON storage (no Upstash account needed)
Copy `.env.example` to `.env`, set `CLINICFLOW_LOCAL_STORE_FILE=./.local-store.json` (plus any test tokens you have), and run:
```bash
vercel dev
```
Then open `http://localhost:3000`:
- Confirm status cards show `Storage setup pending` if `KV_REST_API_*` and `CLINICFLOW_LOCAL_STORE_FILE` are unset, and flip to `Not connected` once storage + central app env vars are present.
- Fill out the clinic profile and click **Save clinic profile**, then reload the page to verify persistence via `/api/clinic`.

---

## 3. What Still Needs Live Accounts & Production Setup to Verify

Mocked local runs cannot prove third-party provider credentials or live network integration. After setting production env vars and deploying (`vercel --prod`), verify these with real accounts:

1. **KV storage env vars (`KV_REST_API_URL`, `KV_REST_API_TOKEN`)**:
   - Provision a free Upstash Redis database (or Vercel Marketplace Upstash Redis), add `KV_REST_API_URL` and `KV_REST_API_TOKEN` in Vercel Project Settings, redeploy, and confirm `/api/health` returns `providers.storage: true`.
2. **Meta OAuth & Webhook (`META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`)**:
   - Confirm `https://YOUR-DOMAIN/api/callback/facebook` is in Valid OAuth Redirect URIs in the Meta App Dashboard.
   - Confirm `https://YOUR-DOMAIN/api/webhook` is registered and verified against `META_VERIFY_TOKEN` with `messages` and `messaging_postbacks` subscribed.
   - Click **Connect Facebook Page** on the live site with a real Facebook account that owns a Page, select the Page, confirm `/?connected=facebook` shows the Page connected, and verify `subscribed_apps` succeeds (note: external clinic Pages beyond app admins/testers require Meta App Review).
3. **Google OAuth, Sheets & Calendar (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)**:
   - Confirm `https://YOUR-DOMAIN/api/callback/google` is in Authorized Redirect URIs in Google Cloud Console (and Sheets + Calendar APIs are enabled on that GCP project).
   - Click **Connect Google**, grant Sheets + Calendar + email scopes, confirm `/?connected=google` shows the email and auto-created **Open clinic Google Sheet** link, and verify `FAQ_Prices`, `Leads_Bookings`, and `System_Logs` tabs appear.
4. **Telegram Bot Linking & Webhook (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, optional `TELEGRAM_WEBHOOK_SECRET`)**:
   - Register the bot webhook once:
     ```bash
     curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=https://YOUR-DOMAIN/api/webhook"
     ```
     (Add `&secret_token=${TELEGRAM_WEBHOOK_SECRET}` if configured.)
   - Click **Connect Telegram**, open the deep link (`https://t.me/<bot>?start=<code>`), tap **Start**, and verify the bot replies with the confirmation message and the web card flips to **Connected**.
5. **Live End-to-End Messenger Booking (`GEMINI_API_KEY`, optional `GEMINI_MODEL`)**:
   - Message the connected Facebook Page as a tester: ask for cleaning price (verify Taglish <= 3 sentences quoting `FAQ_Prices`), then send name, mobile, and preferred date/time.
   - Verify: Messenger confirmation reply arrives, a row lands in `Leads_Bookings`, an event appears on Google Calendar in `Asia/Manila`, and the Telegram alert lands in the linked chat.

---

## 4. GT-134 Improvement Pass Verification (Nov 25, 2026)

The improvement pass (brief `IMPROVEMENT_BRIEF_GT134.md`) was finished and verified by the Ghostname Team builder after the Antigravity run stopped mid-pass. Verification used a dedicated zero-dependency harness at `tests/run-tests.js`, which drives the real handlers with the in-memory store adapter (`api/_store.js` `_setAdapterForTests`) and a routed `fetch` mock. Run it with:

```bash
node tests/run-tests.js
```

Result on Nov 25, 2026: **19 of 19 tests passed.** Coverage:

- Webhook GET verification: correct token echoes the challenge (200), wrong token 403.
- Webhook signature enforcement (Part A.1): unsigned Meta POST with `META_APP_SECRET` set returns 403; bad signature 403; correctly signed event returns 200 `EVENT_RECEIVED` and produces a Messenger reply; the same flow works through the raw request-stream path; an unparseable body carrying a valid signature returns a logged 200 instead of crashing.
- Gemini call shape: API key is sent in the `x-goog-api-key` header (never in the URL) and `generationConfig` no longer sets `temperature`.
- Dedup (Part A.3): a duplicate `mid` is processed once; when Gemini returns HTTP 500 the dedup key is released, a `dead:<pageId>:<mid>` record is written, the webhook still acks 200, and a Meta retry of the same `mid` processes successfully after Gemini recovers.
- Booking semantics (Part A.2): with Calendar and Leads appends both mocked to fail, the patient receives the honest fallback reply (not the AI confirmation), the `booked:` guard is NOT set, an ERROR row append to `System_Logs` is attempted, and conversation history is kept. After the mocks recover, the same patient books successfully: Calendar event created, lead row appended, guard set, AI confirmation sent, history cleared.
- Mobile validation (Part A.15): `09171234567`, `+639171234567`, and a space-formatted number pass; `12345`, a landline, and empty fail; a `ready_to_book` payload with an invalid mobile triggers the re-ask reply with zero Calendar or Sheet writes.
- OAuth state (Part A.10): a correctly signed state dated 10 minutes in the future is rejected; a nonce can be consumed exactly once; the Google callback completes a full mocked round trip (302 to `/?connected=google`, tokens stored on the `:google` section) and replaying the same state returns 400.
- Per-section clinic keys (Part A.5): a legacy whole-record `clinic:<id>` migrates into section keys on first read and the legacy key is deleted; concurrent `:google` and `:telegram` section writes both survive, and the `:facebook` section is untouched.
- Clinic identity (Part A.4): `?clinic_id=` is ignored (a cookieless request gets a fresh session, not the target clinic's data); `POST /api/clinic` returns 403 with no cookies and with a wrong `cf_key`; the correct cookie pair saves (200). A legacy v1 session presenting only the `cf_clinic` cookie is issued a `cf_key` cookie on GET, is bound to the record's stored hash, sees its own sensitive fields, and can then save.
- Health (Part A.11): public `GET /api/health` returns exactly `{ "status": "ok" }`; the detailed map appears only with the correct `x-admin-probe` header.
- Telegram (Parts A.9, A.16): linking codes are issued via `putIfAbsent`; a webhook update with the wrong secret token returns 403; `/start <code>` links the chat; re-linking to a second chat sends the "alerts moved" notice to the old chat; five bad code guesses from one chat are rejected and the sixth is rate limited.
- FAQ cap (Part A.12): a mocked 250-row `FAQ_Prices` read returns at most 100 items with the truncation note in the prompt text.

Syntax and hygiene checks re-run after the final edits: `node --check` passes on every `.js` file under `api/` (including subfolders) and on `tests/run-tests.js`; the inline `<script>` in `index.html` parses under `vm.Script`; a repo-wide grep finds no em dash character; a grep for environment variable names across `index.html` and `api/` finds them only in `process.env` reads, code comments, internal error messages that are logged server-side with correlation refs, and the admin-probe-gated health map, never in visitor-facing strings.

Still only provable with live accounts (unchanged from section 3): a real Meta webhook delivery against the deployed function (confirm the platform honors the exported `bodyParser: false` config so `X-Hub-Signature-256` verification sees raw bytes), real Facebook and Google OAuth round trips, a live Gemini call with the production key, a phone `/start` against the production bot, and Upstash behavior under real latency.

---

## 5. GT-135 Landing/Login Split Verification (Nov 25, 2026)

The site is now split: `/` is a public landing page (hero, sample demo, how it works, pilot strip, Log in and Start a pilot buttons; no profile form, no connect cards, no status box), and the client area moved to `/dashboard` (static `dashboard.html`, served by the existing `cleanUrls` setup). Google sign in is now also the login: the Google OAuth scopes gained `openid` and `userinfo.profile`, the callback captures the userinfo `sub`, and clinic identity binds to the Google account through a `clinicByGoogleSub:<sub>` index key in `api/_clinic.js`.

Result on Nov 25, 2026: **24 of 24 tests passed** (`node tests/run-tests.js`; the 19 GT-134 tests plus 5 new ones):

- First Google login: the callback stores `googleSub` + email on the state clinic's `:google` section, writes the `clinicByGoogleSub:<sub>` index, and redirects to `/dashboard?connected=google` (sheet provisioning unchanged).
- Returning login adoption: with the index pointing at an existing record, a login whose OAuth state names a different (fresh) clinic adopts the bound record: tokens land on the adopted record, its own Sheet is kept, the state clinic gets no `:google` section, the session cookies switch to the adopted record with a rotated `cf_key`, and that issued key can immediately save the profile (200). Sections the browser-side clinic already had (profile, Facebook, Telegram) are carried over only when the adopted record lacks them, and the `fb_page:<pageId>` index is repointed when a Facebook section moves.
- Dashboard gate signals: `GET /api/bookings` returns 401 `login_required` with no session and for a Google-connected clinic that was never bound (no `googleSub`); `GET /api/clinic` reports `logged_in: false` and `connections.google.bound: false` until the sub is bound, then `true`. The dashboard page itself redirects to `/?login=1` on the same `logged_in` signal, and the landing shows the "Log in with Google to open your dashboard." banner for that parameter.
- Logout: `GET /api/logout` expires both `cf_clinic` and `cf_key` cookies (Max-Age=0) and redirects 302 to `/`.
- Recent bookings (`GET /api/bookings`, read-only): with a mocked sheet of 12 lead rows it returns the last 10, newest first, with the panel fields mapped (patient name, mobile, service, preferred datetime, status); an empty sheet returns `ok` with zero rows; a bound clinic with no Sheet returns `no_sheet`; a token refresh failure returns `google_unavailable` with zero rows (no invented bookings).

Page checks: the inline `<script>` blocks of both `index.html` and `dashboard.html` parse under `vm.Script`; a grep confirms the landing contains no profile form, connect cards, status box, or progress bar markup; `node --check` passes on every `.js` file under `api/` and `tests/`; the repo-wide em dash grep is clean; no environment variable names appear in either page or in any new user-facing string. `api/webhook.js` and `api/_pipeline.js` are byte-identical to GT-134 (no diff).

Still only provable live: that Vercel serves `dashboard.html` at `/dashboard` under `cleanUrls` (smoke after deploy), a real Google login round trip including the new `openid` scope on the consent screen, a real adoption from a second browser, and the Facebook callback landing on `/dashboard?connected=facebook` with a real Page.

## 6. GT-136 Full Force Pass Verification (Nov 25, 2026)

Security hardening (Part A), perf/SEO/headers (Part B), design (Part C), and copy (Part D) from the four GT-136 audit reports, adjudicated by `IMPROVEMENT_BRIEF_GT136.md`. Result: **33 of 33 tests passed** (`node tests/run-tests.js`; the 24 GT-135 tests, one of them revised, plus 9 new GT-136 cases). One deliberate test change: the GT-135 test 16 expectation that a legacy record binds a `cf_key` on `GET /api/clinic` is reversed by A3 (keys bind only inside OAuth callbacks now); the revised case is test 16b below.

New and revised cases:

- Connect gate (A1): an id-only `cf_clinic` cookie gets 403 `INVALID_SESSION` from `GET /api/connect/google`, `/api/connect/facebook`, and `/api/connect/telegram` (and no Telegram linking code is minted); the full cookie pair still works.
- Bookings gate (A2): on a Google-bound clinic, an id-only cookie and a wrong-key cookie both get 401 from `GET /api/bookings`; the valid pair reads bookings.
- GET never binds (A3, test 16b): a legacy keyless record read with only a `cf_clinic` cookie returns `authenticated: false`, redacted fields, no `cf_key` Set-Cookie, and still has no `keyHash` afterwards.
- Logout rotation (A4, extends test 23): `POST /api/logout` is accepted alongside GET; the record's `keyHash` rotates server-side, so the captured cookie pair afterwards gets 403 on `POST /api/clinic` and 401 on `GET /api/bookings`.
- Adoption safety (A5): adoption no longer carries the `facebook` section (the `fb_page:<pageId>` index keeps routing to the source clinic); profile and Telegram still carry over when the source clinic is unbound; when the source clinic is bound to a different Google account, carry-over is skipped entirely.
- Facebook selection (A6): completing a multi-Page selection by GET with the token in the URL is refused (400, nothing stored); a POST from a different session is refused (403); a POST from the initiating session connects the chosen Page (302 to `/dashboard?connected=facebook`).
- Bounded bookings read (A7): the outbound Sheets range is capped at `Leads_Bookings!A2:J5001`; a mocked 5000-row sheet still returns the newest 10.
- Google callback honesty (A8): a userinfo failure returns the 500 deck error page and stores nothing (no google section, no binding); a Google account switch clears the stored `spreadsheetId`/`spreadsheetUrl` so a fresh Sheet is provisioned under the new account, the old `sub` index is removed, and the new one points at the clinic.
- Google identity index (A10): `getClinicIdByGoogleSub` verifies the record's own `googleSub` against the index and self-heals (stale entry deleted, record's own entry restored, treated as unbound) on disagreement.

Static verification: `node --check` passes on every `.js` file under `api/` and `tests/`; both pages' inline scripts parse under `vm.Script`; `vercel.json` parses as JSON with three header entries (`/api/(.*)` cache + robots, `/dashboard` robots, `/(.*)` security set); the repo-wide em dash grep is clean (including the 13 pre-existing hits scrubbed from this file); no environment variable names appear in either page; "Sprint 1" no longer appears on the landing, the dashboard, or the JSON-LD. `og-image.png` (1200x630) was generated with PIL and visually verified by reading it back; favicon.ico, favicon.svg, apple-touch-icon.png, icon-192.png, and icon-512.png were generated from the existing teal chat-bubble mark.

Still only provable live (parent smoke after deploy): the CSP header set against the real pages (login redirect to Google is a top-level navigation and the OAuth JSON fetch is same-origin, so both should pass), the Facebook Page picker round trip with a real multi-Page account, an account-switch re-login against a real second Google account, and the dashboard loading shell on a slow connection.

## GT-137 design pass (Nov 25, 2026)

Side accent stripes removed (owner order): every `border-left` wider than 1px is gone from `index.html` and `dashboard.html`; the pilot boxes and welcome box now carry a 2px ink top rule, the bookings warning state is a tonal amber surface, and the connect cards lost their 4px teal top stripe for the same ink rule. The anti-AI-look pass squared the pill and progress shapes, turned the how-it-works row into a hairline ledger list, and raised the demo panel with an ink top rule and a raised phone column on desktop. Result: **34 of 34 tests passed** (the 33 GT-136 tests plus a new static design gate, test 20, which fails the suite if a `border-left` wider than 1px returns to either page). Copy, prices, and pilot terms unchanged; no wiring touched.

## Pro Max upgrade (Nov 26, 2026)

Branch `upgrade/pro-max`, no deploy. See [PRO_MAX.md](./PRO_MAX.md) for the
full audit. Result: **60 of 60 tests passed** (`node tests/run-tests.js`;
the 54 pre-existing tests plus 6 new pro max cases):

- Page token in the Messenger POST body, never in the request URL.
- Gemini and Messenger fetches carry a timeout signal (KV 10s, Google
  15s, Gemini 25s, Messenger and Telegram 15s, Firebase certs 10s).
- Oversize webhook stream body (over 1 MB) is ignored with a logged 200
  and zero pipeline runs; a 12-event batch completes all 12 replies under
  bounded concurrency (chunks of 5).
- Oversize clinic POST stream returns 413.
- Dashboard profile inputs carry maxlength matching the server caps.

Still only provable live (unchanged from section 3, plus): a Messenger
reply still arrives after the token-in-body change, and a slow Gemini call
fails fast instead of hanging the function.

## GT-139 FL139-08 Firebase login gates

`node tests/run-tests.js` covers the Firebase migration behind the
existing session contract: hand-rolled ID token verification (valid
token passes; expired, wrong audience, wrong issuer, and tampered
signature rejected, using a minted RS256 test token and an injected
certificate fetcher), the bridge at `POST /api/auth/firebase` (GET is
405, a bad token sets no cookies, a first login binds the cookie
clinic, a returning Google account adopts its bound clinic by sub
with a rotated key), the unchanged `/api/clinic` payload contract
(`authenticated` and `logged_in` agree in anonymous, legacy-bound,
and Firebase-bound states), and the page wiring (landing renders the
provider redirect flow and posts to the bridge, dashboard stays gated
on `logged_in`, `firebase-config.js` ships as a null placeholder with
no invented values).
