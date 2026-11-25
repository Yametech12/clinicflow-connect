# ClinicFlow Connect v1

The connect website and multi-tenant serverless engine for ClinicFlow PH, the
Messenger front desk for Philippine dental clinics. The public landing page
(`/`) explains the offer and runs the sample demo; the client area lives at
`/dashboard` behind Google login. A clinic owner logs in with Google (the
same Google connect the product needs anyway), fills in their clinic
profile, and links their own Facebook Page, Google account (Sheet +
Calendar), and Telegram chat. Nothing pretends to work when credentials or
storage are missing: unconfigured steps honestly report pending setup in
plain language.

## Architecture

Two sides, kept separate on purpose:

- Central bridge apps (ours, one time): one Meta app and one Google OAuth
  client, registered by the service owner, plus one Telegram bot, one Gemini
  API key, and one HTTPS key-value store. Their IDs and secrets live only in
  server environment variables. Clinics never see them and never need their
  own developer accounts.
- Client assets (the clinic's, always): the clinic Facebook Page, the clinic
  Google account with its Sheet and Calendar, and the clinic Telegram chat.
  Clinics sign in with their own accounts through the connect buttons. If a
  clinic stops paying, their Page, data, and calendar stay theirs.

Flow once wired: patient messages the clinic Page -> Meta signs and sends the
event to `api/webhook.js` -> webhook verifies `X-Hub-Signature-256` -> the
pipeline looks up the Page's clinic record -> loads `FAQ_Prices` (capped at
100 rows / ~6000 chars) from that clinic's Google Sheet -> calls the Gemini API
via `x-goog-api-key` header for a warm Taglish reply (max 3 sentences) ->
collects full name, valid Philippine mobile number, and preferred schedule ->
when all 3 are valid, writes the Google Calendar event and/or `Leads_Bookings`
row, marks the 10-min re-booking guard only after a record succeeds, sends the
Messenger reply before non-essential logging, and sends a Telegram alert to the
clinic's linked chat ID.

## Storage choice (`api/_store.js` & `api/_clinic.js`)

Vercel functions have no persistent filesystem. `api/_store.js` uses an
**HTTPS key-value store (Upstash Redis / Vercel KV REST API)** behind a clean
`get` / `put` / `putIfAbsent` / `del` interface, requiring zero new paid
services (Upstash free tier) and zero npm dependencies (uses Node built-in
`fetch`).

- Production env vars: `KV_REST_API_URL` and `KV_REST_API_TOKEN` (also
  accepts `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`).
- Local offline testing option: set `CLINICFLOW_LOCAL_STORE_FILE` (e.g.
  `.local-store.json`) to store entries in a local JSON file with TTL support
  when not running on Vercel.
- Per-section clinic keys (`api/_clinic.js`) prevent concurrent writers from
  clobbering each other (migrating legacy `clinic:<id>` records on first read):
  - `clinic:<clinicId>:meta`: `keyHash` (SHA256 of `cf_key` cookie), timestamps.
  - `clinic:<clinicId>:profile`: name, address, hours, timezone.
  - `clinic:<clinicId>:facebook`: Page ID, Page name, Page token, subscription.
  - `clinic:<clinicId>:google`: email, Google account `googleSub`, access
    token, refresh token, Sheet ID.
  - `clinic:<clinicId>:telegram`: chat ID, username, first name.
- Lookup, safety, and state keys:
  - `clinicByGoogleSub:<sub>`: `{ clinicId }` login identity index. On Google
    login the callback looks the account up here: a hit adopts that clinic
    record (session cookies switch to it, write key rotated); a miss binds
    the account to the clinic carried by the OAuth state.
  - `fb_page:<pageId>`: `{ clinicId }` lookup index for incoming webhooks.
  - `fb_pending:<selectionToken>`: 10-min temporary Page list for multi-Page accounts.
  - `state:<nonce>`: 30-min single-use OAuth state marker.
  - `tg_code:<code>` (10-min TTL, created with `putIfAbsent`) and `tg_fail:<chatId>`
    (15-min brute-force backoff after 5 invalid code guesses).
  - `msg_dedup:<pageId>:<mid>` (5-min TTL, released on exception), `booked:<pageId>:<senderId>`
    (10-min TTL, written only after Calendar/Sheet success), `hist:<pageId>:<senderId>`
    (30-min TTL, max 6 messages), and `dead:<pageId>:<mid>` (24-hr dead-letter record).

## Security model (GT-136)

The `cf_clinic` cookie is only an identifier; the `cf_key` cookie is the
write credential, and its SHA256 hash (`keyHash` on the `:meta` section) is
the server-side proof. Since GT-136:

- **Keys bind only inside OAuth callbacks** (`ensureMetaRecordOnCallback`).
  Read paths (`GET /api/clinic`, session ensure) never issue a key, so a
  legacy keyless record can no longer be claimed by whoever presents its id.
- **Connect endpoints require key proof**: when a record has a `keyHash`,
  `GET /api/connect/{google,facebook,telegram}` returns 403
  `INVALID_SESSION` unless the request presents a matching `cf_key`. The
  same proof is required by `GET /api/bookings` on top of the Google-bound
  check.
- **OAuth callbacks verify ownership before storing tokens**: the Google
  callback binds only on a genuine first bind, a record already bound to
  the signing-in account, or a request presenting the record's key
  (adoption through the `clinicByGoogleSub` index is exempt, because that
  binding could only have been created through this same gate). The
  Facebook callback applies the same check, and multi-Page selection
  completes by POST only, bound to the initiating session through the
  `keyHash` stored in the `fb_pending` record.
- **Adoption never moves the Facebook section** (a Page connection stays
  with the record that made it, and the `fb_page` index is never repointed
  by adoption); profile and Telegram carry over only when the source
  clinic is not itself bound to a different Google account.
- **Logout rotates the key server-side** (`POST` or `GET /api/logout`), so
  a captured cookie pair dies with the session, not just the browser copy.
- **Google account switches are clean**: the stored Sheet pointer is
  cleared and re-provisioned under the new account, a userinfo failure
  surfaces an error page instead of a silent success, and the
  `clinicByGoogleSub` index is verified against the record on every read
  (self-healing on disagreement).
- **Response headers** (`vercel.json`): a CSP tuned to zero external
  origins plus `nosniff`, `X-Frame-Options: DENY`, referrer and
  permissions policies on all routes; `/api/*` responses are
  `Cache-Control: private, no-store` with `X-Robots-Tag: noindex`, and the
  dashboard carries a `noindex` robots meta plus header. Webhook verify
  tokens and the Telegram webhook secret are compared in constant time.

## Files

- `index.html`: public landing page. Hero, live front-end sample price demo,
  how-it-works sequence, pilot pricing strip, and Log in / Start a pilot
  buttons that start the Google sign in flow. No clinic data lives here;
  arriving with `?login=1` shows the login prompt banner.
- `dashboard.html`: the client area at `/dashboard` (served via `cleanUrls`).
  A loading shell (brand, skeleton, pulsing pill) shows from first paint;
  the client area stays hidden until `GET /api/clinic` reports
  `logged_in: true` (a clinic session bound to a Google account), a failed
  check offers an inline retry in the shell, and a not-logged-in check
  redirects to `/?login=1`. Contains the sticky 4-step progress bar (its
  segments are section anchors), signed-in email and Log out (POST),
  clinic profile form, the three connect cards with safety lines
  and pills, return banners, pilot state line, connection status box, and
  the Recent bookings panel fed by `api/bookings.js`.
- `api/_store.js`: swappable KV storage layer (`get`, `put`, `putIfAbsent`,
  `del`, `isConfigured`, `getBackendInfo`).
- `api/_clinic.js`: per-section clinic read/write helpers, legacy migration,
  and the `clinicByGoogleSub:<sub>` login identity index helpers.
- `api/_session.js`: `cf_clinic` + `cf_key` HttpOnly cookies, HMAC-signed
  single-use OAuth `state`, `PUBLIC_BASE_URL` origin pinning, correlation-ID
  server error logging, and response helpers.
- `api/_google.js`: Google OAuth code exchange + section-safe `refresh_token`
  renewal, userinfo (`email` + `sub`) for login identity, Sheet provisioning
  (`FAQ_Prices`, `Leads_Bookings`, `System_Logs`), capped FAQ loader, lead row
  writer, read-only recent-bookings reader, and Calendar event creation.
- `api/_pipeline.js`: message pipeline ported from `../clinicflow/Code.gs`.
- `api/health.js`: GET. Publicly returns `{ status: "ok" }`. Detailed env-var
  booleans require `x-admin-probe` header matching `ADMIN_PROBE_TOKEN`.
- `api/clinic.js`: GET/POST. Cookie-authenticated clinic profile and connection
  summary (redacts `email` and `spreadsheet_url` if `cf_key` is absent; rejects
  POST without valid `cf_key` with 403). GET also reports `logged_in` (the
  clinic record is bound to a Google account) and `connections.google.bound`.
- `api/bookings.js`: GET. Recent bookings for the dashboard: requires a
  Google-bound clinic session with `cf_key` proof (401 `login_required`
  otherwise), reads the last 10 `Leads_Bookings` rows (read range bounded
  at row 5001) from the clinic's own Sheet with its stored Google
  credentials (refreshing when needed), and reports honest `ok`,
  `no_sheet`, or `google_unavailable` states. Read-only.
- `api/logout.js`: GET or POST. Rotates the record's `keyHash` server-side
  (invalidating the presented key), expires the `cf_clinic` and `cf_key`
  cookies, and redirects to `/`.
- `api/connect/facebook.js`, `api/connect/google.js`, `api/connect/telegram.js`:
  connect starters returning signed OAuth URLs or deep links (`https://t.me/<bot>?start=<code>`).
  The Google starter requests `openid` plus `userinfo.email`/`userinfo.profile`
  on top of the Sheets and Calendar scopes, so the same flow is the login.
- `api/callback/facebook.js`, `api/callback/google.js`: real OAuth callbacks
  with single-use state enforcement and correlation-ID error pages. Both
  redirect to `/dashboard` on success. The Google callback captures the
  userinfo `sub`, binds or adopts the clinic record for that Google account
  (see the `clinicByGoogleSub:<sub>` index above), then provisions the Sheet
  on the effective record.
- `api/webhook.js`: disables `bodyParser`, verifies Meta `X-Hub-Signature-256`
  over raw bytes (403 fail-closed when `META_APP_SECRET` is set), handles Meta
  GET verification, processes Messenger events, and handles Telegram `/start`
  linking (enforcing `TELEGRAM_WEBHOOK_SECRET` when set).
- `robots.txt`, `sitemap.xml`: crawl control (dashboard and `/api/` are
  disallowed; the sitemap lists only the landing).
- `og-image.png` (1200x630 share card), `favicon.svg`, `favicon.ico`,
  `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`,
  `manifest.webmanifest` (installable dashboard, `start_url: /dashboard`):
  brand assets generated from the teal chat-bubble mark.
- `vercel.json` (cleanUrls plus the header sets described in the security
  model), `.env.example`, `TESTING.md`.

No external npm dependencies. Functions use only Node 18+ built-ins
(`fetch`, `URLSearchParams`, `crypto`, `Intl.DateTimeFormat`).

## Setup and deploy steps

1. Configure environment variables from `.env.example` in Vercel:
   - Core providers: `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`,
     `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`,
     `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`.
   - Storage & security: `KV_REST_API_URL`, `KV_REST_API_TOKEN`,
     `PUBLIC_BASE_URL` (your production origin), `ADMIN_PROBE_TOKEN`,
     `TELEGRAM_WEBHOOK_SECRET`, optional `GEMINI_MODEL` (defaults to
     `gemini-3.5-flash-lite`).
2. Deploy with `vercel --prod`.
3. Register the deployed callback and webhook URLs:
   - Meta OAuth redirect URI: `https://YOUR-DOMAIN/api/callback/facebook`
   - Meta Webhook callback URL: `https://YOUR-DOMAIN/api/webhook` (with
     `META_VERIFY_TOKEN`, subscribed to `messages` and `messaging_postbacks`)
   - Google OAuth redirect URI: `https://YOUR-DOMAIN/api/callback/google`
   - Telegram Bot webhook (one-time call with `secret_token`):
     `curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://YOUR-DOMAIN/api/webhook&secret_token=$TELEGRAM_WEBHOOK_SECRET"`

## Local test

See [TESTING.md](./TESTING.md) for the local verification checklist and what
requires live provider accounts to verify end-to-end.
