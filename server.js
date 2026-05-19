// Transform Iran — Delta Mail
// Express server + Postgres + Anthropic + Gmail OAuth
// Phase 0: empty shell. Feature wiring comes in subsequent phases.

require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");

const { dbReady, pool } = require("./lib/db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// Health / build info
app.get("/healthz", async (req, res) => {
  let dbOk = false;
  try {
    const r = await pool.query("SELECT 1 AS ok");
    dbOk = r.rows[0].ok === 1;
  } catch (_) {}
  res.json({
    service: "transformiran-mail",
    version: require("./package.json").version,
    db: dbOk,
    bootedAt: BOOT_TIME,
    uptimeSec: Math.round((Date.now() - BOOT_TIME_MS) / 1000),
  });
});

// Phase 0 landing — Outlook-style shell.
// Auth gating wired in Phase 1.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "inbox.html"));
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

const BOOT_TIME_MS = Date.now();
const BOOT_TIME = new Date().toISOString();

(async () => {
  try {
    await dbReady;
    app.listen(PORT, () => {
      console.log(
        `[transformiran-mail] listening on :${PORT} — booted ${BOOT_TIME}`
      );
    });
  } catch (err) {
    console.error("[boot] fatal:", err);
    process.exit(1);
  }
})();
