// Postgres pool + schema initialization.
// Phase 0: minimal schema. Tables get added as features land.

const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
const sslConfig =
  process.env.NODE_ENV === "production" || /render\.com/.test(connectionString || "")
    ? { rejectUnauthorized: false }
    : false;

const pool = new Pool({
  connectionString,
  ssl: sslConfig,
  max: 8,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  console.error("[db] idle client error:", err);
});

async function waitForDb(maxAttempts = 30) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (i === maxAttempts) throw err;
      const delay = Math.min(2000, 200 * i);
      console.warn(`[db] connection attempt ${i} failed, retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function initSchema() {
  // All CREATE TABLE / CREATE INDEX must be idempotent.
  // Add columns with ALTER TABLE ... ADD COLUMN IF NOT EXISTS.

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           BIGSERIAL PRIMARY KEY,
      email        TEXT UNIQUE NOT NULL,
      display_name TEXT,
      picture_url  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ
    );
  `);

  // Idempotent column add — picture_url was added 2026-05-20 (Google OAuth).
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS picture_url TEXT;
  `);

  // welcomed_at — set when the user finishes the first-login welcome flow.
  // NULL → show welcome.html on next GET /. Set → show inbox.html as usual.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS welcomed_at TIMESTAMPTZ;
  `);

  // Per-message classifications — Delta tags each message so the inbox list
  // can show URGENT / REPLY_NEEDED / TASK / FYI / RECEIPT / NEWSLETTER /
  // INTERNAL / AUTO chips without re-running the model on every page load.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_classifications (
      user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id     TEXT   NOT NULL,
      category       TEXT   NOT NULL,
      urgency        TEXT,
      short_reason   TEXT,
      classified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      model          TEXT,
      PRIMARY KEY (user_id, message_id)
    );
  `);
  // Per-row prompt version — bumped in lib/classifier.js when the prompt
  // rules change in a way that requires re-evaluation of existing rows.
  // loadExisting() treats older-version rows as if they don't exist, so
  // they re-classify automatically on next inbox load. No user click needed.
  await pool.query(`
    ALTER TABLE email_classifications
      ADD COLUMN IF NOT EXISTS prompt_version INT NOT NULL DEFAULT 0;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_email_class_user_cat
      ON email_classifications(user_id, category);
  `);

  // Delta Memory — persistent facts about people, topics, or the user themselves.
  // Either added by the user explicitly ("Delta, remember that Pia is allergic to peanuts")
  // or via the Settings UI. Surfaced to Delta automatically when a relevant person
  // shows up in the inbox snapshot / open message.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS delta_memory (
      id             BIGSERIAL PRIMARY KEY,
      user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject        TEXT NOT NULL,            -- 'Pia van Belen', 'Lana Silk', 'self', 'general'
      subject_email  TEXT,                     -- 'pia@transformiran.com' (optional, helps matching)
      category       TEXT,                     -- 'preference', 'birthday', 'fact', 'context', 'sensitivity'
      fact           TEXT NOT NULL,
      source         TEXT,                     -- 'user_request', 'chat', 'manual'
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_delta_memory_user_subject
      ON delta_memory(user_id, lower(subject));
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_delta_memory_user_email
      ON delta_memory(user_id, lower(subject_email))
      WHERE subject_email IS NOT NULL;
  `);

  // Saved prompts — user's library of reusable Delta prompts.
  // Press ↑ in the chat input to open the popover and pick one.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_prompts (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      use_count   INT NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_saved_prompts_user
      ON saved_prompts(user_id, last_used_at DESC NULLS LAST, created_at DESC);
  `);

  // Per-user preferences — model choice, future ones (sign-off, default lang, etc.)
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS preferred_model TEXT;
  `);

  // Compose preferences — signature behavior, default send-from, etc.
  // signature_mode: 'always' | 'first' | 'never'  (default 'always')
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS signature_mode TEXT DEFAULT 'always';
  `);
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS default_send_as TEXT;
  `);

  // ===== HISTORICAL BACKFILL ===========================================
  // Once the user logs in, a background worker indexes their entire Gmail
  // history. Each message is stored as a row here; Delta's search_inbox
  // tool runs against this table. Metadata only by default (no body) —
  // bodies are fetched on demand from Gmail when the user opens the
  // message, so storage stays light (~1 KB / row).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gmail_messages_indexed (
      user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id    TEXT   NOT NULL,
      thread_id     TEXT,
      internal_date BIGINT,           -- epoch millis (Gmail's internalDate)
      date_sent     TIMESTAMPTZ,      -- parsed from Date: header
      from_name     TEXT,
      from_email    TEXT,
      to_emails     TEXT,             -- comma-joined for simplicity
      cc_emails     TEXT,
      subject       TEXT,
      snippet       TEXT,
      labels        TEXT,             -- comma-joined label IDs
      has_attachments BOOLEAN DEFAULT FALSE,
      is_sent       BOOLEAN DEFAULT FALSE,
      indexed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, message_id)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_indexed_user_date
      ON gmail_messages_indexed(user_id, internal_date DESC NULLS LAST);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_indexed_user_from
      ON gmail_messages_indexed(user_id, lower(from_email));
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_indexed_user_subject_trgm
      ON gmail_messages_indexed USING gin (lower(subject) gin_trgm_ops);
  `).catch(async () => {
    // pg_trgm extension may not be available — fall back to a plain index
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_indexed_user_subject
        ON gmail_messages_indexed(user_id, lower(subject));
    `).catch(() => {});
  });

  // Per-contact aggregates — computed from gmail_messages_indexed.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gmail_contacts (
      user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email             TEXT   NOT NULL,
      display_name      TEXT,
      total_received    INT NOT NULL DEFAULT 0,
      total_sent        INT NOT NULL DEFAULT 0,
      first_interaction TIMESTAMPTZ,
      last_interaction  TIMESTAMPTZ,
      last_seen_subject TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, lower(email))
    );
  `).catch(async () => {
    // Postgres doesn't allow expressions in PRIMARY KEY directly — fallback
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gmail_contacts (
        user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email             TEXT   NOT NULL,
        display_name      TEXT,
        total_received    INT NOT NULL DEFAULT 0,
        total_sent        INT NOT NULL DEFAULT 0,
        first_interaction TIMESTAMPTZ,
        last_interaction  TIMESTAMPTZ,
        last_seen_subject TEXT,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, email)
      );
    `);
  });
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_contacts_user_last
      ON gmail_contacts(user_id, last_interaction DESC NULLS LAST);
  `);

  // ===== TASKS (Microsoft To Do-style) =================================
  // task_lists — user-created lists, optionally grouped.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_lists (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      color       TEXT,                    -- hex color or named theme
      group_name  TEXT,                    -- 'Work' / 'Personal' / NULL
      position    INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_task_lists_user_pos
      ON task_lists(user_id, group_name NULLS FIRST, position);
  `);

  // tasks — the core. NULL list_id means it lives in "Tasks" (the catch-all
  // smart list — Microsoft's "All").
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id                BIGSERIAL PRIMARY KEY,
      user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      list_id           BIGINT REFERENCES task_lists(id) ON DELETE SET NULL,
      title             TEXT NOT NULL,
      notes             TEXT,
      due_at            TIMESTAMPTZ,
      reminder_at       TIMESTAMPTZ,
      repeat            TEXT,                     -- 'daily' | 'weekly' | 'monthly' | NULL
      important         BOOLEAN NOT NULL DEFAULT FALSE,
      in_my_day         BOOLEAN NOT NULL DEFAULT FALSE,
      my_day_added_at   TIMESTAMPTZ,
      completed_at      TIMESTAMPTZ,
      source_message_id TEXT,
      source_thread_id  TEXT,
      position          INT NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tasks_user_list
      ON tasks(user_id, list_id NULLS FIRST, completed_at NULLS FIRST, position);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tasks_user_my_day
      ON tasks(user_id, in_my_day) WHERE in_my_day = TRUE AND completed_at IS NULL;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tasks_user_due
      ON tasks(user_id, due_at) WHERE due_at IS NOT NULL AND completed_at IS NULL;
  `);

  // task_steps — sub-tasks / breakdown.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_steps (
      id           BIGSERIAL PRIMARY KEY,
      task_id      BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      completed_at TIMESTAMPTZ,
      position     INT NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_task_steps_task
      ON task_steps(task_id, position);
  `);

  // Backfill job state — one row per user. Resumable across server restarts.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backfill_jobs (
      user_id          BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      status           TEXT NOT NULL DEFAULT 'pending',  -- pending | running | paused | completed | failed
      phase            TEXT NOT NULL DEFAULT 'list',     -- list | meta | done
      next_page_token  TEXT,
      pending_ids      TEXT,                              -- comma-joined message IDs to still fetch
      total_estimated  INT,
      total_indexed    INT NOT NULL DEFAULT 0,
      last_progress_at TIMESTAMPTZ,
      started_at       TIMESTAMPTZ,
      completed_at     TIMESTAMPTZ,
      error            TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Gmail OAuth tokens per user — populated in Phase 1.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gmail_credentials (
      user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      access_token  TEXT,
      refresh_token TEXT,
      expires_at    TIMESTAMPTZ,
      scopes        TEXT,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Phase 5.AC — Embeddings on memory. Each delta_memory row gets a
  // vector embedding (1536-dim from text-embedding-3-small, stored as JSONB)
  // so loadByQuery can do semantic search via cosine similarity. NULL means
  // either the embedding hasn't been generated yet OR OPENAI_API_KEY isn't
  // set (graceful fallback to keyword search).
  await pool.query(`
    ALTER TABLE delta_memory
      ADD COLUMN IF NOT EXISTS embedding JSONB,
      ADD COLUMN IF NOT EXISTS embedding_at TIMESTAMPTZ;
  `);

  // Snoozed messages — per-user. When the user snoozes a thread, we
  // archive it in Gmail (remove INBOX) and store a row here with the
  // wake-at timestamp. A background worker re-adds INBOX + UNREAD when
  // the snooze expires. Cached stub fields let the 'Snoozed' folder
  // render without re-hitting Gmail.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS snoozed_messages (
      id            BIGSERIAL PRIMARY KEY,
      user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id    TEXT NOT NULL,
      thread_id     TEXT,
      snooze_until  TIMESTAMPTZ NOT NULL,
      snoozed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      from_header   TEXT,
      subject       TEXT,
      snippet       TEXT,
      date_header   TEXT,
      internal_date BIGINT,
      woken_at      TIMESTAMPTZ,
      UNIQUE(user_id, message_id)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_snoozed_user_due
      ON snoozed_messages(user_id, snooze_until) WHERE woken_at IS NULL;
  `);

  // Inbox cache — per-user mirror of Gmail inbox metadata so /api/messages
  // can serve the inbox view from Postgres (~50ms) instead of round-tripping
  // Gmail's list + 30 metadata fetches (~1.5-2s). Refreshed by a background
  // worker every 90s and invalidated immediately on user actions.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inbox_cache (
      user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id     TEXT   NOT NULL,
      thread_id      TEXT,
      from_header    TEXT,
      to_header      TEXT,
      cc_header      TEXT,
      subject        TEXT,
      snippet        TEXT,
      date_header    TEXT,
      internal_date  BIGINT,                -- Gmail's internalDate, ms since epoch
      label_ids      TEXT[],
      is_unread      BOOLEAN NOT NULL DEFAULT FALSE,
      is_starred     BOOLEAN NOT NULL DEFAULT FALSE,
      in_inbox       BOOLEAN NOT NULL DEFAULT TRUE,
      has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
      fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, message_id)
    );
  `);
  // Migration: add has_attachments to existing inbox_cache tables.
  // The sync will populate it on next refresh.
  await pool.query(`
    ALTER TABLE inbox_cache
      ADD COLUMN IF NOT EXISTS has_attachments BOOLEAN NOT NULL DEFAULT FALSE;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_inbox_cache_user_inbox_date
      ON inbox_cache(user_id, in_inbox, internal_date DESC);
  `);
  // Per-user sync state — tracks when we last refreshed each user's inbox so
  // the background worker can pace itself + avoid double-syncing concurrent
  // requests. Also drives the 'last refreshed' indicator in the UI.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inbox_cache_state (
      user_id           BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_sync_at      TIMESTAMPTZ,
      last_sync_count   INT DEFAULT 0,
      last_sync_error   TEXT,
      sync_in_progress  BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Contacts — per-user people directory. Sources:
  //   manual     — user typed it
  //   auto-inbox — derived from inbox_cache senders (email-count + last-seen)
  //   google     — synced from Google People (deferred; placeholder column)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id            BIGSERIAL PRIMARY KEY,
      user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL,
      phone         TEXT,
      organization  TEXT,
      job_title     TEXT,
      photo_url     TEXT,
      notes         TEXT,
      source        TEXT NOT NULL DEFAULT 'manual',
      google_resource_name TEXT,
      last_seen_at  TIMESTAMPTZ,
      email_count   INT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_user_email_idx
      ON contacts(user_id, LOWER(email));
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS contacts_user_lastseen_idx
      ON contacts(user_id, last_seen_at DESC NULLS LAST);
  `);

  // Important contacts — per-user list shown as 'Important' folders in the
  // left rail and used by the classifier / routine wizard for VIP weighting.
  // Auto-seeded with org defaults (Lana / Lazarus / Maggie / Pia) on first
  // access; user can add / remove via the + button or the email reader.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS important_contacts (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email       TEXT NOT NULL,
      name        TEXT NOT NULL,
      color       TEXT,
      position    INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_important_contacts_user_email
      ON important_contacts(user_id, LOWER(email));
  `);

  // Phase 5.AE — Edit-diff voice learning.
  //
  // delta_draft_originals: every time Delta drafts a reply, we stash the
  // raw draft text here keyed by a generated draft_id. The client carries
  // that draft_id all the way to /api/gmail/send. On send we look up the
  // original, diff against what was actually sent, and write the diff to
  // delta_draft_edits. A nightly distiller summarises recent diffs into a
  // per-user "voice profile" that gets injected into future drafts.
  //
  // Rows here are pruned after 30 days — they're only useful until a
  // matching send arrives or the user gives up on this draft.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS delta_draft_originals (
      draft_id          TEXT PRIMARY KEY,
      user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_message_id TEXT,
      instructions      TEXT,
      draft_text        TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      consumed_at       TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_draft_originals_user_created
      ON delta_draft_originals(user_id, created_at DESC);
  `);

  // delta_draft_edits: one row per (drafted-by-Delta → sent-by-user) pair.
  // Stores both sides + a simple similarity score so the distiller can
  // weight large edits more heavily and the user can see in /settings how
  // much they're editing Delta's drafts.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS delta_draft_edits (
      id                BIGSERIAL PRIMARY KEY,
      user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      draft_id          TEXT,
      source_message_id TEXT,
      drafted_text      TEXT NOT NULL,
      sent_text         TEXT NOT NULL,
      similarity        REAL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_draft_edits_user_created
      ON delta_draft_edits(user_id, created_at DESC);
  `);

  // delta_voice_profiles: distilled "voice cheatsheet" per user. Single
  // row per user. Gets refreshed by a nightly worker once enough new
  // edits have accumulated since the last distill. Injected into
  // draftReply system prompts so subsequent drafts sound more like the user.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS delta_voice_profiles (
      user_id                 BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      profile_text            TEXT NOT NULL,
      distilled_from_count    INT NOT NULL DEFAULT 0,
      last_edit_id            BIGINT,
      generated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Phase 5.AF — Decision-rule learning.
  //
  // user_action_log: every meaningful action a user takes on an email
  // (archive / mark-done / snooze / label / delete / reply / ignored-X-days)
  // is logged here. The miner sweeps this log for sender-level patterns
  // ("user archives every email from newsletter@x.com") and creates
  // suggestion candidates the user can confirm or reject.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_action_log (
      id            BIGSERIAL PRIMARY KEY,
      user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id    TEXT,
      thread_id     TEXT,
      from_email    TEXT,
      from_name     TEXT,
      subject       TEXT,
      action        TEXT NOT NULL,
      taken_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      signals       JSONB
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_action_log_user_from
      ON user_action_log(user_id, LOWER(from_email), action);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_action_log_user_taken
      ON user_action_log(user_id, taken_at DESC);
  `);

  // delta_rule_candidates: patterns the miner found but hasn't yet
  // confirmed with the user. Each candidate is one of:
  //   kind='sender'         match = lowered email address
  //   kind='sender_domain'  match = '@example.com'
  //   kind='subject_phrase' match = phrase lowered (future)
  // Status moves pending → confirmed (becomes a rule) or rejected
  // (the miner won't re-suggest the same pattern for a while).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS delta_rule_candidates (
      id              BIGSERIAL PRIMARY KEY,
      user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,
      match_value     TEXT NOT NULL,
      action          TEXT NOT NULL,
      sample_count    INT NOT NULL,
      confidence      REAL NOT NULL,
      last_observed_at TIMESTAMPTZ NOT NULL,
      suggested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status          TEXT NOT NULL DEFAULT 'pending',
      decided_at      TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rule_candidates_user_match_action
      ON delta_rule_candidates(user_id, kind, LOWER(match_value), action);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rule_candidates_pending
      ON delta_rule_candidates(user_id, status, suggested_at DESC)
      WHERE status = 'pending';
  `);

  // Phase 5.AL — Per-message extractions cache. When the user opens
  // an email, we extract two things in one Claude call:
  //   (a) ACTION_ITEMS — things the sender is asking the user to do.
  //       Different from commitments (those are what the USER promised
  //       in outbound). These get a 1-click "Add to tasks" button.
  //   (b) SMART_REPLIES — three voice-matched one-tap reply chips.
  //
  // Cached per (user_id, message_id) so opening the same email twice
  // costs nothing. input_hash = sha256(body) — if the body changes
  // (rare), the cache is invalidated.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_extractions (
      id                BIGSERIAL PRIMARY KEY,
      user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id        TEXT NOT NULL,
      thread_id         TEXT,
      action_items      JSONB,
      smart_replies     JSONB,
      input_hash        TEXT,
      extractor_version INT NOT NULL DEFAULT 1,
      extracted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, message_id)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_email_extractions_user_extracted
      ON email_extractions(user_id, extracted_at DESC);
  `);

  // Phase 5.AK — Commitment / promise tracker. Every time the user
  // sends an email, an extractor reads the body and pulls out any
  // commitments they made ("I'll send the budget Friday", "Will check
  // with Lana and revert tomorrow"). Stored here with parsed deadline.
  // Status flips to 'fulfilled' when a follow-up reply lands in the
  // same thread, 'overdue' when due_at passes, or 'cancelled' when
  // the user dismisses it manually.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS delta_commitments (
      id                       BIGSERIAL PRIMARY KEY,
      user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_message_id        TEXT,
      source_thread_id         TEXT,
      recipient_email          TEXT,
      recipient_name           TEXT,
      commitment_text          TEXT NOT NULL,
      due_text                 TEXT,
      due_at                   TIMESTAMPTZ,
      status                   TEXT NOT NULL DEFAULT 'open',
      fulfilled_at             TIMESTAMPTZ,
      fulfilled_by_message_id  TEXT,
      dismissed_at             TIMESTAMPTZ,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_commitments_user_status
      ON delta_commitments(user_id, status, due_at NULLS LAST);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_commitments_thread
      ON delta_commitments(user_id, source_thread_id) WHERE source_thread_id IS NOT NULL;
  `);

  // Phase 5.BB — Notification dismissals.
  // Notifications are computed live by aggregating from existing sources
  // (overdue promises, due-soon tasks, important emails, finance alerts).
  // This table tracks what the user has cleared from the bell so the
  // same item doesn't keep popping back up.
  // dismiss_key format: "<kind>:<source_id>"   e.g. "promise-overdue:42"
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_dismissals (
      user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dismiss_key  TEXT   NOT NULL,
      dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, dismiss_key)
    );
  `);
  // Also track "last seen" so the unread badge clears when user opens the
  // notification dropdown. Single row per user.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_state (
      user_id      BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_seen_at TIMESTAMPTZ
    );
  `);

  // Phase 5.AJ — Proactive finance alerts. When a new email lands that
  // matches the finance-watchlist (Lana/Simon/Robert/Remco) or has a
  // financial subject/content, Email Delta pushes a notification to
  // Finance Delta via the bridge. This table prevents us from sending
  // the same notification twice (per user, per message_id).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finance_alerts_sent (
      id              BIGSERIAL PRIMARY KEY,
      user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id      TEXT NOT NULL,
      thread_id       TEXT,
      from_email      TEXT,
      subject         TEXT,
      reason          TEXT,
      sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivery_status TEXT,
      response_code   INT,
      response_body   TEXT,
      UNIQUE (user_id, message_id)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_finance_alerts_user_sent
      ON finance_alerts_sent(user_id, sent_at DESC);
  `);

  // delta_rules: the user-confirmed rules. The classifier consults this
  // table — any matching email gets the action applied at classify time
  // (label assignment + done-marking + snooze are all in our metadata
  // layer, no Gmail mutations required at this layer).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS delta_rules (
      id                  BIGSERIAL PRIMARY KEY,
      user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind                TEXT NOT NULL,
      match_value         TEXT NOT NULL,
      action              TEXT NOT NULL,
      source_candidate_id BIGINT REFERENCES delta_rule_candidates(id) ON DELETE SET NULL,
      hits_count          INT NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_hit_at         TIMESTAMPTZ,
      enabled             BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_delta_rules_user_kind_match
      ON delta_rules(user_id, kind, LOWER(match_value)) WHERE enabled = TRUE;
  `);

  // Phase 5.AG — Gmail Push (Cloud Pub/Sub) state.
  //
  // gmail_watch holds the per-user historyId + watch expiration so the
  // webhook handler knows where to resume history.list() on each
  // notification. Renewed every ~6 days by the renewer worker (Gmail
  // expires watches at 7d). One row per user.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gmail_watch (
      user_id        BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      history_id     BIGINT,
      expiration_at  TIMESTAMPTZ,
      topic_name     TEXT,
      label_filter   TEXT[],
      started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      renewed_at     TIMESTAMPTZ,
      last_event_at  TIMESTAMPTZ,
      event_count    BIGINT NOT NULL DEFAULT 0,
      last_error     TEXT
    );
  `);
}

const dbReady = (async () => {
  if (!connectionString) {
    console.warn("[db] DATABASE_URL not set — running without DB (Phase 0 shell only)");
    return;
  }
  await waitForDb();
  await initSchema();
  console.log("[db] schema ready");
})();

module.exports = { pool, dbReady };
