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
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS magic_link_tokens (
      token        TEXT PRIMARY KEY,
      email        TEXT NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      used_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_magic_link_email
      ON magic_link_tokens(email);
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
