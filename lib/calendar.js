// Google Calendar integration — read + create + update + delete events
// across all calendars the user has access to. The OAuth scope
// 'https://www.googleapis.com/auth/calendar' is already requested at
// sign-in time so we can read AND write without re-consent.

const { google } = require("googleapis");
const { authedClientFromTokens } = require("./gmail");
const { loadGoogleCreds } = require("./auth");

function clientFor(userId) {
  return loadGoogleCreds(userId).then((creds) => {
    if (!creds) throw new Error("no_google_creds");
    const oauth = authedClientFromTokens(creds);
    return google.calendar({ version: "v3", auth: oauth });
  });
}

// List the user's accessible calendars. Returns minimal metadata —
// id (calendar email-like address), summary (display name), color,
// access role, primary flag, hidden flag. The rail uses this to render
// the per-calendar toggle list with brand-aware color dots.
async function listCalendars(userId) {
  const cal = await clientFor(userId);
  const r = await cal.calendarList.list({
    maxResults: 100,
    minAccessRole: "reader",
  });
  return (r.data.items || []).map((c) => ({
    id: c.id,
    summary: c.summaryOverride || c.summary || c.id,
    description: c.description || "",
    color: c.backgroundColor || "#5B7CA3",
    foregroundColor: c.foregroundColor || "#FFFFFF",
    primary: !!c.primary,
    accessRole: c.accessRole,
    selected: c.selected !== false,         // Google's per-calendar visibility flag
    timeZone: c.timeZone,
  }));
}

// Fetch events from one or more calendars between start and end (both
// ISO strings). Caller picks the date range; the frontend asks for the
// current month plus a few days of bleed on either side.
async function listEvents(userId, { start, end, calendarIds }) {
  const cal = await clientFor(userId);

  // If no list provided, use the calendars Google considers "selected"
  // (the same set the user sees in Google Calendar by default).
  let ids = Array.isArray(calendarIds) && calendarIds.length
    ? calendarIds
    : (await listCalendars(userId))
        .filter((c) => c.selected)
        .map((c) => c.id);

  const tMin = new Date(start).toISOString();
  const tMax = new Date(end).toISOString();

  // Parallelize across calendars but cap concurrency so we don't blast
  // the Google API on accounts with many shared calendars.
  const CHUNK = 6;
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const results = await Promise.all(
      slice.map((cid) =>
        cal.events
          .list({
            calendarId: cid,
            timeMin: tMin,
            timeMax: tMax,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 250,
          })
          .then((r) => ({ cid, items: r.data.items || [] }))
          .catch((err) => {
            console.warn(`[calendar] events.list failed for ${cid}:`, err.message);
            return { cid, items: [] };
          })
      )
    );
    for (const { cid, items } of results) {
      for (const ev of items) {
        out.push(shapeEvent(ev, cid));
      }
    }
  }
  return out;
}

// Normalize Google's event shape into something the frontend can render
// cleanly. Distinguishes timed events (start.dateTime) from all-day
// events (start.date — no time component, exclusive end).
function shapeEvent(ev, calendarId) {
  const allDay = !!(ev.start?.date && !ev.start?.dateTime);
  return {
    id: ev.id,
    calendarId,
    summary: ev.summary || "(no title)",
    description: ev.description || "",
    location: ev.location || "",
    allDay,
    start: allDay ? ev.start.date : (ev.start?.dateTime || null),
    end: allDay ? ev.end?.date : (ev.end?.dateTime || null),
    startTimeZone: ev.start?.timeZone || null,
    htmlLink: ev.htmlLink || "",
    attendees: Array.isArray(ev.attendees)
      ? ev.attendees.map((a) => ({ email: a.email, name: a.displayName, response: a.responseStatus }))
      : [],
    organizer: ev.organizer ? { email: ev.organizer.email, name: ev.organizer.displayName } : null,
    creator: ev.creator ? { email: ev.creator.email } : null,
    status: ev.status || "confirmed",
    recurring: !!ev.recurringEventId,
    conferenceUri: ev.conferenceData?.entryPoints?.[0]?.uri || null,
    hangoutLink: ev.hangoutLink || null,
    colorId: ev.colorId || null,
  };
}

async function createEvent(userId, { calendarId, summary, description, location, start, end, allDay, attendees, conference }) {
  const cal = await clientFor(userId);
  const cid = calendarId || "primary";
  const requestBody = {
    summary: summary || "(no title)",
    description: description || undefined,
    location: location || undefined,
  };
  if (allDay) {
    requestBody.start = { date: ymd(start) };
    // Google's all-day end.date is EXCLUSIVE — add one day so a single-day
    // event is valid (end must be after start) and multi-day spans are right.
    const ed = new Date(ymd(end || start) + "T00:00:00Z");
    ed.setUTCDate(ed.getUTCDate() + 1);
    requestBody.end = { date: ymd(ed) };
  } else {
    requestBody.start = { dateTime: new Date(start).toISOString() };
    requestBody.end   = { dateTime: new Date(end || start).toISOString() };
  }
  if (Array.isArray(attendees) && attendees.length) {
    requestBody.attendees = attendees.map((a) =>
      typeof a === "string" ? { email: a } : a
    );
  }
  const params = { calendarId: cid, requestBody };
  if (conference) {
    requestBody.conferenceData = {
      createRequest: { requestId: `delta-${Date.now()}` },
    };
    params.conferenceDataVersion = 1;
  }
  const r = await cal.events.insert(params);
  return shapeEvent(r.data, cid);
}

async function updateEvent(userId, { calendarId, eventId, patch }) {
  const cal = await clientFor(userId);
  const cid = calendarId || "primary";
  // Pull current event first so we can merge partial patches cleanly.
  const current = await cal.events.get({ calendarId: cid, eventId });
  const requestBody = { ...current.data };
  if (patch.summary !== undefined)     requestBody.summary = patch.summary;
  if (patch.description !== undefined) requestBody.description = patch.description;
  if (patch.location !== undefined)    requestBody.location = patch.location;
  if (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined) {
    const isAllDay = patch.allDay !== undefined ? patch.allDay : !!(current.data.start?.date);
    if (isAllDay) {
      requestBody.start = { date: ymd(patch.start || current.data.start?.date || current.data.start?.dateTime) };
      requestBody.end   = { date: ymd(patch.end || current.data.end?.date || current.data.end?.dateTime) };
    } else {
      requestBody.start = { dateTime: new Date(patch.start || current.data.start?.dateTime || current.data.start?.date).toISOString() };
      requestBody.end   = { dateTime: new Date(patch.end || current.data.end?.dateTime || current.data.end?.date).toISOString() };
    }
  }
  const r = await cal.events.update({ calendarId: cid, eventId, requestBody });
  return shapeEvent(r.data, cid);
}

async function deleteEvent(userId, { calendarId, eventId }) {
  const cal = await clientFor(userId);
  await cal.events.delete({ calendarId: calendarId || "primary", eventId });
}

// 'YYYY-MM-DD' helper for all-day event date fields.
function ymd(d) {
  if (!d) return null;
  const dt = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)
    ? new Date(d + "T00:00:00Z")
    : new Date(d);
  return dt.toISOString().slice(0, 10);
}

// --- Timezone helpers (so working-hours / focus-block checks use the
// user's actual clock, not the server's UTC) ---------------------------
const _tzCache = new Map(); // userId -> { tz, at }
async function getPrimaryTimeZone(userId) {
  const c = _tzCache.get(userId);
  if (c && Date.now() - c.at < 60 * 60 * 1000) return c.tz;
  let tz = "UTC";
  try {
    const cal = await clientFor(userId);
    const r = await cal.calendars.get({ calendarId: "primary" });
    tz = r.data.timeZone || "UTC";
  } catch (_) { /* fall back to UTC */ }
  _tzCache.set(userId, { tz, at: Date.now() });
  return tz;
}
// Day-of-week (0=Sun..6=Sat) + minutes-since-midnight for a Date in an
// IANA timezone.
function partsInTz(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date);
    const wd = parts.find((p) => p.type === "weekday")?.value || "Sun";
    let hh = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10) % 24;
    const mm = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { day: days[wd] ?? 0, minutes: hh * 60 + mm };
  } catch (_) {
    return { day: date.getUTCDay(), minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
  }
}

module.exports = {
  listCalendars,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getPrimaryTimeZone,
  partsInTz,
};
