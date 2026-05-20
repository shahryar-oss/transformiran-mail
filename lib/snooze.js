// Email snooze — archive a thread in Gmail + remember to bring it back at
// a chosen time. The Gmail API doesn't expose Gmail's own snooze, so we
// roll our own: remove INBOX label now, schedule a wake-up that re-adds
// INBOX + UNREAD when the snooze expires.

const { pool } = require("./db");
const { google } = require("googleapis");
const { authedClientFromTokens } = require("./gmail");
const { loadGoogleCreds } = require("./auth");

// ---------------------------------------------------------------------------
// SNOOZE — flag a thread + archive in Gmail
// ---------------------------------------------------------------------------

async function snoozeThread(userId, { messageId, threadId, snoozeUntil, stub }) {
  if (!messageId) throw new Error("messageId_required");
  if (!snoozeUntil) throw new Error("snoozeUntil_required");
  const wakeAt = new Date(snoozeUntil);
  if (isNaN(wakeAt.getTime())) throw new Error("invalid_snoozeUntil");
  if (wakeAt.getTime() <= Date.now() + 30_000) {
    throw new Error("snooze_must_be_future");
  }

  // 1. Remove INBOX label in Gmail. If a threadId was passed, archive the
  //    whole thread; otherwise just the single message.
  try {
    const creds = await loadGoogleCreds(userId);
    if (creds) {
      const oauth = authedClientFromTokens(creds);
      const g = google.gmail({ version: "v1", auth: oauth });
      if (threadId) {
        await g.users.threads.modify({
          userId: "me",
          id: threadId,
          requestBody: { removeLabelIds: ["INBOX"] },
        });
      } else {
        await g.users.messages.modify({
          userId: "me",
          id: messageId,
          requestBody: { removeLabelIds: ["INBOX"] },
        });
      }
    }
  } catch (err) {
    console.warn("[snooze] gmail archive failed:", err.message);
    // Continue anyway — the row gets inserted so worker can still wake it
    // and at least we tracked the user's intent.
  }

  // 2. Persist the snooze row with cached stub for the Snoozed folder UI.
  const s = stub || {};
  const r = await pool.query(
    `INSERT INTO snoozed_messages
       (user_id, message_id, thread_id, snooze_until,
        from_header, subject, snippet, date_header, internal_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, message_id) DO UPDATE SET
       thread_id     = EXCLUDED.thread_id,
       snooze_until  = EXCLUDED.snooze_until,
       snoozed_at    = NOW(),
       from_header   = COALESCE(EXCLUDED.from_header, snoozed_messages.from_header),
       subject       = COALESCE(EXCLUDED.subject, snoozed_messages.subject),
       snippet       = COALESCE(EXCLUDED.snippet, snoozed_messages.snippet),
       date_header   = COALESCE(EXCLUDED.date_header, snoozed_messages.date_header),
       internal_date = COALESCE(EXCLUDED.internal_date, snoozed_messages.internal_date),
       woken_at      = NULL
     RETURNING id, snooze_until`,
    [
      userId, messageId, threadId || null, wakeAt.toISOString(),
      s.from || null, s.subject || null, s.snippet || null,
      s.date || null, s.internalDate ? Number(s.internalDate) : null,
    ]
  );

  // 3. Also drop the row from inbox_cache so the inbox view stops showing it
  //    immediately (without waiting for the next inbox-cache sync).
  try {
    const inboxCache = require("./inbox_cache");
    if (threadId) await inboxCache.invalidateThread(userId, threadId);
    else await inboxCache.invalidateMessage(userId, messageId);
  } catch (_) {}

  return r.rows[0];
}

// Manual un-snooze — re-add INBOX + UNREAD now and delete the row.
async function unsnooze(userId, messageId) {
  const row = await pool.query(
    `SELECT message_id, thread_id FROM snoozed_messages
      WHERE user_id = $1 AND message_id = $2 AND woken_at IS NULL`,
    [userId, messageId]
  );
  if (!row.rows[0]) return null;
  await wakeRow(userId, row.rows[0]);
  return { ok: true };
}

async function wakeRow(userId, snoozedRow) {
  try {
    const creds = await loadGoogleCreds(userId);
    if (creds) {
      const oauth = authedClientFromTokens(creds);
      const g = google.gmail({ version: "v1", auth: oauth });
      const targetId = snoozedRow.thread_id || snoozedRow.message_id;
      if (snoozedRow.thread_id) {
        await g.users.threads.modify({
          userId: "me",
          id: snoozedRow.thread_id,
          requestBody: { addLabelIds: ["INBOX", "UNREAD"] },
        });
      } else {
        await g.users.messages.modify({
          userId: "me",
          id: snoozedRow.message_id,
          requestBody: { addLabelIds: ["INBOX", "UNREAD"] },
        });
      }
    }
  } catch (err) {
    console.warn(`[snooze.wakeRow] gmail label-add failed for ${snoozedRow.message_id}:`, err.message);
  }
  // Mark woken instead of deleting so we can audit / debug.
  await pool.query(
    `UPDATE snoozed_messages SET woken_at = NOW()
      WHERE user_id = $1 AND message_id = $2`,
    [userId, snoozedRow.message_id]
  );
}

// ---------------------------------------------------------------------------
// LIST — for the Snoozed folder
// ---------------------------------------------------------------------------

async function listSnoozed(userId, { limit = 100 } = {}) {
  const r = await pool.query(
    `SELECT id, message_id, thread_id, snooze_until, snoozed_at,
            from_header, subject, snippet, date_header, internal_date
       FROM snoozed_messages
      WHERE user_id = $1 AND woken_at IS NULL
      ORDER BY snooze_until ASC
      LIMIT $2`,
    [userId, limit]
  );
  return r.rows.map((row) => ({
    id: row.message_id,
    threadId: row.thread_id,
    snoozeUntil: row.snooze_until,
    snoozedAt: row.snoozed_at,
    from: row.from_header || "",
    subject: row.subject || "(no subject)",
    snippet: row.snippet || "",
    date: row.date_header || "",
    internalDate: row.internal_date ? String(row.internal_date) : null,
    labelIds: [],
    unread: false,
  }));
}

// ---------------------------------------------------------------------------
// WAKE WORKER — process due snoozes
// ---------------------------------------------------------------------------

async function wakeDue({ limit = 50 } = {}) {
  const r = await pool.query(
    `SELECT user_id, message_id, thread_id
       FROM snoozed_messages
      WHERE woken_at IS NULL AND snooze_until <= NOW()
      ORDER BY snooze_until ASC
      LIMIT $1`,
    [limit]
  );
  let woken = 0;
  for (const row of r.rows) {
    try {
      await wakeRow(row.user_id, row);
      woken++;
    } catch (err) {
      console.warn(`[snooze.wakeDue] failed for user=${row.user_id} msg=${row.message_id}:`, err.message);
    }
  }
  if (woken > 0) console.log(`[snooze] woke ${woken} message${woken === 1 ? "" : "s"}`);
  return { woken };
}

module.exports = {
  snoozeThread,
  unsnooze,
  listSnoozed,
  wakeDue,
};
