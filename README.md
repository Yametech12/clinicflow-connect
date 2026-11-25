# ClinicFlow Connect v1

The connect website and multi-tenant serverless engine for ClinicFlow PH, the
AI Messenger front desk for Philippine dental clinics. A clinic owner opens
this page, fills in their clinic profile, and links their own Facebook Page,
Google account (Sheet + Calendar), and Telegram chat. Nothing pretends to
work when credentials or storage are missing: unconfigured steps honestly
report `setup_pending` or `storage_pending`.

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

Flow once wired: patient messages the clinic Page -> Meta sends the event to
`api/webhook.js` -> the pipeline looks up the Page's clinic record -> loads
live `FAQ_Prices` from that clinic's Google Sheet -> calls the Gemini API for
a warm Taglish reply (max 3 sentences) -> collects full name, mobile number,
and preferred schedule -> when all 3 are present, appends the lead to
`Leads_Bookings`, creates a Google Calendar event, and sends a Telegram alert
to the clinic's linked chat ID.

## Storage choice (`api/_store.js`)

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
- Keys stored:
  - `clinic:<clinicId>`: profile, Facebook Page token, Google OAuth tokens +
    refresh token + spreadsheet ID, Telegram chat ID.
  - `fb_page:<pageId>`: `{ clinicId }` lookup index for incoming webhooks.
  - `fb_pending:<selectionToken>`: 10-min temporary Page list when a user
    manages multiple Facebook Pages.
  - `tg_code:<code>`: 10-min Telegram linking payload `{ clinicId }`.
  - `msg_dedup:<pageId>:<mid>` (5-min TTL), `booked:<pageId>:<senderId>`
    (10-min TTL), `hist:<pageId>:<senderId>` (30-min TTL, max 6 messages).

## Files

- `index.html`: landing and connect page. Plain static HTML, CSS, and JS.
  Reads real server state from `/api/health` and `/api/clinic` and saves the
  clinic profile to `/api/clinic` when storage is configured.
- `api/_store.js`: swappable KV storage layer (`get`, `put`, `putIfAbsent`,
  `del`, `isConfigured`, `getBackendInfo`).
- `api/_session.js`: clinic session cookie (`cf_clinic`), HMAC-signed OAuth
  `state`, origin detection, and response helpers.
- `api/_google.js`: Google OAuth code exchange + automatic `refresh_token`
  renewal, Sheet provisioning (`FAQ_Prices`, `Leads_Bookings`, `System_Logs`),
  FAQ loader, lead row writer, and Calendar event creation.
- `api/_pipeline.js`: message pipeline ported from `../clinicflow/Code.gs`
  (Taglish prompt, Gemini JSON call, booking guard, Messenger reply, Telegram
  alerts and `/start` linking handler).
- `api/health.js`: GET. Returns booleans only for configured env vars and
  provider readiness (values are never returned).
- `api/clinic.js`: GET/POST. Returns sanitized clinic status (no tokens) and
  saves clinic profile + optional existing Sheet URL/ID.
- `api/connect/facebook.js`: GET. Builds the signed Facebook Login OAuth URL.
- `api/callback/facebook.js`: GET/POST. Exchanges code -> user token ->
  long-lived user token -> `/me/accounts` Pages, renders a Page picker if the
  account manages multiple Pages, subscribes the chosen Page to the app
  (`messages,messaging_postbacks`), and stores the Page token.
- `api/connect/google.js`: GET. Builds the signed Google OAuth URL.
- `api/callback/google.js`: GET. Exchanges code for access + refresh tokens,
  fetches email, auto-creates a seeded clinic Sheet if none is linked yet,
  and stores the tokens.
- `api/connect/telegram.js`: GET. Generates a 6-character code, stores it for
  10 minutes, and returns a deep link `https://t.me/<bot>?start=<code>`.
- `api/webhook.js`: GET verifies Meta `META_VERIFY_TOKEN`; POST handles both
  Meta Messenger events (`object === 'page'`) and Telegram bot updates
  (`/start <code>` linking).
- `vercel.json`: serves the static page and the api functions together.
- `.env.example`: every variable, with where to get it.
- `TESTING.md`: local test verification log and live-account checklist.

No external npm dependencies. Functions use only Node 18+ built-ins
(`fetch`, `URLSearchParams`, `crypto`, `Intl.DateTimeFormat`).

## Setup and deploy steps

1. Configure environment variables from `.env.example` in Vercel:
   - Existing/central app vars: `META_APP_ID`, `META_APP_SECRET`,
     `META_VERIFY_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
     `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`.
   - New vars: `KV_REST_API_URL`, `KV_REST_API_TOKEN` (from Upstash Redis free
     tier / Vercel Marketplace), optional `GEMINI_MODEL` (defaults to
     `gemini-3.5-flash-lite`), optional `TELEGRAM_WEBHOOK_SECRET`.
2. Deploy with `vercel --prod`.
3. Register the deployed callback and webhook URLs:
   - Meta OAuth redirect URI: `https://YOUR-DOMAIN/api/callback/facebook`
   - Meta Webhook callback URL: `https://YOUR-DOMAIN/api/webhook` (with
     `META_VERIFY_TOKEN`, subscribed to `messages` and `messaging_postbacks`)
   - Google OAuth redirect URI: `https://YOUR-DOMAIN/api/callback/google`
   - Telegram Bot webhook (one-time call):
     `curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://YOUR-DOMAIN/api/webhook"`
     (plus `&secret_token=$TELEGRAM_WEBHOOK_SECRET` if set).

## Pending owner / production prerequisites

1. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN` (and `META_VERIFY_TOKEN`,
   `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`) in Vercel.
2. Meta App Review for `pages_messaging` and `pages_manage_metadata` (plus
   Business Verification) before onboarding external clinic Pages outside app
   admins/testers.
3. Register the Telegram bot `setWebhook` URL so `/start <code>` updates reach
   `/api/webhook`.

## Local test

See [TESTING.md](./TESTING.md) for how functions are tested locally with Node
and mock HTTP / fetch stubs, and what requires live provider credentials to
verify end-to-end.
