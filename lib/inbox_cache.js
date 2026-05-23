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
            is_unread, is_starred, has_attachments
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
    hasAttachments: !!row.has_attachments,
  }));
}

// Detect "real" user-facing attachments from a Gmail message payload.
// Returns true if any leaf part has both a filename AND an attachmentId,
// AND it's NOT an inline image (signature logos, embedded photos).
// Walks the part tree recursively to handle nested multipart structures.
function detectHasAttachments(payload) {
  if (!payload) return false;
  let found = false;
  function visit(p) {
    if (found || !p) return;
    if (Array.isArray(p.parts) && p.parts.length) {
      p.parts.forEach(visit);
      return;
    }
    const hasAtt = !!(p.body && p.body.attachmentId);
    const filename = p.filename || "";
    if (!hasAtt || !filename) return;
    // Skip inline images (Content-Disposition: inline OR has Content-ID).
    const headers = Array.isArray(p.headers) ? p.headers : [];
    const headerVal = (name) => {
      const n = name.toLowerCase();
      const h = headers.find((x) => x && x.name && x.name.toLowerCase() === n);
      return h ? String(h.value || "") : "";
    };
    const cd = headerVal("content-disposition").toLowerCase();
    const cid = headerVal("content-id");
    const mimeType = (p.mimeType || "").toLowerCase();
    const isInlineImage = mimeType.startsWith("image/") &&
      (cd.startsWith("inline") || !!cid);
    if (!isInlineImage) found = true;
  }
  visit(payload);
  return found;
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
            // No metadataHeaders filter — we need access to part-level
            // headers (Content-Disposition, Content-ID) so detectHasAttachments
            // can skip inline signature images. Cost is small: the response
            // is still header-only (no body data) so still ~1-2 KB per message.
            g.users.messages.get({
              userId: "me",
              id,
              format: "metadata",
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
          has_attachments: detectHasAttachments(m.payload),
        });
      }
    }

    // 3a. Identify which message_ids are NEW (not yet in cache) — we
    //     need this BEFORE the UPSERT below, because after the upsert
    //     everything looks "known". The financeAlerts module uses this
    //     to push proactive notifications to Finance Delta.
    let newMessageIds = new Set();
    try {
      const financeAlerts = require("./financeAlerts");
      if (financeAlerts.isEnabled()) {
        newMessageIds = await financeAlerts.findNewMessageIds(
          userId,
          rows.map((r) => r.message_id)
        );
      }
    } catch (err) {
      console.warn("[inbox_cache] new-message id lookup failed:", err.message);
    }

    // 3. UPSERT each row + mark anything not in this batch as out-of-inbox.
    if (rows.length) {
      const values = [];
      const params = [];
      rows.forEach((r, i) => {
        const b = i * 15;
        params.push(
          `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7}, $${b+8}, $${b+9}, $${b+10}, $${b+11}, $${b+12}, $${b+13}, $${b+14}, $${b+15})`
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
          true,  // in_inbox
          r.has_attachments || false
        );
      });
      const sql = `
        INSERT INTO inbox_cache
          (user_id, message_id, thread_id, from_header, to_header, cc_header,
           subject, snippet, date_header, internal_date, label_ids,
           is_unread, is_starred, in_inbox, has_attachments)
        VALUES ${params.join(",")}
        ON CONFLICT (user_id, message_id) DO UPDATE SET
          thread_id       = EXCLUDED.thread_id,
          from_header     = EXCLUDED.from_header,
          to_header       = EXCLUDED.to_header,
          cc_header       = EXCLUDED.cc_header,
          subject         = EXCLUDED.subject,
          snippet         = EXCLUDED.snippet,
          date_header     = EXCLUDED.date_header,
          internal_date   = EXCLUDED.internal_date,
          label_ids       = EXCLUDED.label_ids,
          is_unread       = EXCLUDED.is_unread,
          is_starred      = EXCLUDED.is_starred,
          in_inbox        = TRUE,
          has_attachments = EXCLUDED.has_attachments,
          fetched_at      = NOW()
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

    // 3b. Mirror newly-seen rows into gmail_messages_indexed so the
    //     search_inbox tool can find them. The one-shot backfill worker
    //     populates that table for historical mail, but stops once a
    //     user's job is "completed" — so without this hook, NEW mail
    //     would never be searchable and the Delta bridge would tell
    //     Finance "no recent emails" even when there are some.
    //     Best-effort, never fails the sync.
    if (newMessageIds.size) {
      try {
        const freshRows = rows.filter((r) => newMessageIds.has(r.message_id));
        await indexFreshMessages(userId, freshRows);
      } catch (err) {
        console.warn(`[inbox_cache] indexing new messages failed:`, err.message);
      }
    }

    // 3c. Phase 5.AK — Check if any of the newly-seen messages
    //     fulfills an open commitment in that thread. Conservative
    //     logic: an inbound reply FROM the original recipient in the
    //     same thread marks all open commitments in that thread as
    //     fulfilled. Best-effort.
    if (newMessageIds.size) {
      try {
        const commitments = require("./commitments");
        const u = await pool.query(
          `SELECT id, email, display_name FROM users WHERE id = $1`,
          [userId]
        );
        if (u.rows[0]) {
          const freshRows = rows.filter((r) => newMessageIds.has(r.message_id));
          for (const m of freshRows) {
            try {
              await commitments.maybeFulfillFromInbound(u.rows[0], m);
            } catch (_) {}
          }
        }
      } catch (err) {
        console.warn(`[inbox_cache] commitment-fulfill hook failed:`, err.message);
      }
    }

    // 4. Fire proactive finance-alerts for any genuinely new messages
    //    we just learned about. Done AFTER recordSyncResult so even if
    //    Finance Delta is slow/down, sync state is committed first.
    //    Best-effort — failures never roll back the sync result.
    if (newMessageIds.size) {
      try {
        const financeAlerts = require("./financeAlerts");
        if (financeAlerts.isEnabled()) {
          // Fetch the user row so financeAlerts can include the
          // recipient identity in the payload.
          const u = await pool.query(
            `SELECT id, email, display_name FROM users WHERE id = $1`,
            [userId]
          );
          if (u.rows[0]) {
            const freshRows = rows.filter((r) => newMessageIds.has(r.message_id));
            // Fire-and-forget — don't block the syncForUser caller.
            setImmediate(() => {
              financeAlerts.alertNewMessages({
                user: u.rows[0],
                messages: freshRows,
              }).catch((err) => {
                console.warn("[inbox_cache] finance-alert push failed:", err.message);
              });
            });
          }
        }
      } catch (err) {
        console.warn("[inbox_cache] finance-alert hook failed:", err.message);
      }
    }

    return { count: rows.length, new_count: newMessageIds.size };
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
// Split a raw From header into ("Lana Silk", "lana@…") parts. Mirrors
// the parser used by the backfill worker so search_inbox results are
// consistent regardless of which path inserted the row.
function splitFromHeader(rawFrom) {
  if (!rawFrom) return { from_name: "", from_email: "" };
  const m = String(rawFrom).match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (m) {
    return { from_name: m[1].trim(), from_email: m[2].toLowerCase().trim() };
  }
  // Bare email, no display name
  if (rawFrom.includes("@")) {
    return { from_name: "", from_email: rawFrom.toLowerCase().trim() };
  }
  return { from_name: rawFrom.trim(), from_email: "" };
}

// Mirror NEW inbox-cache rows into gmail_messages_indexed so the
// search_inbox tool can find them. Idempotent: ON CONFLICT we update
// snippet/subject/labels (in case a later sync brings a fresher
// version) but never trample from_email if a backfill worker already
// filled it in.
async function indexFreshMessages(userId, freshRows) {
  if (!freshRows || !freshRows.length) return 0;
  const values = [];
  const params = [];
  let inserted = 0;
  freshRows.forEach((r, i) => {
    const { from_name, from_email } = splitFromHeader(r.from_header || "");
    const b = i * 13;
    params.push(
      `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7}, $${b+8}, $${b+9}, $${b+10}, $${b+11}, $${b+12}, $${b+13})`
    );
    // parse date_header into a timestamptz (Gmail emits RFC 2822
    // strings, JS Date handles them); fall back to internal_date if
    // the header is malformed.
    let dateSent = null;
    if (r.date_header) {
      const parsed = new Date(r.date_header);
      if (!isNaN(parsed.getTime())) dateSent = parsed.toISOString();
    }
    if (!dateSent && r.internal_date) {
      dateSent = new Date(Number(r.internal_date)).toISOString();
    }
    const labelsCsv = Array.isArray(r.label_ids) ? r.label_ids.join(",") : (r.label_ids || "");
    const isSent = Array.isArray(r.label_ids) && r.label_ids.includes("SENT");
    values.push(
      userId,
      r.message_id,
      r.thread_id || null,
      r.internal_date ? Number(r.internal_date) : null,
      dateSent,
      from_name || null,
      from_email || null,
      r.to_header || null,
      r.cc_header || null,
      r.subject || null,
      r.snippet || null,
      labelsCsv || null,
      isSent
    );
  });
  const sql = `
    INSERT INTO gmail_messages_indexed
      (user_id, message_id, thread_id, internal_date, date_sent,
       from_name, from_email, to_emails, cc_emails, subject, snippet,
       labels, is_sent)
    VALUES ${params.join(",")}
    ON CONFLICT (user_id, message_id) DO UPDATE SET
      thread_id     = COALESCE(EXCLUDED.thread_id, gmail_messages_indexed.thread_id),
      internal_date = COALESCE(EXCLUDED.internal_date, gmail_messages_indexed.internal_date),
      date_sent     = COALESCE(EXCLUDED.date_sent, gmail_messages_indexed.date_sent),
      from_name     = COALESCE(gmail_messages_indexed.from_name, EXCLUDED.from_name),
      from_email    = COALESCE(gmail_messages_indexed.from_email, EXCLUDED.from_email),
      to_emails     = COALESCE(EXCLUDED.to_emails, gmail_messages_indexed.to_emails),
      cc_emails     = COALESCE(EXCLUDED.cc_emails, gmail_messages_indexed.cc_emails),
      subject       = COALESCE(EXCLUDED.subject, gmail_messages_indexed.subject),
      snippet       = EXCLUDED.snippet,
      labels        = EXCLUDED.labels,
      is_sent       = EXCLUDED.is_sent
    RETURNING (xmax = 0) AS was_insert
  `;
  const r = await pool.query(sql, values);
  inserted = r.rows.filter((row) => row.was_insert).length;
  if (inserted > 0) {
    console.log(`[inbox_cache] indexed ${inserted} new message(s) into gmail_messages_indexed for user ${userId}`);
  }
  return inserted;
}

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
// One-shot catch-up: find any row that exists in inbox_cache but is
// missing from gmail_messages_indexed and copy it across. Intended to
// be called once on boot (after the indexFreshMessages hook ships) to
// repair users whose recent mail landed during the no-index window.
async function reindexMissingFromCache(userId) {
  const r = await pool.query(
    `SELECT ic.*
       FROM inbox_cache ic
       LEFT JOIN gmail_messages_indexed gmi
              ON gmi.user_id = ic.user_id
             AND gmi.message_id = ic.message_id
      WHERE ic.user_id = $1
        AND gmi.message_id IS NULL`,
    [userId]
  );
  if (!r.rows.length) return 0;
  return indexFreshMessages(userId, r.rows);
}

// Bulk variant — runs reindexMissingFromCache for every user that has
// any inbox_cache rows. Called once on boot.
async function reindexMissingForAllUsers() {
  const r = await pool.query(
    `SELECT DISTINCT user_id FROM inbox_cache`
  );
  let total = 0;
  for (const row of r.rows) {
    try {
      total += await reindexMissingFromCache(row.user_id);
    } catch (err) {
      console.warn(`[inbox_cache] catch-up index failed for user ${row.user_id}:`, err.message);
    }
  }
  if (total > 0) {
    console.log(`[inbox_cache] boot-time catch-up indexed ${total} messages across all users`);
  }
  return total;
}

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
  indexFreshMessages,
  reindexMissingFromCache,
  reindexMissingForAllUsers,
  splitFromHeader,
  CACHE_DEPTH,
};
