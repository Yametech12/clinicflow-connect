// ClinicFlow Connect: Google OAuth token refresh, Sheets, and Calendar helpers.
const clinicStore = require('./_clinic');

const TIMEZONE = 'Asia/Manila';
const DEFAULT_DURATION_MINS = 45;
const MAX_FAQ_ROWS = 100;
const MAX_FAQ_CHARS = 6000;

const SHEETS = {
  FAQ: 'FAQ_Prices',
  LEADS: 'Leads_Bookings',
  LOGS: 'System_Logs',
};

const FAQ_HEADERS = ['Service', 'Price_PHP', 'Duration_Mins', 'Notes'];
const LEAD_HEADERS = [
  'Timestamp',
  'Sender_ID',
  'Patient_Name',
  'Mobile_Number',
  'Service',
  'Preferred_DateTime',
  'ISO_Start_Time',
  'Status',
  'Calendar_Event_ID',
  'Notes',
];
const LOG_HEADERS = [
  'Timestamp',
  'Level',
  'Sender_ID',
  'User_Message',
  'AI_Reply',
  'Ready_To_Book',
  'Details_Or_Error',
];

const SAMPLE_SERVICES = [
  [
    'Oral Prophylaxis (Teeth Cleaning)',
    '₱1,200 - ₱2,000',
    45,
    'Includes basic scaling, polishing, and oral checkup. Price depends on tartar buildup.',
  ],
  [
    'Tooth Extraction (Simple Bunot)',
    '₱1,500 - ₱3,000',
    45,
    'Per tooth, inclusive of local anesthesia. Complex/impacted wisdom tooth requires X-ray first.',
  ],
  [
    'Composite Dental Filling (Pasta)',
    '₱1,200 - ₱2,500',
    45,
    'Tooth-colored light-cure filling, price per surface/tooth.',
  ],
  [
    'In-Office Teeth Whitening',
    '₱8,500',
    60,
    '1-session LED whitening promo. Best done after teeth cleaning.',
  ],
  [
    'Metal Braces Installation',
    '₱35,000 (₱5,000 Downpayment)',
    60,
    'Full upper and lower braces. ₱1,500 monthly adjustment. Panoramic X-ray required.',
  ],
  [
    'Root Canal Treatment',
    '₱6,000 per canal',
    60,
    'Saves infected/damaged tooth without extraction.',
  ],
  [
    'Porcelain-Fused-to-Metal Crown (Jacket)',
    '₱7,500 per unit',
    60,
    'Custom-fitted dental crown; takes 2 visits (prep + final cementation).',
  ],
  [
    'Dental Consultation & Panoramic X-Ray',
    '₱800 (Consult) / ₱1,200 (X-Ray)',
    30,
    'Consultation fee is waived if patient proceeds with treatment on the same day.',
  ],
];

function getManilaParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
  }
  return parts;
}

function getManilaTimestamp(date = new Date()) {
  const p = getManilaParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function getManilaIso(date = new Date()) {
  const p = getManilaParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

function getManilaPromptDates(date = new Date()) {
  const nowP = getManilaParts(date);
  const tomorrow = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  const tmP = getManilaParts(tomorrow);
  return {
    manilaNow: `${nowP.weekday}, ${nowP.year}-${nowP.month}-${nowP.day} at ${nowP.hour}:${nowP.minute}`,
    manilaTomorrow: `${tmP.weekday}, ${tmP.year}-${tmP.month}-${tmP.day}`,
    tomorrowYyyyMmDd: `${tmP.year}-${tmP.month}-${tmP.day}`,
  };
}

function extractSpreadsheetId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const match = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9-_]{15,120}$/.test(raw)) return raw;
  return '';
}

async function googleFetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = { raw: text };
  }
  if (!response.ok) {
    const errMsg =
      (data && data.error && (data.error.message || data.error_description)) ||
      data.error_description ||
      data.error ||
      text.slice(0, 300) ||
      `HTTP ${response.status}`;
    const err = new Error(`Google API HTTP ${response.status}: ${errMsg}`);
    err.status = response.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function exchangeGoogleCode({ code, clientId, clientSecret, redirectUri }) {
  const body = new URLSearchParams({
    code: String(code),
    client_id: String(clientId),
    client_secret: String(clientSecret),
    redirect_uri: String(redirectUri),
    grant_type: 'authorization_code',
  });

  return googleFetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

async function refreshGoogleToken({ refreshToken, clientId, clientSecret }) {
  const body = new URLSearchParams({
    refresh_token: String(refreshToken),
    client_id: String(clientId),
    client_secret: String(clientSecret),
    grant_type: 'refresh_token',
  });

  return googleFetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

async function fetchGoogleUserEmail(accessToken) {
  const data = await googleFetchJson('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data && data.email ? String(data.email) : null;
}

// Full userinfo for login identity: the stable Google account id (`sub`,
// present when the openid scope is granted) plus the account email.
async function fetchGoogleUserInfo(accessToken) {
  const data = await googleFetchJson('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!data) return { email: null, sub: null };
  return {
    email: data.email ? String(data.email) : null,
    sub: data.sub ? String(data.sub) : data.id ? String(data.id) : null,
  };
}

async function getValidGoogleAccessToken(clinicId, clinic, store) {
  const google = clinic && clinic.google;
  if (!google || (!google.accessToken && !google.refreshToken)) {
    return null;
  }

  const now = Date.now();
  if (google.accessToken && google.expiresAt && google.expiresAt > now + 60 * 1000) {
    return google.accessToken;
  }

  if (!google.refreshToken) {
    throw new Error('Google access token expired and no refresh_token is stored.');
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required to refresh tokens.');
  }

  const refreshed = await refreshGoogleToken({
    refreshToken: google.refreshToken,
    clientId,
    clientSecret,
  });

  // Merge latest stored :google section before persisting so concurrent writers are safe.
  const latestGoogle =
    (store && clinicId && (await clinicStore.getClinicSection(store, clinicId, 'google'))) ||
    google;

  const updatedGoogle = {
    ...latestGoogle,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || latestGoogle.refreshToken,
    expiresAt: Date.now() + (Number(refreshed.expires_in) || 3600) * 1000,
  };
  clinic.google = updatedGoogle;

  if (store && clinicId) {
    await clinicStore.saveClinicSection(store, clinicId, 'google', updatedGoogle);
  }

  return updatedGoogle.accessToken;
}

async function createClinicSpreadsheet(accessToken, clinicName) {
  const titleName = clinicName ? `ClinicFlow PH - ${clinicName}` : 'ClinicFlow PH - Clinic Sheet';
  const created = await googleFetchJson('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        title: titleName,
        timeZone: TIMEZONE,
      },
      sheets: [
        { properties: { title: SHEETS.FAQ, gridProperties: { frozenRowCount: 1 } } },
        { properties: { title: SHEETS.LEADS, gridProperties: { frozenRowCount: 1 } } },
        { properties: { title: SHEETS.LOGS, gridProperties: { frozenRowCount: 1 } } },
      ],
    }),
  });

  const spreadsheetId = created.spreadsheetId;
  const spreadsheetUrl =
    created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

  await googleFetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: [
          { range: `${SHEETS.FAQ}!A1:D9`, values: [FAQ_HEADERS, ...SAMPLE_SERVICES] },
          { range: `${SHEETS.LEADS}!A1:J1`, values: [LEAD_HEADERS] },
          { range: `${SHEETS.LOGS}!A1:G1`, values: [LOG_HEADERS] },
        ],
      }),
    }
  );

  return { spreadsheetId, spreadsheetUrl };
}

async function ensureSheetTab(accessToken, spreadsheetId, tabName, headers) {
  await googleFetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: { title: tabName, gridProperties: { frozenRowCount: 1 } },
            },
          },
        ],
      }),
    }
  );

  await googleFetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${encodeURIComponent(`${tabName}!A1`)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [headers] }),
    }
  );
}

async function loadFaqPrices(accessToken, spreadsheetId) {
  if (!accessToken || !spreadsheetId) {
    return {
      items: [],
      formattedText: 'No services listed yet. Ask patient to message our receptionist for rates.',
      truncated: false,
    };
  }

  // Request up to 101 rows (rows 2..102) so we can detect if more than 100 rows exist.
  const range = encodeURIComponent(`${SHEETS.FAQ}!A2:D${MAX_FAQ_ROWS + 2}`);
  const data = await googleFetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${range}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  const allRows = Array.isArray(data.values) ? data.values : [];
  if (allRows.length === 0) {
    return {
      items: [],
      formattedText: 'No services listed yet. Ask patient to message our receptionist for rates.',
      truncated: false,
    };
  }

  let truncated = allRows.length > MAX_FAQ_ROWS;
  const rows = allRows.slice(0, MAX_FAQ_ROWS);
  const items = [];
  const lines = [];
  let charCount = 0;

  for (const row of rows) {
    const service = String(row[0] || '').trim();
    const price = String(row[1] || '').trim();
    const duration = Number(row[2]) || DEFAULT_DURATION_MINS;
    const notes = String(row[3] || '').trim();
    if (!service) continue;

    const line = `- ${service}: ${price} (${duration} mins)${notes ? ' - ' + notes : ''}`;
    if (charCount + line.length + 1 > MAX_FAQ_CHARS) {
      truncated = true;
      break;
    }

    items.push({ service, price, duration, notes });
    lines.push(line);
    charCount += line.length + 1;
  }

  if (items.length === 0) {
    return {
      items: [],
      formattedText: 'No services listed yet. Ask patient to message our receptionist for rates.',
      truncated: false,
    };
  }

  if (truncated) {
    lines.push(
      '[Note: The service list above was truncated due to size limits. For unlisted items, politely ask the patient to wait for the receptionist.]'
    );
  }

  return {
    items,
    formattedText: lines.join('\n'),
    truncated,
  };
}

async function appendSheetRowWithTabFallback(accessToken, spreadsheetId, tabName, rangeSuffix, headers, row) {
  const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId
  )}/values/${encodeURIComponent(`${tabName}!${rangeSuffix}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  try {
    return await googleFetchJson(appendUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [row] }),
    });
  } catch (err) {
    if (err.status === 400 && /Unable to parse range/i.test(err.message)) {
      await ensureSheetTab(accessToken, spreadsheetId, tabName, headers);
      return googleFetchJson(appendUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: [row] }),
      });
    }
    throw err;
  }
}

// Read-only: the most recent rows of Leads_Bookings for the clinic dashboard.
// Returns at most `limit` bookings, newest first, mapped to panel fields.
// Never invents rows: an empty sheet returns an empty array.
async function readRecentBookings(accessToken, spreadsheetId, limit = 10) {
  if (!accessToken || !spreadsheetId) return [];
  const range = encodeURIComponent(`${SHEETS.LEADS}!A2:J`);
  const data = await googleFetchJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${range}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  const rows = Array.isArray(data.values) ? data.values : [];
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  return rows
    .filter((row) => Array.isArray(row) && row.some((cell) => String(cell || '').trim() !== ''))
    .slice(-cap)
    .reverse()
    .map((row) => ({
      timestamp: String(row[0] || ''),
      patient_name: String(row[2] || ''),
      mobile_number: String(row[3] || ''),
      service: String(row[4] || ''),
      preferred_datetime: String(row[5] || ''),
      status: String(row[7] || ''),
    }));
}

async function appendLeadRow(accessToken, spreadsheetId, { senderId, booking, eventId }) {
  const row = [
    getManilaTimestamp(),
    String(senderId || ''),
    booking.patient_name || 'Unknown',
    booking.mobile_number || 'Not provided',
    booking.service || 'General Dental Consultation',
    booking.preferred_datetime_text || '',
    booking.iso_start_time || '',
    'CONFIRMED',
    eventId || 'N/A',
    booking.notes || '',
  ];

  return appendSheetRowWithTabFallback(
    accessToken,
    spreadsheetId,
    SHEETS.LEADS,
    'A:J',
    LEAD_HEADERS,
    row
  );
}

async function appendSystemLog(accessToken, spreadsheetId, { level, senderId, userMsg, aiReply, readyToBook, details }) {
  if (!accessToken || !spreadsheetId) return;
  const row = [
    getManilaTimestamp(),
    String(level || 'INFO'),
    String(senderId || ''),
    String(userMsg || '').slice(0, 1000),
    String(aiReply || '').slice(0, 1000),
    readyToBook ? 'TRUE' : 'FALSE',
    String(details || '').slice(0, 1000),
  ];

  await appendSheetRowWithTabFallback(
    accessToken,
    spreadsheetId,
    SHEETS.LOGS,
    'A:G',
    LOG_HEADERS,
    row
  );
}

async function createCalendarBooking(accessToken, calendarId, { booking, durationMins, clinicAddress, now = new Date() }) {
  let startTime = booking.iso_start_time ? new Date(booking.iso_start_time) : null;
  let needsTimeVerification = false;

  if (!startTime || Number.isNaN(startTime.getTime())) {
    needsTimeVerification = true;
    const { tomorrowYyyyMmDd } = getManilaPromptDates(now);
    startTime = new Date(`${tomorrowYyyyMmDd}T10:00:00+08:00`);
  }

  const mins = Number(durationMins) > 0 ? Number(durationMins) : DEFAULT_DURATION_MINS;
  const endTime = new Date(startTime.getTime() + mins * 60 * 1000);

  const patientName = booking.patient_name || 'New Patient';
  const serviceName = booking.service || 'Dental Appointment';
  const titlePrefix = needsTimeVerification ? '[VERIFY TIME] ' : '[ClinicFlow] ';
  const summary = `${titlePrefix}${patientName} - ${serviceName}`;

  const description = [
    `Patient Name: ${patientName}`,
    `Mobile Number: ${booking.mobile_number || 'N/A'}`,
    `Service: ${serviceName}`,
    `Requested Schedule: ${booking.preferred_datetime_text || 'N/A'}`,
    `Notes: ${booking.notes || 'Booked via Messenger AI'}`,
  ].join('\n');

  const eventBody = {
    summary,
    description,
    location: clinicAddress || '',
    start: {
      dateTime: getManilaIso(startTime),
      timeZone: TIMEZONE,
    },
    end: {
      dateTime: getManilaIso(endTime),
      timeZone: TIMEZONE,
    },
  };

  const calId = calendarId || 'primary';
  const created = await googleFetchJson(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventBody),
    }
  );

  return created.id || 'created';
}

module.exports = {
  TIMEZONE,
  DEFAULT_DURATION_MINS,
  MAX_FAQ_ROWS,
  MAX_FAQ_CHARS,
  SHEETS,
  FAQ_HEADERS,
  LEAD_HEADERS,
  LOG_HEADERS,
  SAMPLE_SERVICES,
  getManilaTimestamp,
  getManilaIso,
  getManilaPromptDates,
  extractSpreadsheetId,
  exchangeGoogleCode,
  refreshGoogleToken,
  fetchGoogleUserEmail,
  fetchGoogleUserInfo,
  readRecentBookings,
  getValidGoogleAccessToken,
  createClinicSpreadsheet,
  loadFaqPrices,
  appendLeadRow,
  appendSystemLog,
  createCalendarBooking,
};
