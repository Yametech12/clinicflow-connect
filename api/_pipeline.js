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

async function processMessengerEvent({ pageId, senderId, messageId, userText, store }) {
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
        faqData = await loadFaqPrices(googleAccessToken, spreadsheetId);
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
};
