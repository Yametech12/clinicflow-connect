// ClinicFlow Connect: AI Messenger front-desk pipeline and Telegram bot handler.
// Ported from ../clinicflow/Code.gs for multi-tenant Vercel serverless execution.
const clinicStore = require('./_clinic');
const { escapeHtml, logServerError } = require('./_session');
const { timedFetch } = require('./_http');
const {
  DEFAULT_DURATION_MINS,
  getManilaPromptDates,
  getValidGoogleAccessToken,
  loadFaqPrices,
  appendLeadRow,
  appendSystemLog,
  createCalendarBooking,
} = require('./_google');

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const MAX_HISTORY_MESSAGES = 6;
const HISTORY_TTL_SECONDS = 1800; // 30 mins
const MSG_DEDUP_TTL_SECONDS = 300; // 5 mins
const BOOKED_GUARD_TTL_SECONDS = 600; // 10 mins
const DEAD_LETTER_TTL_SECONDS = 24 * 60 * 60; // 24 hours
// GT-143 fast ack: FAQ Sheet reads are cached per clinic in the shared
// store so repeat questions inside the window skip the Sheets fetch.
// FAQ answers change rarely (clinic edits the Sheet by hand), so a
// 3-minute staleness window is safe. Price rows come from this same FAQ
// Sheet read today, so the cache covers them with the same window; the
// booking writes (Calendar, Leads) are never cached.
const FAQ_CACHE_TTL_SECONDS = 180; // 3 minutes
// GT-143 fast ack: every verified Messenger event is durably recorded
// BEFORE the webhook acks, so a dropped or killed invocation can never
// lose a patient message. Records keep the full payload for manual
// replay and live for 24 hours.
const EVENT_RECORD_TTL_SECONDS = 24 * 60 * 60; // 24 hours
// An event still marked received after 6 minutes belongs to an
// invocation that died mid-flight: 6 minutes is past the longest
// function duration Vercel allows (300s), so the original attempt is
// guaranteed finished before anything re-drives its record. Reply
// safety on a re-drive does NOT come from this window; it comes from
// the reply_sent marker and the dedup reset in processRecordedEvent.
const EVENT_STALE_MS = 6 * 60 * 1000;
const EVENT_DRAIN_MAX = 5;
const EVENT_MAX_ATTEMPTS = 3;
// Re-drive claim lease: one re-drive works on a record at a time. The
// lease outlives the longest possible processing run (Vercel caps
// function duration at 300s), so a claim can never expire under a
// live holder; a killed holder's claim frees itself when it lapses.
const EVENT_CLAIM_TTL_SECONDS = 360;
const TG_MAX_FAILED_ATTEMPTS = 5;
const TG_FAIL_WINDOW_SECONDS = 900; // 15 mins

const PH_MOBILE_RE = /^(\+63|0)9\d{9}$/;

function getGeminiModel() {
  const configured = (process.env.GEMINI_MODEL || '').trim();
  return configured || DEFAULT_GEMINI_MODEL;
}

function normalizePhilippineMobile(mobile) {
  return String(mobile || '').replace(/[\s-]+/g, '').trim();
}

function isValidPhilippineMobile(mobile) {
  const normalized = normalizePhilippineMobile(mobile);
  return PH_MOBILE_RE.test(normalized);
}

function buildSystemPrompt({ clinicProfile, faqFormattedText, now = new Date() }) {
  const profile = clinicProfile || {};
  const clinicName = profile.name || 'our dental clinic';
  const clinicAddress = profile.address || 'Please ask our receptionist for directions.';
  const clinicHours = profile.hours || 'Monday to Saturday, 9:00 AM - 6:00 PM';
  const { manilaNow, manilaTomorrow } = getManilaPromptDates(now);

  return `You are the friendly AI front-desk receptionist for "${clinicName}".
CLINIC ADDRESS: ${clinicAddress}
CLINIC HOURS: ${clinicHours}
CURRENT PHILIPPINE DATE & TIME: ${manilaNow} (Tomorrow is ${manilaTomorrow}, Timezone: Asia/Manila +08:00)

APPROVED SERVICES & PRICES (STRICT SOURCE OF TRUTH):
${faqFormattedText}

STRICT RULES YOU MUST FOLLOW:
1. TONE & LANGUAGE: Reply in warm, polite, natural Philippine English / Taglish (use "po" naturally). Keep it helpful and human.
2. LENGTH LIMIT: Your "reply" MUST be at most 3 short sentences. Never write long paragraphs or bullet walls.
3. PRICE ACCURACY: Quote prices ONLY from the "APPROVED SERVICES & PRICES" list above. Never invent discounts, promos, or unlisted prices. If a service is not on the list, politely say the dentist will confirm the exact rate during checkup.
4. BOOKING COLLECTION: To book an appointment, you MUST collect all 3 details from the patient:
   - Full Name (patient_name)
   - Philippine Mobile Number (mobile_number, e.g., 09XXXXXXXXX or +639XXXXXXXXX)
   - Preferred Date and Time (preferred_datetime)
   If any of the 3 details are missing, ask ONLY for the missing item(s) concisely.
5. READY TO BOOK FLAG: Set "ready_to_book" to true ONLY when ALL 3 required fields (patient_name, valid 11-digit Philippine mobile_number, preferred_datetime) have been clearly provided by the patient in this conversation. Otherwise, "ready_to_book" MUST be false.
6. OUTPUT FORMAT: Return ONLY a valid JSON object matching this exact schema:
{
  "reply": "Your max-3-sentence Taglish response to the patient",
  "ready_to_book": false,
  "booking": {
    "patient_name": "",
    "mobile_number": "",
    "service": "",
    "preferred_datetime_text": "",
    "iso_start_time": "",
    "notes": ""
  }
}
For "iso_start_time", convert the patient's requested date/time into ISO 8601 format with +08:00 offset (e.g., "2026-11-26T14:00:00+08:00") based on the CURRENT PHILIPPINE DATE & TIME above. Leave empty string "" if date/time is not yet provided.`;
}

async function callGeminiJson({ apiKey, model, systemPrompt, history, userText }) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  const chosenModel = model || getGeminiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    chosenModel
  )}:generateContent`;

  const contents = [];
  if (Array.isArray(history)) {
    for (const turn of history) {
      if (!turn || !turn.text) continue;
      contents.push({
        role: turn.role === 'model' ? 'model' : 'user',
        parts: [{ text: String(turn.text) }],
      });
    }
  }
  contents.push({
    role: 'user',
    parts: [{ text: String(userText) }],
  });

  const requestBody = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents,
    generationConfig: {
      maxOutputTokens: 600,
      responseMimeType: 'application/json',
    },
  };

  const response = await timedFetch(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    },
    25000
  );

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini API HTTP ${response.status}: ${rawText.slice(0, 400)}`);
  }

  const envelope = JSON.parse(rawText);
  const candidateText =
    envelope &&
    envelope.candidates &&
    envelope.candidates[0] &&
    envelope.candidates[0].content &&
    envelope.candidates[0].content.parts &&
    envelope.candidates[0].content.parts[0] &&
    envelope.candidates[0].content.parts[0].text;

  if (!candidateText) {
    throw new Error(`Empty Gemini candidate text: ${rawText.slice(0, 300)}`);
  }

  const cleanedJson = String(candidateText)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let structured;
  try {
    structured = JSON.parse(cleanedJson);
  } catch (err) {
    return {
      reply:
        'Hi po! Pasensya na, paki-repeat lang po ng service at preferred schedule ninyo para ma-assist ko kayo agad.',
      ready_to_book: false,
      booking: {},
      parseError: err.message,
    };
  }

  return {
    reply: String(structured.reply || 'Hi po! How can we help with your smile today?').trim(),
    ready_to_book: Boolean(structured.ready_to_book),
    booking: structured.booking && typeof structured.booking === 'object' ? structured.booking : {},
  };
}

function hasCompleteBookingDetails(booking) {
  if (!booking || typeof booking !== 'object') return false;
  const hasName = String(booking.patient_name || '').trim().length > 0;
  const hasValidMobile = isValidPhilippineMobile(booking.mobile_number);
  const hasDateTime =
    String(booking.preferred_datetime_text || '').trim().length > 0 ||
    String(booking.iso_start_time || '').trim().length > 0;
  return hasName && hasValidMobile && hasDateTime;
}

function matchServiceDuration(requestedService, faqItems) {
  if (!requestedService || !Array.isArray(faqItems)) {
    return DEFAULT_DURATION_MINS;
  }
  const needle = String(requestedService).toLowerCase();
  const match = faqItems.find(
    (item) =>
      item.service.toLowerCase().includes(needle) ||
      needle.includes(item.service.toLowerCase().split('(')[0].trim())
  );
  return match ? match.duration : DEFAULT_DURATION_MINS;
}

async function sendMessengerReply(pageAccessToken, recipientId, replyText) {
  if (!pageAccessToken) {
    throw new Error('Missing Facebook Page access token.');
  }
  // Pro max: the Page token travels in the POST body, never in the URL
  // query string, so it cannot land in request logs or referrers.
  const url = 'https://graph.facebook.com/v21.0/me/messages';
  const response = await timedFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: pageAccessToken,
        messaging_type: 'RESPONSE',
        recipient: { id: String(recipientId) },
        message: { text: String(replyText) },
      }),
    },
    15000
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Meta Graph API HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function sendTelegramMessage(botToken, chatId, text, parseMode) {
  if (!botToken || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN and chatId are required to send Telegram messages.');
  }
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
  const payload = {
    chat_id: String(chatId),
    text: String(text),
  };
  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  const response = await timedFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    15000
  );
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
  }
  return bodyText ? JSON.parse(bodyText) : {};
}

async function sendTelegramBookingAlert(botToken, chatId, clinicName, booking, eventId) {
  if (!botToken || !chatId) {
    return { skipped: true, reason: 'Telegram not configured or clinic chat not linked' };
  }

  const messageText = [
    `<b>NEW CLINIC BOOKING (${escapeHtml(clinicName || 'ClinicFlow PH')})</b>`,
    '',
    `<b>Patient:</b> ${escapeHtml(booking.patient_name || 'N/A')}`,
    `<b>Mobile:</b> <code>${escapeHtml(booking.mobile_number || 'N/A')}</code>`,
    `<b>Service:</b> ${escapeHtml(booking.service || 'Consultation')}`,
    `<b>Schedule:</b> ${escapeHtml(booking.preferred_datetime_text || booking.iso_start_time || 'N/A')}`,
    `<b>Google Calendar:</b> ${eventId ? `Synced (${escapeHtml(eventId)})` : 'Check Sheet'}`,
  ].join('\n');

  await sendTelegramMessage(botToken, chatId, messageText, 'HTML');
  return { sent: true };
}

async function sendTelegramFailureAlert(botToken, chatId, clinicName, booking, detail) {
  if (!botToken || !chatId) return;
  const messageText = [
    `<b>BOOKING NEEDS MANUAL CONFIRMATION (${escapeHtml(clinicName || 'ClinicFlow PH')})</b>`,
    '',
    `<b>Patient:</b> ${escapeHtml((booking && booking.patient_name) || 'N/A')}`,
    `<b>Mobile:</b> <code>${escapeHtml((booking && booking.mobile_number) || 'N/A')}</code>`,
    `<b>Service:</b> ${escapeHtml((booking && booking.service) || 'Consultation')}`,
    `<b>Schedule:</b> ${escapeHtml((booking && booking.preferred_datetime_text) || 'N/A')}`,
    `<b>Issue:</b> ${escapeHtml(detail || 'Could not write booking to Google Calendar or Sheet.')}`,
  ].join('\n');
  await sendTelegramMessage(botToken, chatId, messageText, 'HTML');
}

async function writeDeadLetterRecord(store, { pageId, senderId, messageId, userText, errorMessage }) {
  try {
    const suffix = messageId || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await store.put(
      `dead:${pageId}:${suffix}`,
      {
        pageId,
        senderId,
        messageId: messageId || null,
        userText: String(userText || '').slice(0, 500),
        error: String(errorMessage || 'Unknown error').slice(0, 500),
        occurredAt: new Date().toISOString(),
      },
      { ttlSeconds: DEAD_LETTER_TTL_SECONDS }
    );
  } catch (deadErr) {
    logServerError('dead_letter_write', deadErr);
  }
}

// GT-143: store-backed FAQ cache, keyed per clinic + spreadsheet. A hit
// returns the parsed { items, formattedText, truncated } shape without a
// Sheets fetch. Only successful loads are cached; a failed load throws
// through to the caller's existing fallback and is never stored.
async function loadFaqPricesCached(store, clinicId, googleAccessToken, spreadsheetId) {
  const cacheKey = `faq_cache:${clinicId}:${spreadsheetId}`;
  if (store && store.isConfigured()) {
    try {
      const cached = await store.get(cacheKey);
      if (
        cached &&
        Array.isArray(cached.items) &&
        typeof cached.formattedText === 'string'
      ) {
        return {
          items: cached.items,
          formattedText: cached.formattedText,
          truncated: Boolean(cached.truncated),
        };
      }
    } catch (cacheErr) {
      logServerError(`faq_cache_read:${clinicId}`, cacheErr);
    }
  }

  const fresh = await loadFaqPrices(googleAccessToken, spreadsheetId);

  if (store && store.isConfigured()) {
    try {
      await store.put(
        cacheKey,
        {
          items: fresh.items,
          formattedText: fresh.formattedText,
          truncated: Boolean(fresh.truncated),
        },
        { ttlSeconds: FAQ_CACHE_TTL_SECONDS }
      );
    } catch (cacheErr) {
      logServerError(`faq_cache_write:${clinicId}`, cacheErr);
    }
  }
  return fresh;
}

async function processMessengerEvent({ pageId, senderId, messageId, userText, store, eventKey }) {
  if (!store || !store.isConfigured()) {
    console.warn('[clinicflow] Skipping Messenger event: storage is not configured.');
    return { status: 'skipped', reason: 'storage_unconfigured' };
  }

  const dedupKey = messageId ? `msg_dedup:${pageId}:${messageId}` : null;
  if (dedupKey) {
    const isFresh = await store.putIfAbsent(dedupKey, '1', { ttlSeconds: MSG_DEDUP_TTL_SECONDS });
    if (!isFresh) {
      return { status: 'duplicate', messageId };
    }
  }

  let clinicId = null;
  let googleAccessToken = null;
  let spreadsheetId = null;

  try {
    const pageMap = await store.get(`fb_page:${pageId}`);
    if (!pageMap || !pageMap.clinicId) {
      console.warn(`[clinicflow] No clinic linked for Facebook Page ${pageId}`);
      return { status: 'ignored', reason: 'page_not_linked', pageId };
    }

    clinicId = pageMap.clinicId;
    const clinic = await clinicStore.getClinic(store, clinicId);
    if (!clinic || !clinic.facebook || !clinic.facebook.pageAccessToken) {
      console.warn(`[clinicflow] Clinic ${clinicId} missing Facebook Page token`);
      return { status: 'ignored', reason: 'missing_page_token', clinicId };
    }

    spreadsheetId = clinic.google && clinic.google.spreadsheetId;
    if (clinic.google && (clinic.google.accessToken || clinic.google.refreshToken)) {
      try {
        googleAccessToken = await getValidGoogleAccessToken(clinicId, clinic, store);
      } catch (err) {
        logServerError(`google_refresh:${clinicId}`, err);
      }
    }

    let faqData = {
      items: [],
      formattedText: 'No services listed yet. Ask patient to message our receptionist for rates.',
    };
    if (googleAccessToken && spreadsheetId) {
      try {
        faqData = await loadFaqPricesCached(store, clinicId, googleAccessToken, spreadsheetId);
      } catch (err) {
        logServerError(`faq_load:${clinicId}`, err);
      }
    }

    const histKey = `hist:${pageId}:${senderId}`;
    const history = (await store.get(histKey)) || [];
    const systemPrompt = buildSystemPrompt({
      clinicProfile: clinic.profile || {},
      faqFormattedText: faqData.formattedText,
    });

    const aiResult = await callGeminiJson({
      apiKey: process.env.GEMINI_API_KEY,
      model: getGeminiModel(),
      systemPrompt,
      history,
      userText,
    });

    const booking = aiResult.booking || {};
    const validMobile = isValidPhilippineMobile(booking.mobile_number);
    const canBook = aiResult.ready_to_book === true && hasCompleteBookingDetails(booking);

    let outgoingReply = aiResult.reply;
    if (aiResult.ready_to_book === true && !validMobile) {
      outgoingReply =
        'Paki-check po ng mobile number ninyo (halimbawa 09171234567 o +639171234567) para ma-confirm namin ang booking.';
    }

    let actionDetails = '';
    let bookingConfirmed = false;
    let bookingWriteFailed = false;
    let logLevel = 'INFO';
    const tgBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChatId = clinic.telegram && clinic.telegram.chatId;
    const clinicLabel =
      (clinic.profile && clinic.profile.name) || clinic.facebook.pageName || 'ClinicFlow PH';

    if (canBook) {
      const normalizedBooking = {
        ...booking,
        mobile_number: normalizePhilippineMobile(booking.mobile_number),
      };
      const bookedKey = `booked:${pageId}:${senderId}`;
      const alreadyBooked = Boolean(await store.get(bookedKey));

      if (alreadyBooked) {
        actionDetails = 'Skipped repeat booking within 10-min guard';
      } else {
        const durationMins = matchServiceDuration(normalizedBooking.service, faqData.items);
        const actionNotes = [];
        let eventId = null;
        let calendarOk = false;
        let sheetOk = false;

        if (googleAccessToken) {
          try {
            eventId = await createCalendarBooking(
              googleAccessToken,
              (clinic.google && clinic.google.calendarId) || 'primary',
              {
                booking: normalizedBooking,
                durationMins,
                clinicAddress: clinic.profile && clinic.profile.address,
              }
            );
            calendarOk = true;
            actionNotes.push(`Cal:${eventId}`);
          } catch (calErr) {
            logServerError(`calendar_create:${clinicId}`, calErr);
            actionNotes.push(`CalErr:${calErr.message}`);
          }

          if (spreadsheetId) {
            try {
              await appendLeadRow(googleAccessToken, spreadsheetId, {
                senderId,
                booking: normalizedBooking,
                eventId,
              });
              sheetOk = true;
              actionNotes.push('Sheet:OK');
            } catch (sheetErr) {
              logServerError(`lead_append:${clinicId}`, sheetErr);
              actionNotes.push(`SheetErr:${sheetErr.message}`);
            }
          } else {
            actionNotes.push('Sheet:NotLinked');
          }
        } else {
          actionNotes.push('Google:NotLinked');
        }

        const anyRecordWritten = calendarOk || sheetOk;
        if (anyRecordWritten) {
          bookingConfirmed = true;
          await store.put(bookedKey, '1', { ttlSeconds: BOOKED_GUARD_TTL_SECONDS });

          if (tgBotToken && tgChatId) {
            try {
              await sendTelegramBookingAlert(
                tgBotToken,
                tgChatId,
                clinicLabel,
                normalizedBooking,
                eventId
              );
              actionNotes.push('TG:OK');
            } catch (tgErr) {
              logServerError(`telegram_alert:${clinicId}`, tgErr);
              actionNotes.push(`TGErr:${tgErr.message}`);
            }
          } else {
            actionNotes.push('TG:NotLinked');
          }
        } else {
          bookingWriteFailed = true;
          logLevel = 'ERROR';
          outgoingReply =
            'Salamat po! Na-note namin ang details ninyo, pero hindi pa ito naisulat sa booking system ngayon. Magko-confirm po ang staff namin sa inyo sa text shortly.';
          actionNotes.push('BookingFailed:NoRecordWritten');

          if (tgBotToken && tgChatId) {
            try {
              await sendTelegramFailureAlert(
                tgBotToken,
                tgChatId,
                clinicLabel,
                normalizedBooking,
                actionNotes.join(' | ')
              );
            } catch (tgErr) {
              logServerError(`telegram_fail_alert:${clinicId}`, tgErr);
            }
          }
        }

        actionDetails = actionNotes.join(' | ');
      }
    }

    // Send the Messenger reply BEFORE updating history / appending System_Logs.
    await sendMessengerReply(clinic.facebook.pageAccessToken, senderId, outgoingReply);

    // GT-143: durably mark that this event's reply went out, before
    // any other post-send work. If this invocation is killed at any
    // later point, a re-drive of the event record sees the marker and
    // never sends the reply a second time.
    if (eventKey) {
      try {
        await store.put(
          `reply_sent:${eventKey}`,
          { at: new Date().toISOString() },
          { ttlSeconds: EVENT_RECORD_TTL_SECONDS }
        );
      } catch (markErr) {
        logServerError('reply_sent_mark', markErr);
      }
    }

    if (bookingConfirmed) {
      await store.del(histKey);
    } else {
      const nextHistory = [
        ...history,
        { role: 'user', text: userText },
        { role: 'model', text: outgoingReply },
      ].slice(-MAX_HISTORY_MESSAGES);
      await store.put(histKey, nextHistory, { ttlSeconds: HISTORY_TTL_SECONDS });
    }

    if (googleAccessToken && spreadsheetId) {
      try {
        await appendSystemLog(googleAccessToken, spreadsheetId, {
          level: logLevel,
          senderId,
          userMsg: userText,
          aiReply: outgoingReply,
          readyToBook: canBook && !bookingWriteFailed,
          details: actionDetails || aiResult.parseError || '',
        });
      } catch (logErr) {
        logServerError(`system_logs_append:${clinicId}`, logErr);
      }
    } else if (bookingWriteFailed) {
      await writeDeadLetterRecord(store, {
        pageId,
        senderId,
        messageId,
        userText,
        errorMessage: actionDetails,
      });
    }

    return {
      status: 'replied',
      clinicId,
      ready_to_book: canBook && !bookingWriteFailed,
      bookingTriggered: bookingConfirmed,
      bookingWriteFailed,
      actionDetails,
      reply: outgoingReply,
    };
  } catch (err) {
    if (dedupKey) {
      await store.del(dedupKey).catch(() => {});
    }
    const ref = logServerError('process_messenger_event', err);

    let loggedToSheet = false;
    if (googleAccessToken && spreadsheetId) {
      try {
        await appendSystemLog(googleAccessToken, spreadsheetId, {
          level: 'ERROR',
          senderId,
          userMsg: userText,
          aiReply: '',
          readyToBook: false,
          details: `[${ref}] ${err.message}`,
        });
        loggedToSheet = true;
      } catch (logErr) {
        logServerError(`system_logs_error_row:${clinicId}`, logErr);
      }
    }

    if (!loggedToSheet) {
      await writeDeadLetterRecord(store, {
        pageId,
        senderId,
        messageId,
        userText,
        errorMessage: `[${ref}] ${err.message}`,
      });
    }

    throw err;
  }
}

// --- GT-143 fast ack: durable webhook event records -------------------
// The webhook records each verified Messenger event in the store BEFORE
// sending its 200 ack, then processes it in the same invocation after
// the response has been flushed to Meta. The record is the safety net:
// status transitions (received -> done / failed) make every delivery
// auditable, duplicates of a finished event are dropped at intake, a
// failed event can be re-driven by a repeat delivery, and an event
// orphaned by a killed invocation is re-driven by drainStaleEvents on
// a later invocation. Discovery is by key scan (store.scanKeys), never
// a shared index key, so concurrent invocations cannot corrupt it.
// Double-send safety on re-drives comes from processRecordedEvent: the
// pipeline writes a reply_sent marker the moment a reply goes out, and
// a re-drive checks that marker before doing anything.

function buildEventKey({ pageId, senderId, messageId, userText }) {
  if (messageId) {
    return `evt:${pageId}:${messageId}`;
  }
  // Events without a Meta message id cannot be deduped (same as the
  // pipeline's msg_dedup behaviour today), so each delivery gets a
  // unique record keyed by a hash of its content plus arrival time.
  const crypto = require('crypto');
  const hash = crypto
    .createHash('sha256')
    .update(`${pageId}|${senderId}|${userText}|${Date.now()}|${Math.random()}`)
    .digest('hex')
    .slice(0, 24);
  return `evt:${pageId}:noid_${hash}`;
}

// Records the event and decides whether THIS invocation should process
// it. Returns { key, shouldProcess, reason }. A duplicate of an event
// that already finished returns shouldProcess false. A duplicate of a
// failed event, or of an event orphaned past the stale window, is
// re-claimed so the repeat delivery actually re-runs the pipeline
// (through the re-drive protocol in processRecordedEvent).
async function recordEventIntake(store, job) {
  const key = buildEventKey(job);
  const record = {
    pageId: job.pageId,
    senderId: job.senderId,
    messageId: job.messageId || null,
    userText: String(job.userText || '').slice(0, 1000),
    status: 'received',
    receivedAt: new Date().toISOString(),
    attempts: 1,
  };

  const fresh = await store.putIfAbsent(key, record, {
    ttlSeconds: EVENT_RECORD_TTL_SECONDS,
  });
  if (fresh) {
    return { key, shouldProcess: true, reason: 'new' };
  }

  const existing = await store.get(key);
  if (!existing) {
    // Record expired between the two reads; take the claim.
    await store.put(key, record, { ttlSeconds: EVENT_RECORD_TTL_SECONDS });
    return { key, shouldProcess: true, reason: 'record_expired' };
  }

  if (existing.status === 'done') {
    return { key, shouldProcess: false, reason: 'duplicate_done' };
  }

  const ageMs = Date.now() - new Date(existing.receivedAt || 0).getTime();
  if (existing.status === 'failed' || ageMs > EVENT_STALE_MS) {
    // Reopen the record for the re-drive. The attempt count is bumped
    // by processRecordedEvent when the re-drive actually runs, so
    // every re-drive path (repeat delivery or drain) counts the same.
    const reclaim = {
      ...existing,
      status: 'received',
      receivedAt: new Date().toISOString(),
    };
    await store.put(key, reclaim, { ttlSeconds: EVENT_RECORD_TTL_SECONDS });
    return {
      key,
      shouldProcess: true,
      reason: existing.status === 'failed' ? 'retry_failed' : 'reclaim_stale',
    };
  }

  return { key, shouldProcess: false, reason: 'in_flight' };
}

async function markEventProcessed(store, key, result) {
  try {
    const existing = await store.get(key);
    if (!existing) return;
    await store.put(
      key,
      {
        ...existing,
        status: 'done',
        processedAt: new Date().toISOString(),
        outcome: result && result.status ? String(result.status) : 'unknown',
      },
      { ttlSeconds: EVENT_RECORD_TTL_SECONDS }
    );
  } catch (err) {
    logServerError('event_mark_done', err);
  }
}

async function markEventFailed(store, key, errorMessage) {
  try {
    const existing = await store.get(key);
    if (!existing) return;
    await store.put(
      key,
      {
        ...existing,
        status: 'failed',
        failedAt: new Date().toISOString(),
        error: String(errorMessage || 'Unknown error').slice(0, 500),
      },
      { ttlSeconds: EVENT_RECORD_TTL_SECONDS }
    );
  } catch (err) {
    logServerError('event_mark_failed', err);
  }
}

// Runs the pipeline for one recorded event and settles its record.
// First attempts (redrive false) go straight through. Re-drives
// (redrive true: a repeat delivery reclaiming a failed or stale
// record, or the drain) are serialized by an atomic claim
// (evt_claim:<key>, putIfAbsent) so two concurrent re-drives of the
// same record can never interleave, then follow the safety protocol:
//   1. If the reply_sent marker exists, a previous attempt DID send
//      the reply (and died before settling the record). Mark done as
//      already_replied and never send again.
//   2. Otherwise no reply ever went out, but a dead attempt may have
//      left its msg_dedup claim behind; clear it so this run can
//      actually process instead of being suppressed as a duplicate.
//      The claim guarantees no other re-drive is mid-pipeline while
//      this runs, so the clear cannot strip a live claim.
//   3. The attempt count is bumped here, the one place every re-drive
//      passes through, so the drain's attempt cap always advances.
// Re-drives only ever happen for records whose original invocation is
// finished (failed outright, or older than the stale window, which is
// past the maximum function duration), so none of this can race a
// live first attempt either.
async function processRecordedEvent(store, key, job, { redrive = false, processFn } = {}) {
  const run = processFn || processMessengerEvent;

  async function runAndSettle() {
    try {
      const result = await run({ ...job, store, eventKey: key });
      await markEventProcessed(store, key, result);
      return result;
    } catch (err) {
      const ref = logServerError('process_recorded_event', err);
      await markEventFailed(store, key, `[${ref}] ${err.message}`);
      return { status: 'error', ref };
    }
  }

  if (!redrive) {
    return runAndSettle();
  }

  let claimed = false;
  try {
    claimed = await store.putIfAbsent(
      `evt_claim:${key}`,
      { at: new Date().toISOString() },
      { ttlSeconds: EVENT_CLAIM_TTL_SECONDS }
    );
  } catch (err) {
    logServerError('event_claim', err);
  }
  if (!claimed) {
    // Another re-drive already holds this record (or the claim write
    // failed, in which case standing down is the safe side). The
    // record is left exactly as it was for a later attempt.
    return { status: 'claim_held' };
  }

  try {
    let alreadySent = null;
    try {
      alreadySent = await store.get(`reply_sent:${key}`);
    } catch (err) {
      logServerError('reply_sent_check', err);
    }
    if (alreadySent) {
      await markEventProcessed(store, key, { status: 'already_replied' });
      return { status: 'already_replied' };
    }

    try {
      const existing = await store.get(key);
      if (existing) {
        await store.put(
          key,
          {
            ...existing,
            status: 'received',
            receivedAt: new Date().toISOString(),
            attempts: (Number(existing.attempts) || 1) + 1,
          },
          { ttlSeconds: EVENT_RECORD_TTL_SECONDS }
        );
      }
    } catch (err) {
      logServerError('event_attempt_bump', err);
    }

    if (job.messageId) {
      try {
        await store.del(`msg_dedup:${job.pageId}:${job.messageId}`);
      } catch (err) {
        logServerError('event_dedup_reset', err);
      }
    }

    return await runAndSettle();
  } finally {
    try {
      await store.del(`evt_claim:${key}`);
    } catch (err) {
      // A stranded claim expires on its own TTL.
    }
  }
}

// Opportunistic sweeper, run at the end of a webhook invocation:
// discovers recorded events by key scan and re-drives the ones whose
// original invocation never settled them: still received past the
// stale window (killed mid-flight), or failed, past the same window,
// with attempts left. Bounded per invocation. Records themselves stay
// in the store for 24h either way, so anything the sweeper cannot
// settle remains replayable by hand from its stored payload.
async function drainStaleEvents(store, { processFn } = {}) {
  if (!store || !store.isConfigured() || typeof store.scanKeys !== 'function') {
    return { drained: 0, scanned: 0 };
  }
  let keys = [];
  try {
    keys = await store.scanKeys('evt:');
  } catch (err) {
    logServerError('event_scan', err);
    return { drained: 0, scanned: 0 };
  }

  let drained = 0;
  for (const key of keys) {
    if (drained >= EVENT_DRAIN_MAX) break;
    let record = null;
    try {
      record = await store.get(key);
    } catch (err) {
      continue;
    }
    if (!record) continue;

    const receivedAgeMs = Date.now() - new Date(record.receivedAt || 0).getTime();
    const failedAgeMs = record.failedAt
      ? Date.now() - new Date(record.failedAt).getTime()
      : 0;
    const orphaned = record.status === 'received' && receivedAgeMs > EVENT_STALE_MS;
    const retryable =
      record.status === 'failed' &&
      failedAgeMs > EVENT_STALE_MS &&
      (Number(record.attempts) || 1) < EVENT_MAX_ATTEMPTS;
    if (!orphaned && !retryable) continue;

    await processRecordedEvent(
      store,
      key,
      {
        pageId: record.pageId,
        senderId: record.senderId,
        messageId: record.messageId || '',
        userText: record.userText,
      },
      { redrive: true, processFn }
    );
    drained += 1;
  }
  return { drained, scanned: keys.length };
}

function extractTelegramLinkingCode(text) {
  const trimmed = String(text || '').trim();
  const startMatch = trimmed.match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]+))?$/i);
  if (startMatch) {
    return {
      isStart: true,
      code: startMatch[1] ? startMatch[1].toUpperCase() : '',
    };
  }
  if (/^[A-HJ-NP-Z2-9]{6}$/i.test(trimmed)) {
    return { isStart: false, code: trimmed.toUpperCase() };
  }
  return { isStart: false, code: '' };
}

async function handleTelegramUpdate({ update, store }) {
  const msg = (update && (update.message || update.edited_message)) || null;
  if (!msg || !msg.chat || msg.chat.id === undefined || !msg.text) {
    return { status: 'ignored', reason: 'no_text_message' };
  }

  const chatId = String(msg.chat.id);
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const { isStart, code } = extractTelegramLinkingCode(msg.text);

  if (!code) {
    if (isStart && botToken) {
      await sendTelegramMessage(
        botToken,
        chatId,
        'Hi! Open the ClinicFlow Connect page, click Connect Telegram, and tap the Start link (or send /start YOURCODE) to link this chat.'
      );
    }
    return { status: isStart ? 'missing_code' : 'ignored', chatId };
  }

  if (!store || !store.isConfigured()) {
    if (botToken) {
      await sendTelegramMessage(
        botToken,
        chatId,
        'ClinicFlow server storage is not switched on yet, so linking codes cannot be saved.'
      );
    }
    return { status: 'setup_pending', reason: 'storage_unconfigured' };
  }

  const failKey = `tg_fail:${chatId}`;
  const failRecord = await store.get(failKey);
  if (failRecord && Number(failRecord.count) >= TG_MAX_FAILED_ATTEMPTS) {
    if (botToken) {
      await sendTelegramMessage(
        botToken,
        chatId,
        'Too many invalid code attempts. Please wait 15 minutes and generate a new code on ClinicFlow Connect.'
      );
    }
    return { status: 'rate_limited', chatId };
  }

  const linkKey = `tg_code:${code}`;
  const linkRecord = await store.get(linkKey);
  const isExpired =
    linkRecord && linkRecord.expiresAt && new Date(linkRecord.expiresAt).getTime() <= Date.now();

  if (!linkRecord || !linkRecord.clinicId || isExpired) {
    if (isExpired) {
      await store.del(linkKey);
    }
    const nextCount = (failRecord && Number(failRecord.count) ? Number(failRecord.count) : 0) + 1;
    await store.put(failKey, { count: nextCount }, { ttlSeconds: TG_FAIL_WINDOW_SECONDS });

    if (botToken) {
      await sendTelegramMessage(
        botToken,
        chatId,
        'Sorry, that linking code is invalid or expired. Please click Connect Telegram on ClinicFlow Connect to get a fresh code.'
      );
    }
    return { status: 'invalid_or_expired_code', code };
  }

  await store.del(failKey);
  await store.del(linkKey);

  const clinicId = linkRecord.clinicId;
  const oldTelegram = await clinicStore.getClinicSection(store, clinicId, 'telegram');
  const [profile, facebook] = await Promise.all([
    clinicStore.getClinicSection(store, clinicId, 'profile'),
    clinicStore.getClinicSection(store, clinicId, 'facebook'),
  ]);

  const nextTelegram = {
    chatId,
    username: (msg.from && msg.from.username) || (msg.chat && msg.chat.username) || null,
    firstName: (msg.from && msg.from.first_name) || (msg.chat && msg.chat.first_name) || null,
    chatType: (msg.chat && msg.chat.type) || 'private',
    linkedAt: new Date().toISOString(),
  };

  await clinicStore.saveClinicSection(store, clinicId, 'telegram', nextTelegram);

  const clinicLabel =
    (profile && profile.name) || (facebook && facebook.pageName) || 'your clinic';

  if (oldTelegram && oldTelegram.chatId && String(oldTelegram.chatId) !== chatId && botToken) {
    try {
      await sendTelegramMessage(
        botToken,
        String(oldTelegram.chatId),
        `Heads up: Telegram booking alerts for ${clinicLabel} have been moved to a different Telegram chat.`
      );
    } catch (oldErr) {
      logServerError(`telegram_old_chat_notice:${clinicId}`, oldErr);
    }
  }

  if (botToken) {
    await sendTelegramMessage(
      botToken,
      chatId,
      `Linked! Instant booking alerts for ${clinicLabel} will now be sent to this Telegram chat.`
    );
  }

  return {
    status: 'linked',
    clinicId,
    chatId,
  };
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  getGeminiModel,
  normalizePhilippineMobile,
  isValidPhilippineMobile,
  buildSystemPrompt,
  callGeminiJson,
  hasCompleteBookingDetails,
  matchServiceDuration,
  sendMessengerReply,
  sendTelegramMessage,
  sendTelegramBookingAlert,
  processMessengerEvent,
  extractTelegramLinkingCode,
  handleTelegramUpdate,
  loadFaqPricesCached,
  buildEventKey,
  recordEventIntake,
  markEventProcessed,
  markEventFailed,
  processRecordedEvent,
  drainStaleEvents,
  FAQ_CACHE_TTL_SECONDS,
  EVENT_RECORD_TTL_SECONDS,
  EVENT_STALE_MS,
  EVENT_MAX_ATTEMPTS,
  EVENT_CLAIM_TTL_SECONDS,
};
