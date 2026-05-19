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
