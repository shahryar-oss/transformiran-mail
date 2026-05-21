// Gmail Push — Phase 5.AG.
//
// Replaces the 90-second inbox poll with real-time Cloud Pub/Sub
// notifications. Flow:
//
//   1. (one-time, out of band) Operator creates a Pub/Sub topic in
//      GCP, grants `gmail-api-push@system.gserviceaccount.com` the
//      `roles/pubsub.publisher` role on it, and creates a push
//      subscription pointed at https://mail.transformiran.info/api/gmail/push/webhook
//      with a query-string token=$GMAIL_PUSH_TOKEN for auth.
//
//   2. Each user opts in (via /settings or first-open auto-bootstrap):
//      we call gmail.users.watch({ topicName, labelIds: [INBOX] }),
//      store the returned historyId + expiration in gmail_watch.
//
//   3. Pub/Sub POSTs to /api/gmail/push/webhook on every change. The
//      payload is base64-encoded JSON: { emailAddress, historyId }.
//      We compare to our stored historyId, call users.history.list
//      to get the new message ids, then handle each one (cache update,
//      classify, apply rules, etc.).
//
//   4. Watches expire after 7 days. The renewer worker re-issues
//      watch() for any row expiring within 24h.
//
// Graceful degradation: if GMAIL_PUSH_TOPIC isn't set, all functions
// no-op. The poll-based inbox cache continues to work — nothing breaks.

const { pool } = require("./db");
const { google } = require("googleapis");
const { authedClientFromTokens } = require("./gmail");
const { loadGoogleCreds } = require("./auth");

const TOPIC = process.env.GMAIL_PUSH_TOPIC || ""; // e.g. projects/foo/topics/gmail-watch
const PUSH_TOKEN = process.env.GMAIL_PUSH_TOKEN || ""; // shared secret for webhook auth

function isEnabled() {
  return !!TOPIC && !!PUSH_TOKEN;
}

// ---------- start / stop a user's watch ----------

async function startWatchForUser(userId, { labelIds = ["INBOX"] } = {}) {
  if (!isEnabled()) return { ok: false, error: "push_not_configured" };
  const creds = await loadGoogleCreds(userId);
  if (!creds) return { ok: false, error: "no_google_creds" };

  const client = authedClientFromTokens(creds);
  const g = google.gmail({ version: "v1", auth: client });
  try {
    const r = await g.users.watch({
      userId: "me",
      requestBody: {
        topicName: TOPIC,
        labelIds,
        labelFilterBehavior: "INCLUDE",
      },
    });
    const historyId = r.data.historyId ? Number(r.data.historyId) : null;
    const expiration = r.data.expiration ? new Date(Number(r.data.expiration)) : null;
    await pool.query(
      `INSERT INTO gmail_watch (user_id, history_id, expiration_at, topic_name, label_filter, renewed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET history_id    = EXCLUDED.history_id,
             expiration_at = EXCLUDED.expiration_at,
             topic_name    = EXCLUDED.topic_name,
             label_filter  = EXCLUDED.label_filter,
             renewed_at    = NOW(),
             last_error    = NULL`,
      [userId, historyId, expiration, TOPIC, labelIds]
    );
    return { ok: true, historyId, expiration };
  } catch (err) {
    await pool.query(
      `UPDATE gmail_watch SET last_error = $2 WHERE user_id = $1`,
      [userId, err.message]
    );
    console.warn(`[gmailPush.startWatchForUser] user ${userId} failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

async function stopWatchForUser(userId) {
  if (!isEnabled()) return { ok: false, error: "push_not_configured" };
  const creds = await loadGoogleCreds(userId);
  if (creds) {
    try {
      const client = authedClientFromTokens(creds);
      const g = google.gmail({ version: "v1", auth: client });
      await g.users.stop({ userId: "me" });
    } catch (err) {
      console.warn(`[gmailPush.stopWatchForUser] user ${userId} stop failed:`, err.message);
    }
  }
  await pool.query(`DELETE FROM gmail_watch WHERE user_id = $1`, [userId]);
  return { ok: true };
}

async function getWatchStatus(userId) {
  const r = await pool.query(
    `SELECT user_id, history_id, expiration_at, topic_name, label_filter,
            started_at, renewed_at, last_event_at, event_count, last_error
       FROM gmail_watch WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] || null;
}

// ---------- webhook handling ----------

// Decode a Pub/Sub push envelope: req.body = { message: { data: <base64> } }.
// data is base64-encoded JSON: { emailAddress, historyId }.
function decodePushEnvelope(body) {
  try {
    const data = body?.message?.data;
    if (!data) return null;
    const json = Buffer.from(data, "base64").toString("utf8");
    return JSON.parse(json);
  } catch (err) {
    console.warn("[gmailPush.decodePushEnvelope] failed:", err.message);
    return null;
  }
}

// Find a user_id by email address (Gmail's notification gives email, not id).
async function findUserByEmail(emailAddress) {
  if (!emailAddress) return null;
  const r = await pool.query(
    `SELECT id, email, display_name FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [emailAddress]
  );
  return r.rows[0] || null;
}

// Given a user + the historyId from the notification, ask Gmail what
// changed since our last-seen historyId. Returns a deduped list of new
// message ids that need processing.
//
// Notes:
//   - history.list returns *all* changes (messageAdded, labelAdded, etc.).
//     We only care about messagesAdded events to INBOX.
//   - Multiple notifications can fire for the same change — dedupe.
async function fetchNewMessageIds(userId, oauthClient) {
  const watch = await getWatchStatus(userId);
  if (!watch?.history_id) return { ok: false, error: "no_watch_state" };
  const g = google.gmail({ version: "v1", auth: oauthClient });
  try {
    const r = await g.users.history.list({
      userId: "me",
      startHistoryId: String(watch.history_id),
      historyTypes: ["messageAdded"],
      labelId: "INBOX",
    });
    const histories = r.data.history || [];
    const newIds = new Set();
    for (const h of histories) {
      for (const m of h.messagesAdded || []) {
        if (m.message?.id) newIds.add(m.message.id);
      }
    }
    const latestHistoryId = r.data.historyId ? Number(r.data.historyId) : Number(watch.history_id);
    return { ok: true, messageIds: Array.from(newIds), latestHistoryId };
  } catch (err) {
    // Common: 404 / "Requested entity was not found" if our historyId
    // is too old (Gmail retains ~7 days of history). In that case we
    // need to re-watch to get a fresh historyId.
    console.warn(`[gmailPush.fetchNewMessageIds] user ${userId} failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

// Persist progress after we've successfully processed a notification.
async function commitProgress(userId, latestHistoryId) {
  await pool.query(
    `UPDATE gmail_watch
        SET history_id    = $2,
            last_event_at = NOW(),
            event_count   = event_count + 1
      WHERE user_id = $1`,
    [userId, latestHistoryId]
  );
}

// Process new messages: fetch metadata via Gmail (full format), apply
// any decision rules (auto-archive / mark-done / delete), and update
// the inbox_cache. Classifier runs lazily next time the user opens the
// app — so this stays fast.
async function processNewMessages(user, oauthClient, messageIds) {
  if (!messageIds.length) return { processed: 0, ruleHandled: 0 };
  const g = google.gmail({ version: "v1", auth: oauthClient });
  const inboxCache = require("./inbox_cache");
  const decisionRules = require("./decisionRules");
  const mime = require("./mime");

  // Fetch each message metadata. Parallel in chunks of 5 to stay
  // gentle on Gmail rate limits.
  const CHUNK = 5;
  const fetched = [];
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const slice = messageIds.slice(i, i + CHUNK);
    const results = await Promise.all(
      slice.map((id) =>
        g.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date"] })
          .then((r) => r.data)
          .catch(() => null)
      )
    );
    for (let j = 0; j < slice.length; j++) {
      const data = results[j];
      if (!data) continue;
      const headers = mime.headersToMap(data.payload?.headers || []);
      fetched.push({
        id: data.id,
        threadId: data.threadId,
        labelIds: data.labelIds || [],
        snippet: data.snippet || "",
        internalDate: Number(data.internalDate || 0),
        from: headers.from || "",
        to: headers.to || "",
        cc: headers.cc || "",
        subject: headers.subject || "",
        date: headers.date || "",
      });
    }
  }

  // Apply rules. Each rule-handled message gets Gmail-side mutation
  // + DONE classification + inbox_cache invalidation.
  let ruleHandled = 0;
  try {
    const result = await decisionRules.applyRulesTo(user, g, fetched);
    ruleHandled = result.handled.length;
    for (const h of result.handled) {
      try { await inboxCache.invalidateMessage(user.id, h.id); } catch (_) {}
    }
    const markDoneIds = result.handled.filter((h) => h.action === "mark_done").map((h) => h.id);
    if (markDoneIds.length) {
      const classifier = require("./classifier");
      await classifier.markMessagesDone(user.id, markDoneIds, "Auto-applied rule (push)");
    }
  } catch (err) {
    console.warn(`[gmailPush.processNewMessages] rule application failed:`, err.message);
  }

  // Refresh inbox_cache so the user's next /api/messages call sees the
  // new mail instantly. syncForUser is a full re-sync of the top 300
  // inbox messages — not minimal, but rock-solid and idempotent. The
  // poll worker is paused once a watch is active (see worker code) so
  // this push-driven sync is the primary refresh path.
  try {
    await inboxCache.syncForUser(user.id);
  } catch (err) {
    console.warn(`[gmailPush.processNewMessages] cache resync failed:`, err.message);
  }

  return { processed: fetched.length, ruleHandled };
}

// Top-level: webhook calls this. Decodes envelope, finds user,
// fetches new ids, processes, commits progress.
async function handleNotification(body) {
  if (!isEnabled()) return { ok: false, error: "push_not_configured" };
  const decoded = decodePushEnvelope(body);
  if (!decoded?.emailAddress) return { ok: false, error: "bad_envelope" };

  const user = await findUserByEmail(decoded.emailAddress);
  if (!user) return { ok: false, error: "no_user" };

  const creds = await loadGoogleCreds(user.id);
  if (!creds) return { ok: false, error: "no_google_creds" };
  const oauthClient = authedClientFromTokens(creds);

  const fetchRes = await fetchNewMessageIds(user.id, oauthClient);
  if (!fetchRes.ok) {
    // If history is too old, re-watch to recover a usable historyId.
    if (/not.*found|invalid/i.test(fetchRes.error || "")) {
      console.log(`[gmailPush.handleNotification] history expired for user ${user.id}, re-watching`);
      await startWatchForUser(user.id);
    }
    return fetchRes;
  }

  let processed = { processed: 0, ruleHandled: 0 };
  if (fetchRes.messageIds.length) {
    processed = await processNewMessages(user, oauthClient, fetchRes.messageIds);
  }
  await commitProgress(user.id, fetchRes.latestHistoryId);

  return {
    ok: true,
    user_id: user.id,
    historyId: fetchRes.latestHistoryId,
    newMessageIds: fetchRes.messageIds.length,
    ...processed,
  };
}

// ---------- renewer worker helpers ----------

// Find watches expiring within `withinHours` hours and re-issue them.
async function renewExpiring({ withinHours = 24, limit = 10 } = {}) {
  if (!isEnabled()) return { renewed: 0, skipped: "push_not_configured" };
  const r = await pool.query(
    `SELECT user_id
       FROM gmail_watch
      WHERE expiration_at IS NULL
         OR expiration_at < NOW() + ($1 || ' hours')::interval
      LIMIT $2`,
    [withinHours, limit]
  );
  let renewed = 0;
  for (const row of r.rows) {
    const res = await startWatchForUser(Number(row.user_id));
    if (res.ok) renewed++;
  }
  return { renewed };
}

module.exports = {
  isEnabled,
  PUSH_TOKEN,
  TOPIC,
  startWatchForUser,
  stopWatchForUser,
  getWatchStatus,
  decodePushEnvelope,
  findUserByEmail,
  fetchNewMessageIds,
  processNewMessages,
  handleNotification,
  commitProgress,
  renewExpiring,
};
