// Proactive finance-email alerts — Phase 5.AJ.
//
// When a NEW message lands in the inbox cache (i.e. previously unknown
// message_id), this module checks whether the email is "finance-
// relevant" by two signals:
//
//   1. Sender on the finance watch-list (Lana / Simon / Robert / Remco
//      — matched as a token in either the display name or the email
//      local-part, case-insensitive).
//   2. Subject or snippet mentions money / accounting concepts.
//
// If either signal fires, we POST a notification to Finance Delta
// over the existing Delta bridge. The Finance side stays free to
// ignore it, render it as a notification, or queue follow-up work.
//
// Dedup: finance_alerts_sent has UNIQUE (user_id, message_id) so we
// can never alert twice for the same message even if cache sync runs
// repeatedly.
//
// The whole thing is best-effort — if Finance is offline or returns
// an error, we record the failure and move on. The user's inbox
// sync is never blocked by a notification failure.

const crypto = require("crypto");
const { pool } = require("./db");

const DEFAULT_FINANCE_NOTIFY_URL = "https://transformiran.info/api/delta-bridge/notify";

// First-name tokens that always trigger a notification, regardless of
// content. Edit via env (FINANCE_WATCH_NAMES, comma-separated) or via
// the upcoming settings UI. Defaults reflect what Shahryar asked for:
// "Lana, Simon, Robert, Remco".
function watchNames() {
  const raw = (process.env.FINANCE_WATCH_NAMES || "").trim();
  if (raw) {
    return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return ["lana", "simon", "robert", "remco"];
}

// Subject/snippet keywords that signal a finance email. Two-tier:
//   STRONG  — single match is enough (very rarely a false positive)
//   GENERIC — needs to co-occur with at least one money-like number /
//             currency symbol to count.
const STRONG_KEYWORDS = [
  // English finance terms
  /\binvoice\b/i,
  /\bwire (transfer|payment|sent|received)\b/i,
  /\bbank transfer\b/i,
  /\bsalary|payslip|payroll\b/i,
  /\bdonation\b/i,
  /\bdonor (gift|letter|receipt)\b/i,
  /\bdeclaratie\b/i,           // NL: expense claim
  /\bbetaling\b/i,             // NL: payment
  /\bdonateur|donatie\b/i,     // NL: donor/donation
  /\bvergoeding\b/i,           // NL: reimbursement
  /\bIBAN[:\s]/i,
  /\bSWIFT[:\s]/i,
  /\bxero\b/i,
  /\bexact (online|nl)?\b/i,
  /\breconcil(e|ed|iation)\b/i,
  /\bbalance sheet\b/i,
  /\bP&L|profit (and|&) loss\b/i,
  /\bcash (position|flow)\b/i,
  /\bbudget\b/i,
  /\ballocation\b/i,
  /\bgrant (application|report|approval)\b/i,
  /\bquickbooks\b/i,
  /\bbookkeep(ing|er)\b/i,
  /\boutstanding (invoice|balance|payment)\b/i,
  // Persian/Farsi finance terms
  /واریز/u,
  /پرداخت/u,
  /حساب (بانکی|مالی)/u,
  /صورتحساب/u,
  /هزینه/u,
  /بودجه/u,
];

const GENERIC_KEYWORDS = [
  /\bpayment\b/i,
  /\bpaid\b/i,
  /\baccount\b/i,
  /\btransfer\b/i,
  /\bbalance\b/i,
  /\brefund\b/i,
  /\breceipt\b/i,
  /\bexpense\b/i,
];

// Money-like signal that elevates GENERIC keywords to a match. Catches
// "$1,000", "€500", "£12.50", "USD 2k", "EUR 10000", "5.000,00".
const MONEY_SIGNAL = /(?:[€$£¥]\s?\d|(?:USD|EUR|GBP|CAD|AUD|CHF|NOK|SEK|DKK|JPY|CNY)\s?\d|\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?\b|\b\d+\s?(?:k|K|thousand|million|m|M|billion|bn)\b)/;

function extractEmail(rawFrom) {
  if (!rawFrom) return "";
  const m = String(rawFrom).match(/<([^>]+)>/);
  return ((m ? m[1] : rawFrom) || "").toLowerCase().trim();
}
function extractName(rawFrom) {
  if (!rawFrom) return "";
  const m = String(rawFrom).match(/^"?([^"<]+?)"?\s*<[^>]+>/);
  return ((m ? m[1] : rawFrom).trim()) || "";
}

// Pull every distinct word/token from a haystack at word boundaries.
function tokens(s) {
  if (!s) return [];
  return String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Returns null on no match, or { reason, sender_match, keyword_match,
// keyword_signal } when this message should be pushed to Finance Delta.
function matchesAlert(message) {
  if (!message) return null;
  const fromEmail = extractEmail(message.from_header || message.from || "");
  const fromName  = extractName(message.from_header  || message.from || "");
  const subject   = String(message.subject || "");
  const snippet   = String(message.snippet || message.bodyText || "");

  // 1. Watch-list sender match: check tokens of display name AND
  //    local-part of email against the watch-list. Avoid substring
  //    matches that could fire on "Simonetta" or "Roberta".
  const haystack = new Set([
    ...tokens(fromName),
    ...tokens(fromEmail.split("@")[0]),
  ]);
  const names = watchNames();
  const senderHits = names.filter((n) => haystack.has(n));
  let sender_match = senderHits[0] || null;

  // 2. Strong keyword match — any one is enough.
  const haystackText = `${subject}\n${snippet}`;
  let keyword_match = null;
  for (const r of STRONG_KEYWORDS) {
    const m = haystackText.match(r);
    if (m) { keyword_match = m[0]; break; }
  }

  // 3. Generic keyword + money signal — both must co-occur.
  let keyword_signal = null;
  if (!keyword_match && MONEY_SIGNAL.test(haystackText)) {
    for (const r of GENERIC_KEYWORDS) {
      const m = haystackText.match(r);
      if (m) { keyword_match = m[0]; keyword_signal = "with-money-signal"; break; }
    }
  }

  if (!sender_match && !keyword_match) return null;

  // Build a human-readable reason.
  const reasons = [];
  if (sender_match) reasons.push(`watchlist-sender:${sender_match}`);
  if (keyword_match) {
    reasons.push(keyword_signal
      ? `keyword:${keyword_match.toLowerCase()} ${keyword_signal}`
      : `keyword:${keyword_match.toLowerCase()}`);
  }

  return {
    reason: reasons.join(" + "),
    sender_match,
    keyword_match,
    keyword_signal,
    from_email: fromEmail,
    from_name: fromName,
  };
}

// ------------------------------------------------------------------
// Sending
// ------------------------------------------------------------------

function isEnabled() {
  // Disabled outright if either env var is missing — the bridge needs
  // both sides agreed on a token.
  return !!process.env.DELTA_BRIDGE_TOKEN
      && !!(process.env.FINANCE_NOTIFY_URL || DEFAULT_FINANCE_NOTIFY_URL);
}

function notifyUrl() {
  return process.env.FINANCE_NOTIFY_URL || DEFAULT_FINANCE_NOTIFY_URL;
}

// Audit-log every push as { direction:out, peer:finance, event:...,
// question_hash:..., reply_length:N, took_ms, request_id, status }.
// Hash the subject+snippet so we never write inbox content to logs.
function logPush({ direction, event, hashSource, replyLength, tookMs, requestId, status, error }) {
  try {
    const h = crypto.createHash("sha256").update(hashSource || "").digest("hex").slice(0, 16);
    const entry = {
      ts: new Date().toISOString(),
      bridge: true,
      direction,
      peer: "finance",
      event,
      content_hash: h,
      reply_length: replyLength || 0,
      took_ms: tookMs,
      request_id: requestId,
      status,
      ...(error ? { error } : {}),
    };
    console.log("[finance-alert]", JSON.stringify(entry));
  } catch (_) {}
}

// Send a single notification. Returns { ok, status, body, took_ms }.
async function pushNotification({ user, message, match }) {
  if (!isEnabled()) {
    return { ok: false, error: "bridge_not_configured" };
  }
  const requestId = `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const payload = {
    event: "incoming_email",
    fromService: "email",
    requestId,
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name || null,
    },
    email: {
      message_id: message.message_id || message.id,
      thread_id: message.thread_id || message.threadId || null,
      from: message.from_header || message.from || "",
      from_email: match.from_email,
      from_name: match.from_name,
      subject: message.subject || "(no subject)",
      snippet: (message.snippet || "").slice(0, 800),
      date_header: message.date_header || message.date || "",
      internal_date: message.internal_date ? Number(message.internal_date) : null,
    },
    match: {
      reason: match.reason,
      sender_match: match.sender_match,
      keyword_match: match.keyword_match,
      keyword_signal: match.keyword_signal,
    },
    // Anti-loop: tell Finance Delta NOT to consult us about this email
    // (it can already see everything it needs in this payload).
    do_not_consult_back: true,
  };

  try {
    const resp = await fetch(notifyUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DELTA_BRIDGE_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await resp.text().catch(() => "");
    const took = Date.now() - startedAt;
    logPush({
      direction: "out",
      event: "incoming_email",
      hashSource: `${payload.email.subject}\n${payload.email.snippet}`,
      replyLength: body.length,
      tookMs: took,
      requestId,
      status: resp.status,
    });
    return { ok: resp.ok, status: resp.status, body: body.slice(0, 500), took_ms: took };
  } catch (err) {
    const took = Date.now() - startedAt;
    logPush({
      direction: "out",
      event: "incoming_email",
      hashSource: `${payload.email.subject}\n${payload.email.snippet}`,
      replyLength: 0,
      tookMs: took,
      requestId,
      status: 0,
      error: err.message,
    });
    return { ok: false, error: err.message };
  }
}

// Persist + dedup. Only sends if the message hasn't been alerted before
// for this user. Returns { sent, skipped, reason }.
async function maybeAlert({ user, message }) {
  const messageId = message.message_id || message.id;
  if (!user?.id || !messageId) return { sent: false, skipped: true, reason: "no_id" };

  const match = matchesAlert(message);
  if (!match) return { sent: false, skipped: true, reason: "no_match" };

  // Dedup: try to claim the slot atomically with INSERT … ON CONFLICT
  // DO NOTHING. If we get a row back, we own this alert. If not,
  // someone else already sent it.
  const claim = await pool.query(
    `INSERT INTO finance_alerts_sent
        (user_id, message_id, thread_id, from_email, subject, reason, delivery_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT (user_id, message_id) DO NOTHING
     RETURNING id`,
    [
      user.id,
      messageId,
      message.thread_id || message.threadId || null,
      match.from_email || null,
      (message.subject || "").slice(0, 500),
      match.reason,
    ]
  );
  if (!claim.rowCount) {
    return { sent: false, skipped: true, reason: "already_sent" };
  }
  const rowId = claim.rows[0].id;

  // Best-effort POST. The dedup row stays even on failure so we don't
  // hammer the finance side with retries; the user can manually replay
  // via the admin endpoint if needed.
  const result = await pushNotification({ user, message, match });

  try {
    await pool.query(
      `UPDATE finance_alerts_sent
          SET delivery_status = $1,
              response_code   = $2,
              response_body   = $3
        WHERE id = $4`,
      [
        result.ok ? "delivered" : "failed",
        result.status || 0,
        result.body || result.error || null,
        rowId,
      ]
    );
  } catch (err) {
    console.warn("[financeAlerts.maybeAlert] status update failed:", err.message);
  }

  return { sent: result.ok, skipped: false, match, result };
}

// Bulk variant — used by syncForUser when N new messages land in one
// cycle. Runs serially so we don't hammer Finance with parallel
// requests if a whole batch arrived at once.
async function alertNewMessages({ user, messages }) {
  if (!user?.id || !Array.isArray(messages) || !messages.length) return { alerted: 0 };
  if (!isEnabled()) return { alerted: 0, skipped: "bridge_not_configured" };
  let alerted = 0;
  for (const m of messages) {
    try {
      const r = await maybeAlert({ user, message: m });
      if (r.sent) alerted++;
    } catch (err) {
      console.warn("[financeAlerts.alertNewMessages] one message failed:", err.message);
    }
  }
  if (alerted > 0) {
    console.log(`[finance-alert] user ${user.id}: pushed ${alerted} alert(s) to Finance Delta`);
  }
  return { alerted };
}

// Used by syncForUser to figure out which message_ids are NEW (not
// yet in inbox_cache for this user). The caller has the freshly-
// fetched batch of ids; we just ask the DB which ones are missing.
async function findNewMessageIds(userId, candidateIds) {
  if (!userId || !candidateIds?.length) return new Set();
  const r = await pool.query(
    `SELECT message_id FROM inbox_cache
      WHERE user_id = $1 AND message_id = ANY($2::text[])`,
    [userId, candidateIds]
  );
  const seen = new Set(r.rows.map((row) => row.message_id));
  const fresh = new Set(candidateIds.filter((id) => !seen.has(id)));
  return fresh;
}

// Admin helper — list recent alerts for diag.
async function listRecent(userId, { limit = 30 } = {}) {
  const r = await pool.query(
    `SELECT id, message_id, thread_id, from_email, subject, reason,
            sent_at, delivery_status, response_code
       FROM finance_alerts_sent
      WHERE user_id = $1
      ORDER BY sent_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return r.rows;
}

module.exports = {
  isEnabled,
  matchesAlert,
  maybeAlert,
  alertNewMessages,
  findNewMessageIds,
  pushNotification,
  listRecent,
  // exposed for tests / settings UI
  watchNames,
  STRONG_KEYWORDS,
  GENERIC_KEYWORDS,
  MONEY_SIGNAL,
};
