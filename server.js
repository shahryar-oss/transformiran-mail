// Transform Iran — Delta Mail
// Express server: Google OAuth login + Gmail inbox API.

require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");

const { dbReady, pool } = require("./lib/db");
const auth = require("./lib/auth");
const gmail = require("./lib/gmail");
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
  if (req.user) {
    return res.sendFile(path.join(__dirname, "public", "inbox.html"));
  }
  res.sendFile(path.join(__dirname, "public", "landing.html"));
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
  });
});

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
