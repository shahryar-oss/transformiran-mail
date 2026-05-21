// Inbox cache — Postgres mirror of per-user Gmail inbox metadata so the
// /api/messages?folder=inbox endpoint can serve from cache (~50ms) instead
// of round-tripping Gmail (list + 30 metadata fetches, ~1.5-2s).
//
// Strategy: stale-while-revalidate.
//   - On read: serve cache rows immediately if present.
//   - In background: a worker (server.js) refreshes every user every 90s.
//   - On action: archive / mark-done / send / trash invalidate affected rows
//     so the next read is fresh.

const { pool } = require("./db");
const { google } = require("googleapis");
const { authedClientFromTokens } = require("./gmail");
const { loadGoogleCreds } = require("./auth");

const CACHE_DEPTH = 300;       // mirror up to ~30 days of mail for typical users
const SYNC_FETCH_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

// Returns the most recent N cached inbox messages, ordered newest-first.
// Caller decides whether to use this or fall back to live Gmail.
async function getRecent(userId, { limit = 30 } = {}) {
  const r = await pool.query(
    `SELECT message_id, thread_id, from_header, to_header, cc_header,
            subject, snippet, date_header, internal_date, label_ids,
            is_unread, is_starred
       FROM inbox_cache
      WHERE user_id = $1 AND in_inbox = TRUE
      ORDER BY internal_date DESC NULLS LAST
      LIMIT $2`,
    [userId, limit]
  );
  return r.rows.map((row) => ({
    id: row.message_id,
    threadId: row.thread_id,
    from: row.from_header || "",
    to: row.to_header || "",
    cc: row.cc_header || "",
    subject: row.subject || "(no subject)",
    snippet: row.snippet || "",
    date: row.date_header || "",
    internalDate: row.internal_date ? String(row.internal_date) : null,
    labelIds: row.label_ids || [],
    unread: !!row.is_unread,
  }));
}

async function getState(userId) {
  const r = await pool.query(
    `SELECT last_sync_at, last_sync_count, last_sync_error, sync_in_progress
       FROM inbox_cache_state WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] || null;
}

async function getCountForUser(userId) {
  const r = await pool.query(
    `SELECT COUNT(*)::INT AS n FROM inbox_cache WHERE user_id = $1 AND in_inbox = TRUE`,
    [userId]
  );
  return r.rows[0]?.n || 0;
}

// ---------------------------------------------------------------------------
// SYNC — fetch from Gmail, upsert into cache
// ---------------------------------------------------------------------------

async function setSyncFlag(userId, inProgress) {
  await pool.query(
    `INSERT INTO inbox_cache_state (user_id, sync_in_progress, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       sync_in_progress = EXCLUDED.sync_in_progress,
       updated_at = NOW()`,
    [userId, inProgress]
  );
}

async function recordSyncResult(userId, { count, error }) {
  await pool.query(
    `INSERT INTO inbox_cache_state (user_id, last_sync_at, last_sync_count, last_sync_error, sync_in_progress, updated_at)
     VALUES ($1, NOW(), $2, $3, FALSE, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       last_sync_at = NOW(),
       last_sync_count = EXCLUDED.last_sync_count,
       last_sync_error = EXCLUDED.last_sync_error,
       sync_in_progress = FALSE,
       updated_at = NOW()`,
    [userId, count || 0, error ? String(error).slice(0, 500) : null]
  );
}

// Pulls the latest `CACHE_DEPTH` inbox messages from Gmail and upserts each
// into inbox_cache. Also marks any cached row whose Gmail id we DIDN'T see
// this run as in_inbox=FALSE so they fall out of the cached view naturally
// when the user archives them elsewhere.
// Wrap any promise with a hard timeout so a hung Gmail call can't
// deadlock the worker loop. The timeout is generous (12s) so legitimate
// slow responses still complete, but short enough that we recover from
// a network blackhole within a single cycle.
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timeout after ${ms}ms in ${label || "gmail call"}`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
const GMAIL_LIST_TIMEOUT_MS = 12000;
const GMAIL_GET_TIMEOUT_MS  = 8000;
// If sync_in_progress has been TRUE for more than this long, we treat
// it as stuck (process crashed mid-sync, network hung past worker
// timeout, etc) and force-reclaim it on the next cycle.
const STUCK_SYNC_GRACE_MS = 3 * 60 * 1000; // 3 minutes

async function syncForUser(userId, opts = {}) {
  const state = await getState(userId);
  if (state?.sync_in_progress) {
    // Stuck-flag auto-recovery: if it's been "in progress" for too
    // long, the previous worker crashed mid-sync. Clear it and keep
    // going.
    const updatedAt = state.updated_at ? new Date(state.updated_at).getTime() : 0;
    const stuckFor = Date.now() - updatedAt;
    if (updatedAt && stuckFor > STUCK_SYNC_GRACE_MS) {
      console.warn(`[inbox_cache] user ${userId} sync_in_progress stuck for ${Math.round(stuckFor/1000)}s — auto-clearing`);
      await setSyncFlag(userId, false);
      // fall through to do a fresh sync
    } else if (opts.force) {
      console.warn(`[inbox_cache] user ${userId} force-sync overriding sync_in_progress flag`);
      await setSyncFlag(userId, false);
    } else {
      // Another worker is already syncing this user (recently).
      return { skipped: true, reason: "already_in_progress" };
    }
  }
  await setSyncFlag(userId, true);

  try {
    const creds = await loadGoogleCreds(userId);
    if (!creds) {
      await recordSyncResult(userId, { count: 0, error: "no_google_creds" });
      return { error: "no_google_creds" };
    }
    const oauth = authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: oauth });

    // 1. List the latest CACHE_DEPTH inbox messages (with hard timeout).
    const list = await withTimeout(
      g.users.messages.list({
        userId: "me",
        maxResults: CACHE_DEPTH,
        labelIds: ["INBOX"],
      }),
      GMAIL_LIST_TIMEOUT_MS,
      "users.messages.list"
    );
    const ids = (list.data.messages || []).map((m) => m.id);
    if (!ids.length) {
      // Inbox is empty (rare). Mark everything cached as out-of-inbox.
      await pool.query(
        `UPDATE inbox_cache SET in_inbox = FALSE WHERE user_id = $1 AND in_inbox = TRUE`,
        [userId]
      );
      await recordSyncResult(userId, { count: 0 });
      return { count: 0 };
    }

    // 2. Fetch metadata for each id in parallel chunks. We use format=metadata
    //    with only the headers we need — fast and quota-friendly.
    const rows = [];
    for (let i = 0; i < ids.length; i += SYNC_FETCH_CONCURRENCY) {
      const slice = ids.slice(i, i + SYNC_FETCH_CONCURRENCY);
      const fetches = await Promise.all(
        slice.map((id) =>
          withTimeout(
            g.users.messages.get({
              userId: "me",
              id,
              format: "metadata",
              metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
            }),
            GMAIL_GET_TIMEOUT_MS,
            `messages.get ${id}`
          )
            .then((r) => r.data)
            .catch((err) => {
              console.warn(`[inbox_cache] metadata fetch failed for ${id}:`, err.message);
              return null;
            })
        )
      );
      for (const m of fetches) {
        if (!m) continue;
        const headers = Object.fromEntries(
          (m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
        );
        rows.push({
          message_id: m.id,
          thread_id: m.threadId || null,
          from_header: headers.from || "",
          to_header: headers.to || "",
          cc_header: headers.cc || "",
          subject: headers.subject || "(no subject)",
          snippet: m.snippet || "",
          date_header: headers.date || "",
          internal_date: m.internalDate ? Number(m.internalDate) : null,
          label_ids: m.labelIds || [],
          is_unread: (m.labelIds || []).includes("UNREAD"),
          is_starred: (m.labelIds || []).includes("STARRED"),
        });
      }
    }

    // 3. UPSERT each row + mark anything not in this batch as out-of-inbox.
    if (rows.length) {
      const values = [];
      const params = [];
      rows.forEach((r, i) => {
        const b = i * 14;
        params.push(
          `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7}, $${b+8}, $${b+9}, $${b+10}, $${b+11}, $${b+12}, $${b+13}, $${b+14})`
        );
        values.push(
          userId,
          r.message_id,
          r.thread_id,
          r.from_header,
          r.to_header,
          r.cc_header,
          r.subject,
          r.snippet,
          r.date_header,
          r.internal_date,
          r.label_ids,
          r.is_unread,
          r.is_starred,
          true   // in_inbox
        );
      });
      const sql = `
        INSERT INTO inbox_cache
          (user_id, message_id, thread_id, from_header, to_header, cc_header,
           subject, snippet, date_header, internal_date, label_ids,
           is_unread, is_starred, in_inbox)
        VALUES ${params.join(",")}
        ON CONFLICT (user_id, message_id) DO UPDATE SET
          thread_id     = EXCLUDED.thread_id,
          from_header   = EXCLUDED.from_header,
          to_header     = EXCLUDED.to_header,
          cc_header     = EXCLUDED.cc_header,
          subject       = EXCLUDED.subject,
          snippet       = EXCLUDED.snippet,
          date_header   = EXCLUDED.date_header,
          internal_date = EXCLUDED.internal_date,
          label_ids     = EXCLUDED.label_ids,
          is_unread     = EXCLUDED.is_unread,
          is_starred    = EXCLUDED.is_starred,
          in_inbox      = TRUE,
          fetched_at    = NOW()
      `;
      await pool.query(sql, values);
    }

    // Mark out-of-batch rows as removed from inbox (archived elsewhere etc).
    const seenIds = rows.map((r) => r.message_id);
    if (seenIds.length) {
      await pool.query(
        `UPDATE inbox_cache
            SET in_inbox = FALSE
          WHERE user_id = $1
            AND in_inbox = TRUE
            AND message_id <> ALL($2::text[])`,
        [userId, seenIds]
      );
    }

    await recordSyncResult(userId, { count: rows.length });
    return { count: rows.length };
  } catch (err) {
    console.error(`[inbox_cache] syncForUser ${userId} failed:`, err);
    await recordSyncResult(userId, { count: 0, error: err.message });
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// INVALIDATION — after user actions, flag rows for refresh
// ---------------------------------------------------------------------------

// Removes a thread from the cached inbox view. Used after archive / mark-
// done / trash actions so the row disappears immediately and the next read
// doesn't show stale state.
async function invalidateThread(userId, threadId) {
  if (!threadId) return;
  await pool.query(
    `UPDATE inbox_cache SET in_inbox = FALSE
      WHERE user_id = $1 AND thread_id = $2`,
    [userId, threadId]
  );
}

async function invalidateMessage(userId, messageId) {
  if (!messageId) return;
  await pool.query(
    `UPDATE inbox_cache SET in_inbox = FALSE
      WHERE user_id = $1 AND message_id = $2`,
    [userId, messageId]
  );
}

// Updates the unread flag on a cached row — used by the toolbar "Mark unread"
// action so the bold styling appears immediately on the next render.
async function setUnread(userId, messageId, unread) {
  await pool.query(
    `UPDATE inbox_cache SET is_unread = $3, fetched_at = NOW()
      WHERE user_id = $1 AND message_id = $2`,
    [userId, messageId, !!unread]
  );
}

async function setStarred(userId, messageId, starred) {
  await pool.query(
    `UPDATE inbox_cache SET is_starred = $3, fetched_at = NOW()
      WHERE user_id = $1 AND message_id = $2`,
    [userId, messageId, !!starred]
  );
}

// ---------------------------------------------------------------------------
// WORKER — used by server.js startInboxCacheWorker
// ---------------------------------------------------------------------------

// Returns users due for a refresh: welcomed AND (never synced OR last sync
// > 90s ago). The worker calls syncForUser on each one.
// Called once at boot — clears any stuck sync_in_progress flag from a
// previously hung worker. Without this, the affected users would stay
// locked out until the per-user grace window expires.
async function clearStuckSyncFlags({ olderThanMs = STUCK_SYNC_GRACE_MS } = {}) {
  const r = await pool.query(
    `UPDATE inbox_cache_state
        SET sync_in_progress = FALSE
      WHERE sync_in_progress = TRUE
        AND updated_at < NOW() - ($1 || ' milliseconds')::INTERVAL
      RETURNING user_id`,
    [String(olderThanMs)]
  );
  if (r.rowCount > 0) {
    console.log(`[inbox_cache] cleared ${r.rowCount} stuck sync_in_progress flags on boot`);
  }
  return r.rowCount;
}

async function listUsersDueForSync({ stalerThanMs = 90_000, limit = 10 } = {}) {
  const r = await pool.query(
    `SELECT u.id AS user_id, u.email
       FROM users u
       LEFT JOIN inbox_cache_state s ON s.user_id = u.id
      WHERE u.welcomed_at IS NOT NULL
        AND (s.last_sync_at IS NULL OR s.last_sync_at < NOW() - ($1 || ' milliseconds')::INTERVAL)
        AND COALESCE(s.sync_in_progress, FALSE) = FALSE
      ORDER BY COALESCE(s.last_sync_at, '1970-01-01') ASC
      LIMIT $2`,
    [String(stalerThanMs), limit]
  );
  return r.rows;
}

module.exports = {
  getRecent,
  getState,
  getCountForUser,
  syncForUser,
  invalidateThread,
  invalidateMessage,
  setUnread,
  setStarred,
  listUsersDueForSync,
  clearStuckSyncFlags,
  CACHE_DEPTH,
};
