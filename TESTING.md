# ClinicFlow Connect — Local Testing & Live Verification Guide

## 1. Local Checks Run

All syntax and local integration checks were executed after the final edit on Node `v24.22.1` (zero external dependencies).

### Syntax verification (`node --check`)
Ran `node --check` on every `.js` file under `api/`:
- `api/_google.js` — PASS
- `api/_pipeline.js` — PASS
- `api/_session.js` — PASS
- `api/_store.js` — PASS
- `api/callback/facebook.js` — PASS
- `api/callback/google.js` — PASS
- `api/clinic.js` — PASS
- `api/connect/facebook.js` — PASS
- `api/connect/google.js` — PASS
- `api/connect/telegram.js` — PASS
- `api/health.js` — PASS
- `api/webhook.js` — PASS

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
