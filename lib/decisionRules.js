// Delta Decision Rules — Phase 5.AF.
//
// Every meaningful action a user takes on an email gets logged to
// user_action_log with (sender, subject, action). A background miner
// sweeps the log for high-confidence patterns: "user archives 100% of
// emails from newsletter@x.com over the last 30 days, n=12". Patterns
// become delta_rule_candidates the user can confirm in chat. Confirmed
// candidates become delta_rules that auto-apply to future matching mail.
//
// Public surface:
//   logAction(user, action, msgMeta)        - hook from action endpoints
//   mineCandidates(user)                    - find new patterns (worker)
//   listPendingCandidates(user)             - read pending suggestions
//   confirmCandidate(user, id)              - promote to rule
//   rejectCandidate(user, id)               - mark rejected
//   listActiveRules(user)                   - active rules listing
//   disableRule(user, id) / enableRule()    - admin toggles
//   matchRulesFor(user, fromEmail, subject) - run-time application
//
// Constraints / design notes:
//   - Per-user. Strict user_id FK on every table.
//   - We don't suggest rules with fewer than MIN_SAMPLES occurrences
//     OR with confidence below MIN_CONFIDENCE — keeps noise down.
//   - We don't re-suggest rejected candidates for 90 days.
//   - The user-action-log keeps ~90 days of history; pruning is cheap.

const { pool } = require("./db");

const MIN_SAMPLES = 5;            // need at least N actions on the same sender
const MIN_CONFIDENCE = 0.9;       // 90% of those actions must match
const LOOKBACK_DAYS = 60;         // only consider recent actions
const REJECT_COOLDOWN_DAYS = 90;  // don't re-suggest rejected patterns
const ACTION_LOG_RETENTION_DAYS = 120;

const ALLOWED_ACTIONS = new Set([
  "archive",
  "mark_done",
  "snooze",
  "delete",
  "label",
  "reply",
  "ignore", // explicit "leave in inbox" (future)
]);

// Normalise the From header to just the email portion, lowered.
function extractEmail(fromHeader) {
  if (!fromHeader) return "";
  const m = String(fromHeader).match(/<([^>]+)>/);
  return ((m ? m[1] : fromHeader) || "").toLowerCase().trim();
}
function extractName(fromHeader) {
  if (!fromHeader) return "";
  const m = String(fromHeader).match(/^"?([^"<]+?)"?\s*<[^>]+>/);
  return (m ? m[1] : "").trim();
}
function domainOf(email) {
  if (!email || !email.includes("@")) return "";
  return "@" + email.split("@")[1].toLowerCase();
}

// ---------- logging ----------

// Look up cached metadata for a thread id (uses inbox_cache, which we
// already keep populated by the cache worker). Lets action endpoints
// log without doing an extra Gmail API call.
async function lookupThreadMeta(userId, threadId) {
  if (!userId || !threadId) return null;
  try {
    const r = await pool.query(
      `SELECT message_id, from_header, subject
         FROM inbox_cache
        WHERE user_id = $1 AND thread_id = $2
        ORDER BY internal_date DESC NULLS LAST
        LIMIT 1`,
      [userId, threadId]
    );
    return r.rows[0] || null;
  } catch (err) {
    console.warn("[decisionRules.lookupThreadMeta] failed:", err.message);
    return null;
  }
}

// Convenience wrapper: log an action against a list of thread ids by
// looking up each thread's metadata from inbox_cache. Used by bulk
// action endpoints where we only have thread ids in hand.
async function logActionsForThreads(user, action, threadIds, signals = null) {
  if (!user?.id || !ALLOWED_ACTIONS.has(action) || !threadIds?.length) return;
  for (const tid of threadIds) {
    const meta = await lookupThreadMeta(user.id, tid);
    if (!meta) continue; // cache miss — skip
    await logAction(user, action, {
      messageId: meta.message_id,
      threadId: tid,
      from: meta.from_header,
      subject: meta.subject,
      signals,
    });
  }
}

async function logAction(user, action, { messageId, threadId, from, subject, signals } = {}) {
  if (!user?.id || !ALLOWED_ACTIONS.has(action)) return;
  try {
    await pool.query(
      `INSERT INTO user_action_log
         (user_id, message_id, thread_id, from_email, from_name, subject, action, signals)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        user.id,
        messageId || null,
        threadId || null,
        extractEmail(from) || null,
        extractName(from) || null,
        subject ? String(subject).slice(0, 500) : null,
        action,
        signals ? JSON.stringify(signals) : null,
      ]
    );
  } catch (err) {
    // Action logging is best-effort — never block the underlying action.
    console.warn("[decisionRules.logAction] failed:", err.message);
  }
}

// ---------- mining ----------

// Looks for sender-level patterns: among the user's last N days of
// actions, find any sender where >= MIN_SAMPLES actions exist and
// >= MIN_CONFIDENCE of them are the same action. Returns an array of
// suggestion drafts ready to be UPSERTed into delta_rule_candidates.
async function findSenderPatterns(userId) {
  const r = await pool.query(
    `WITH recent AS (
       SELECT LOWER(from_email) AS email, action
         FROM user_action_log
        WHERE user_id = $1
          AND from_email IS NOT NULL
          AND from_email <> ''
          AND taken_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
     ),
     by_sender AS (
       SELECT email, action,
              COUNT(*)::int AS hits,
              SUM(COUNT(*)) OVER (PARTITION BY email)::int AS total_hits
         FROM recent
        GROUP BY email, action
     )
     SELECT email, action, hits, total_hits,
            (hits::real / NULLIF(total_hits, 0))::real AS confidence,
            NOW() AS last_observed_at
       FROM by_sender
      WHERE total_hits >= $2
        AND (hits::real / NULLIF(total_hits, 0)) >= $3
      ORDER BY total_hits DESC, confidence DESC`,
    [userId, MIN_SAMPLES, MIN_CONFIDENCE]
  );
  return r.rows.map((row) => ({
    kind: "sender",
    match_value: row.email,
    action: row.action,
    sample_count: row.hits,
    confidence: row.confidence,
    last_observed_at: row.last_observed_at,
  }));
}

// UPSERT pattern candidates into delta_rule_candidates. We skip any
// candidate already CONFIRMED (already a rule) or recently REJECTED.
async function persistCandidates(userId, drafts) {
  let inserted = 0;
  for (const d of drafts) {
    try {
      // Skip if there's already an active rule for this exact pattern.
      const existingRule = await pool.query(
        `SELECT 1 FROM delta_rules
          WHERE user_id = $1 AND kind = $2 AND LOWER(match_value) = LOWER($3) AND action = $4 AND enabled`,
        [userId, d.kind, d.match_value, d.action]
      );
      if (existingRule.rowCount) continue;

      // Skip if a recently-rejected candidate already exists.
      const rejected = await pool.query(
        `SELECT 1 FROM delta_rule_candidates
          WHERE user_id = $1 AND kind = $2 AND LOWER(match_value) = LOWER($3) AND action = $4
            AND status = 'rejected'
            AND decided_at > NOW() - INTERVAL '${REJECT_COOLDOWN_DAYS} days'`,
        [userId, d.kind, d.match_value, d.action]
      );
      if (rejected.rowCount) continue;

      const r = await pool.query(
        `INSERT INTO delta_rule_candidates
           (user_id, kind, match_value, action, sample_count, confidence, last_observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, kind, LOWER(match_value), action) DO UPDATE
           SET sample_count     = EXCLUDED.sample_count,
               confidence       = EXCLUDED.confidence,
               last_observed_at = EXCLUDED.last_observed_at,
               -- bump pending back to pending if it had been auto-dismissed,
               -- but don't override confirmed/rejected.
               status           = CASE WHEN delta_rule_candidates.status = 'pending'
                                       THEN 'pending'
                                       ELSE delta_rule_candidates.status END
         RETURNING id, (xmax = 0) AS was_insert`,
        [userId, d.kind, d.match_value, d.action, d.sample_count, d.confidence, d.last_observed_at]
      );
      if (r.rows[0]?.was_insert) inserted++;
    } catch (err) {
      console.warn("[decisionRules.persistCandidates] one row failed:", err.message);
    }
  }
  return inserted;
}

async function mineCandidates(userId) {
  const drafts = await findSenderPatterns(userId);
  if (!drafts.length) return { inserted: 0, considered: 0 };
  const inserted = await persistCandidates(userId, drafts);
  return { inserted, considered: drafts.length };
}

// ---------- read-side ----------

async function listPendingCandidates(userId, { limit = 5 } = {}) {
  const r = await pool.query(
    `SELECT id, kind, match_value, action, sample_count, confidence,
            last_observed_at, suggested_at
       FROM delta_rule_candidates
      WHERE user_id = $1 AND status = 'pending'
      ORDER BY confidence DESC, sample_count DESC, suggested_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return r.rows;
}

async function listActiveRules(userId) {
  const r = await pool.query(
    `SELECT id, kind, match_value, action, hits_count, created_at, last_hit_at, enabled
       FROM delta_rules
      WHERE user_id = $1
      ORDER BY enabled DESC, hits_count DESC, created_at DESC`,
    [userId]
  );
  return r.rows;
}

// ---------- decisions ----------

async function confirmCandidate(userId, candidateId) {
  const r = await pool.query(
    `SELECT id, kind, match_value, action, status
       FROM delta_rule_candidates
      WHERE user_id = $1 AND id = $2`,
    [userId, candidateId]
  );
  const cand = r.rows[0];
  if (!cand) return { ok: false, error: "not_found" };
  if (cand.status === "confirmed") return { ok: true, rule_already_exists: true };

  const ins = await pool.query(
    `INSERT INTO delta_rules (user_id, kind, match_value, action, source_candidate_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, kind, match_value, action, enabled, hits_count, created_at`,
    [userId, cand.kind, cand.match_value, cand.action, cand.id]
  );
  await pool.query(
    `UPDATE delta_rule_candidates
        SET status = 'confirmed', decided_at = NOW()
      WHERE user_id = $1 AND id = $2`,
    [userId, candidateId]
  );
  return { ok: true, rule: ins.rows[0] };
}

async function rejectCandidate(userId, candidateId) {
  const r = await pool.query(
    `UPDATE delta_rule_candidates
        SET status = 'rejected', decided_at = NOW()
      WHERE user_id = $1 AND id = $2 AND status = 'pending'
      RETURNING id`,
    [userId, candidateId]
  );
  return { ok: r.rowCount > 0 };
}

async function disableRule(userId, ruleId) {
  const r = await pool.query(
    `UPDATE delta_rules SET enabled = FALSE
      WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, ruleId]
  );
  return { ok: r.rowCount > 0 };
}

async function enableRule(userId, ruleId) {
  const r = await pool.query(
    `UPDATE delta_rules SET enabled = TRUE
      WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, ruleId]
  );
  return { ok: r.rowCount > 0 };
}

async function deleteRule(userId, ruleId) {
  const r = await pool.query(
    `DELETE FROM delta_rules
      WHERE user_id = $1 AND id = $2 RETURNING id`,
    [userId, ruleId]
  );
  return { ok: r.rowCount > 0 };
}

// ---------- run-time application ----------

// Given a sender + subject, return the first active rule that matches.
// Caller is responsible for applying the action. Returns null on no match.
async function matchRulesFor(userId, fromHeader, _subject) {
  const email = extractEmail(fromHeader);
  if (!email) return null;
  const domain = domainOf(email);
  const r = await pool.query(
    `SELECT id, kind, match_value, action
       FROM delta_rules
      WHERE user_id = $1 AND enabled = TRUE
        AND ( (kind = 'sender'        AND LOWER(match_value) = $2)
           OR (kind = 'sender_domain' AND LOWER(match_value) = $3) )
      ORDER BY kind = 'sender' DESC -- prefer exact-sender over domain
      LIMIT 1`,
    [userId, email, domain]
  );
  return r.rows[0] || null;
}

// Apply matching rules to a batch of inbox messages. Side effects per
// matched message: Gmail mutation (archive / trash), inbox-cache
// invalidation, classifier DONE stamp (for mark_done rules), rule hit
// counter bump. Returns the set of message_ids that were rule-handled
// so the caller can strip them before paying classification tokens.
//
// Signature uses (user, gmail, messages) so the caller (server.js
// /api/classify) provides the authed Gmail client it already has.
async function applyRulesTo(user, googleApi, messages) {
  if (!user?.id || !Array.isArray(messages) || !messages.length) {
    return { handled: [], byAction: {} };
  }
  const handled = [];
  const byAction = {};
  for (const m of messages) {
    const rule = await matchRulesFor(user.id, m.from || m.from_header, m.subject);
    if (!rule) continue;

    try {
      if (rule.action === "archive") {
        if (googleApi?.users?.messages?.modify) {
          await googleApi.users.messages.modify({
            userId: "me",
            id: m.id,
            requestBody: { removeLabelIds: ["INBOX"] },
          });
        }
      } else if (rule.action === "delete") {
        if (googleApi?.users?.messages?.trash) {
          await googleApi.users.messages.trash({ userId: "me", id: m.id });
        }
      }
      // mark_done: no Gmail mutation — the caller will stamp our
      // classification table with DONE.
      handled.push({ id: m.id, threadId: m.threadId, action: rule.action, rule_id: rule.id });
      byAction[rule.action] = (byAction[rule.action] || 0) + 1;
      await recordRuleHit(rule.id);

      // Audit-trail the auto-action in user_action_log under a
      // distinct synthetic action so the miner doesn't compound it
      // into more rules.
      await pool.query(
        `INSERT INTO user_action_log
           (user_id, message_id, thread_id, from_email, from_name, subject, action, signals)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          user.id, m.id, m.threadId || null,
          extractEmail(m.from || m.from_header) || null,
          extractName(m.from || m.from_header) || null,
          m.subject ? String(m.subject).slice(0, 500) : null,
          "rule_auto_" + rule.action,
          JSON.stringify({ rule_id: rule.id, kind: rule.kind, match: rule.match_value }),
        ]
      );
    } catch (err) {
      console.warn(`[decisionRules.applyRulesTo] rule ${rule.id} failed on msg ${m.id}:`, err.message);
    }
  }
  return { handled, byAction };
}

// Bump hit counter when a rule fires.
async function recordRuleHit(ruleId) {
  try {
    await pool.query(
      `UPDATE delta_rules
          SET hits_count  = hits_count + 1,
              last_hit_at = NOW()
        WHERE id = $1`,
      [ruleId]
    );
  } catch (err) {
    console.warn("[decisionRules.recordRuleHit] failed:", err.message);
  }
}

// ---------- worker helpers ----------

async function listUsersNeedingMine({ limit = 10 } = {}) {
  // Any user with at least MIN_SAMPLES recent actions is worth checking.
  const r = await pool.query(
    `SELECT user_id
       FROM user_action_log
      WHERE taken_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
      GROUP BY user_id
     HAVING COUNT(*) >= $1
      LIMIT $2`,
    [MIN_SAMPLES, limit]
  );
  return r.rows.map((row) => Number(row.user_id));
}

async function prune({ olderThanDays = ACTION_LOG_RETENTION_DAYS } = {}) {
  const r = await pool.query(
    `DELETE FROM user_action_log
      WHERE taken_at < NOW() - ($1 || ' days')::interval
      RETURNING id`,
    [olderThanDays]
  );
  return r.rowCount;
}

// ---------- presentation helpers ----------

const ACTION_LABEL = {
  archive: "archive",
  mark_done: "mark done",
  snooze: "snooze for a week",
  delete: "delete",
  label: "apply a label",
  reply: "reply",
  ignore: "leave in inbox",
};

function describeCandidate(c) {
  const action = ACTION_LABEL[c.action] || c.action;
  const match =
    c.kind === "sender"        ? `every email from ${c.match_value}`
  : c.kind === "sender_domain" ? `every email from ${c.match_value}`
  : `emails matching "${c.match_value}"`;
  const pct = Math.round((c.confidence || 0) * 100);
  return `You ${action}d ${match} ${c.sample_count} times in a row (${pct}% of the time). Want me to do this automatically from now on?`;
}

module.exports = {
  // logging
  logAction,
  logActionsForThreads,
  lookupThreadMeta,
  // mining
  mineCandidates,
  findSenderPatterns,
  // read-side
  listPendingCandidates,
  listActiveRules,
  // decisions
  confirmCandidate,
  rejectCandidate,
  disableRule,
  enableRule,
  deleteRule,
  // runtime
  matchRulesFor,
  applyRulesTo,
  recordRuleHit,
  // workers
  listUsersNeedingMine,
  prune,
  // helpers
  describeCandidate,
  ALLOWED_ACTIONS,
  extractEmail,
  extractName,
};
