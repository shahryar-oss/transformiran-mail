// Transform Iran — Delta Mail
// Express server: Google OAuth login + Gmail inbox API.

require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");

const { dbReady, pool } = require("./lib/db");
const auth = require("./lib/auth");
const gmail = require("./lib/gmail");
const assistant = require("./lib/assistant");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(auth.attachUser);

// ====================================================================
// Health / build info
// ====================================================================
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
    user: req.user ? { id: req.user.id, email: req.user.email } : null,
  });
});

// ====================================================================
// Auth — Google OAuth
// ====================================================================
app.get("/auth/google", (req, res) => {
  try {
    const state = auth.newOAuthState(res);
    const url = gmail.buildAuthUrl(state);
    res.redirect(url);
  } catch (err) {
    console.error("[auth/google] start failed:", err);
    res.status(500).send("Auth start failed: " + err.message);
  }
});

app.get("/auth/google/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    console.warn("[auth/google/callback] google error:", error);
    return res.redirect("/?err=" + encodeURIComponent(error));
  }
  const expectedState = auth.consumeOAuthState(req, res);
  if (!state || !expectedState || state !== expectedState) {
    return res.redirect("/?err=bad_state");
  }
  if (!code) {
    return res.redirect("/?err=no_code");
  }
  try {
    const tokens = await gmail.exchangeCode(code);
    const oauthClient = gmail.makeOAuthClient();
    oauthClient.setCredentials(tokens);
    const userInfo = await gmail.fetchUserInfo(oauthClient);
    const { userId, email } = await auth.upsertUserAndTokens(userInfo, tokens);
    auth.setSession(res, userId);
    console.log(`[auth] login ok — ${email} (id=${userId})`);
    res.redirect("/");
  } catch (err) {
    if (err.code === "not_transformiran_workspace") {
      return res.redirect("/?err=wrong_workspace");
    }
    console.error("[auth/google/callback] failed:", err);
    res.redirect("/?err=" + encodeURIComponent(err.code || "auth_failed"));
  }
});

app.post("/auth/logout", (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

app.get("/auth/logout", (req, res) => {
  auth.clearSession(res);
  res.redirect("/");
});

// ====================================================================
// Pages
// ====================================================================
app.get("/", (req, res) => {
  if (!req.user) {
    return res.sendFile(path.join(__dirname, "public", "landing.html"));
  }
  // First-login welcome — shown until the user clicks "Get started"
  if (!req.user.welcomed_at) {
    return res.sendFile(path.join(__dirname, "public", "welcome.html"));
  }
  res.sendFile(path.join(__dirname, "public", "inbox.html"));
});

// Static (after the / route so we control the landing/inbox swap).
app.use(express.static(path.join(__dirname, "public")));

// ====================================================================
// Authed API — me, gmail
// ====================================================================
app.get("/api/me", auth.requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.display_name,
    pictureUrl: req.user.picture_url,
    welcomedAt: req.user.welcomed_at,
    humanEA: getHumanEAFor(req.user.email),
    role: getRoleFor(req.user.email),
  });
});

// Mark the user as welcomed — called by the welcome.html "Get started" button.
app.post("/api/me/welcome", auth.requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET welcomed_at = NOW() WHERE id = $1 AND welcomed_at IS NULL`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/me/welcome] failed:", err);
    res.status(500).json({ error: "welcome_failed" });
  }
});

function getHumanEAFor(email) {
  const e = (email || "").toLowerCase();
  if (e === "shahryar@transformiran.com") return "Pia Fanbele";
  if (e === "lana@transformiran.com")     return "Lauren";
  return null;
}
function getRoleFor(email) {
  const e = (email || "").toLowerCase();
  if (e === "shahryar@transformiran.com") return "Chief Operating Officer";
  if (e === "lana@transformiran.com")     return "President & CEO";
  if (e === "lazarus@transformiran.com")  return "General Overseer, 222 Churches";
  if (e === "maggie@transformiran.com")   return "Theology & Curriculum Director";
  return "staff";
}

app.get("/api/gmail/recent", auth.requireAuth, async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 25));
  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });

    const client = gmail.authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: client });

    const list = await g.users.messages.list({
      userId: "me",
      maxResults: limit,
      labelIds: ["INBOX"],
    });

    const ids = (list.data.messages || []).map((m) => m.id);
    if (ids.length === 0) return res.json({ messages: [] });

    // Fetch metadata for each (batched conceptually — we issue them in parallel).
    const fetches = ids.map((id) =>
      g.users.messages
        .get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        })
        .then((r) => r.data)
        .catch((err) => ({ id, _error: err.message }))
    );
    const detailed = await Promise.all(fetches);

    const messages = detailed.map((m) => {
      if (m._error) return { id: m.id, error: m._error };
      const headers = Object.fromEntries(
        (m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
      );
      return {
        id: m.id,
        threadId: m.threadId,
        snippet: m.snippet || "",
        from: headers.from || "",
        to: headers.to || "",
        subject: headers.subject || "(no subject)",
        date: headers.date || "",
        internalDate: m.internalDate,
        labelIds: m.labelIds || [],
        unread: (m.labelIds || []).includes("UNREAD"),
      };
    });

    res.json({ messages, count: messages.length });
  } catch (err) {
    console.error("[/api/gmail/recent] failed:", err);
    res.status(500).json({ error: "gmail_fetch_failed", message: err.message });
  }
});

// ====================================================================
// Delta chat — POST /api/assistant
// Stateless: client passes the conversation history each turn.
// ====================================================================
app.post("/api/assistant", auth.requireAuth, async (req, res) => {
  const { message, history, openMessageId } = req.body || {};
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "empty_message" });
  }
  if (message.length > 8000) {
    return res.status(400).json({ error: "message_too_long" });
  }
  if (history && (!Array.isArray(history) || history.length > 40)) {
    return res.status(400).json({ error: "bad_history" });
  }
  try {
    const result = await assistant.chat({
      user: req.user,
      history: history || [],
      userMessage: message.trim(),
      openMessageId: openMessageId || null,
    });
    res.json({
      reply: result.reply,
      usage: result.usage,
      model: result.model,
    });
  } catch (err) {
    console.error("[/api/assistant] failed:", err);
    res.status(500).json({
      error: "assistant_failed",
      message: err.message || "Delta couldn't reply right now.",
    });
  }
});

// ====================================================================
// 404 fallback
// ====================================================================
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

const BOOT_TIME_MS = Date.now();
const BOOT_TIME = new Date().toISOString();

app.listen(PORT, () => {
  console.log(
    `[transformiran-mail] listening on :${PORT} — booted ${BOOT_TIME}`
  );
});

dbReady
  .then(() => console.log("[boot] db ready"))
  .catch((err) => console.error("[boot] db init failed (non-fatal):", err));
