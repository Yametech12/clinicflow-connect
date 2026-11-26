# ClinicFlow Connect: Pro Max Audit and Upgrade (Nov 26, 2026)

Branch: `upgrade/pro-max` (from `main` at `cd12ed7`). No deploy, no merge,
no production change. Tests: `node tests/run-tests.js`, 60 of 60 passed
(54 pre-existing plus 6 new).

## 1. Audit summary

What the app does: the connect site and multi-tenant serverless engine for
ClinicFlow PH. Clinics log in with Google (Firebase Auth bridge), fill in a
profile, and link their own Facebook Page, Google account (Sheet plus
Calendar), and Telegram chat. Patient messages to the Page hit
`api/webhook.js`, Gemini drafts a Taglish reply from the clinic's
`FAQ_Prices` sheet, and a confirmed booking lands on Calendar, in
`Leads_Bookings`, and as a Telegram alert.

Stack: zero-dependency Node 18+ Vercel functions, static `index.html` and
`dashboard.html`, Upstash/Vercel KV REST storage behind `api/_store.js`,
hand-rolled Firebase ID token verification, HMAC-signed OAuth state.

State at audit time: strong. GT-134 through GT-140 had already closed the
big items (signature verification, dedup and dead letters, per-section
clinic keys, key-proof connect gates, logout rotation, CSP and headers,
bounded FAQ and bookings reads, Firebase login split). The remaining gaps
were robustness and hygiene, not missing features.

## 2. Problems found (prioritized)

Quick wins first:

1. No timeout on any outbound fetch. A hung Gemini, Google, Meta,
   Telegram, KV, or certs call could hold a serverless invocation until
   the platform killed it.
2. The Facebook Page access token traveled in the Messenger request URL
   query string, where it can land in request logs.
3. The webhook buffered request bodies with no size bound, and a single
   Meta batch fanned out with unbounded `Promise.all` concurrency.
4. The JSON POST endpoints (`/api/clinic`, `/api/auth/firebase`,
   `/api/callback/facebook`) buffered streamed bodies with no size bound.
5. Dashboard profile inputs had no `maxlength`, while the server silently
   sliced overlong values (name 140, address 240, hours 160).

Bigger items, deliberately NOT done on this branch:

6. No per-clinic rate limit on the webhook: a Page under a spam burst can
   still drive many Gemini calls. Needs a KV-backed counter design and a
   decision on what the patient sees when throttled.
7. No observability beyond `console.error` with correlation refs: no
   counts of bookings, failures, or dead letters anywhere the owner can
   see them.
8. The local JSON file store is not safe for concurrent writers (read,
   modify, write with no lock). It is local-test only, so this stays a
   documented limit.
9. Meta App Review is still required before Pages beyond app
   admins/testers can connect. That is an owner step in the Meta
   dashboard, not code.

## 3. What changed

- `api/_http.js` (new): `timedFetch(url, options, timeoutMs)` built on
  `AbortSignal.timeout`. Budgets: KV 10s, Google APIs 15s, Gemini 25s,
  Messenger and Telegram 15s, Firebase certs 10s. Wired into
  `api/_store.js`, `api/_google.js`, `api/_pipeline.js`, `api/_firebase.js`.
- `api/_pipeline.js`: `sendMessengerReply` now posts the Page token in
  the JSON body to the bare `https://graph.facebook.com/v21.0/me/messages`
  URL. Graph accepts the token in the body.
- `api/webhook.js`: bodies over 1 MB are refused (logged 200 ignore,
  same policy as unparseable payloads); the stream is destroyed on
  oversize. Messenger events in one batch run in chunks of 5.
- `api/_session.js`: `readRequestBody` caps streamed and raw bodies at
  1 MB (`BODY_TOO_LARGE`, exported as `MAX_REQUEST_BODY_BYTES`).
  `api/clinic.js` maps that code to 413 with a plain-language message.
  The Firebase bridge and Facebook callback still surface 500 for an
  oversize body; the bound itself holds everywhere.
- `dashboard.html`: profile inputs carry `maxlength` matching the server
  caps (name 140, address 240, hours 160, sheet 500).
- `tests/run-tests.js`: 6 new tests (41 to 46) covering the token-in-body
  shape, timeout signals on Gemini and Messenger calls, the webhook body
  cap, a 12-event batch completing all replies, the clinic 413, and the
  input caps.

Behavior preserved: all 54 pre-existing tests pass unchanged. No env var
names in visitor-facing strings, no em dash characters, no new
dependencies, no secrets added.

## 4. How to run and test

```bash
for f in $(find api -name '*.js' | sort); do node --check "$f"; done
node tests/run-tests.js
```

Live verification still needs real accounts (unchanged from TESTING.md):
a real Meta webhook delivery, a Facebook Page connect, a Google login
round trip, a live Gemini reply, a Telegram `/start` link, and Upstash
under real latency. On top of that, after deploy, confirm a Messenger
reply still arrives (token-in-body change) and that a slow Gemini call
fails fast instead of hanging the function.

## 5. Needs owner approval

- Merge `upgrade/pro-max` into `main` and deploy. This branch changes
  no production state by itself.
- Meta App Review for external clinic Pages (pre-existing, not new).
- Rate limiting and owner-visible stats (items 6 and 7 above) are
  designed-but-not-built; say the word and they become the next branch.
