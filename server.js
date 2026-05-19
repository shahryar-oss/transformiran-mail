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
const classifier = require("./lib/classifier");
const memory = require("./lib/memory");
const mime = require("./lib/mime");
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

// Settings page — Memory, account info, etc.
app.get("/settings", (req, res) => {
  if (!req.user) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "settings.html"));
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
    preferredModel: req.user.preferred_model || "basic",
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
  if (e === "shahryar@transformiran.com") return "Pia van Belen";
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

// Gmail label / state mutations — power the Outlook-style top toolbar.
// Body: { add: ["STARRED"], remove: ["INBOX"] }
app.post("/api/gmail/message/:id/labels", auth.requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: "bad_id" });
  const add = Array.isArray(req.body?.add) ? req.body.add : [];
  const remove = Array.isArray(req.body?.remove) ? req.body.remove : [];
  if (!add.length && !remove.length) return res.status(400).json({ error: "no_changes" });
  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: client });
    const r = await g.users.messages.modify({
      userId: "me",
      id,
      requestBody: { addLabelIds: add, removeLabelIds: remove },
    });
    res.json({ ok: true, labelIds: r.data.labelIds || [] });
  } catch (err) {
    console.error("[/api/gmail/message/:id/labels] failed:", err);
    res.status(500).json({ error: "label_modify_failed", message: err.message });
  }
});

// Trash a message (Gmail moves it to Trash; user can restore from there).
app.post("/api/gmail/message/:id/trash", auth.requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: client });
    await g.users.messages.trash({ userId: "me", id });
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/gmail/message/:id/trash] failed:", err);
    res.status(500).json({ error: "trash_failed", message: err.message });
  }
});

// ====================================================================
// Saved prompts — reusable Delta prompts (↑ key in chat input)
// ====================================================================
app.get("/api/prompts", auth.requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, title, body, use_count, last_used_at, created_at
         FROM saved_prompts
        WHERE user_id = $1
        ORDER BY last_used_at DESC NULLS LAST, created_at DESC
        LIMIT 50`,
      [req.user.id]
    );
    res.json({ prompts: r.rows });
  } catch (err) {
    console.error("[/api/prompts] list failed:", err);
    res.status(500).json({ error: "list_failed", message: err.message });
  }
});

app.post("/api/prompts", auth.requireAuth, async (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: "title_and_body_required" });
  try {
    const r = await pool.query(
      `INSERT INTO saved_prompts (user_id, title, body)
       VALUES ($1, $2, $3)
       RETURNING id, title, body, use_count, last_used_at, created_at`,
      [req.user.id, String(title).slice(0, 120), String(body).slice(0, 4000)]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error("[/api/prompts] add failed:", err);
    res.status(500).json({ error: "add_failed", message: err.message });
  }
});

app.delete("/api/prompts/:id", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    await pool.query(`DELETE FROM saved_prompts WHERE user_id = $1 AND id = $2`, [req.user.id, id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "delete_failed", message: err.message });
  }
});

// Bump use counter when a prompt is fired.
app.post("/api/prompts/:id/used", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    await pool.query(
      `UPDATE saved_prompts SET use_count = use_count + 1, last_used_at = NOW()
         WHERE user_id = $1 AND id = $2`,
      [req.user.id, id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "update_failed", message: err.message });
  }
});

// Update user preferences (currently: preferred_model).
app.patch("/api/me", auth.requireAuth, async (req, res) => {
  const { preferred_model } = req.body || {};
  if (preferred_model && !["basic", "advanced"].includes(preferred_model)) {
    return res.status(400).json({ error: "bad_model" });
  }
  try {
    await pool.query(
      `UPDATE users SET preferred_model = $1 WHERE id = $2`,
      [preferred_model || null, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "update_failed", message: err.message });
  }
});

// ====================================================================
// Delta Memory — persistent facts Delta has been told to remember
// ====================================================================
app.get("/api/memory", auth.requireAuth, async (req, res) => {
  try {
    const rows = await memory.listAll(req.user.id);
    res.json({ memories: rows });
  } catch (err) {
    console.error("[/api/memory] list failed:", err);
    res.status(500).json({ error: "list_failed", message: err.message });
  }
});

app.post("/api/memory", auth.requireAuth, async (req, res) => {
  const { subject, subject_email, category, fact } = req.body || {};
  if (!subject || !fact) return res.status(400).json({ error: "subject_and_fact_required" });
  try {
    const row = await memory.add(req.user.id, {
      subject,
      subject_email,
      category,
      fact,
      source: "manual",
    });
    res.json(row);
  } catch (err) {
    console.error("[/api/memory] add failed:", err);
    res.status(500).json({ error: "add_failed", message: err.message });
  }
});

app.patch("/api/memory/:id", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const row = await memory.update(req.user.id, id, req.body || {});
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  } catch (err) {
    console.error("[/api/memory/:id] patch failed:", err);
    res.status(500).json({ error: "update_failed", message: err.message });
  }
});

app.delete("/api/memory/:id", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const ok = await memory.remove(req.user.id, id);
    res.json({ ok });
  } catch (err) {
    console.error("[/api/memory/:id] delete failed:", err);
    res.status(500).json({ error: "delete_failed", message: err.message });
  }
});

// Classify a batch of inbox messages. Returns existing-cached + newly-classified.
// Body: { messages: [{ id, from, subject, snippet }, ...] }
app.post("/api/classify", auth.requireAuth, async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages_required" });
  }
  if (messages.length > 100) {
    return res.status(400).json({ error: "too_many", max: 100 });
  }
  try {
    const result = await classifier.classifyForUser(req.user.id, messages);
    res.json({ classifications: result, count: Object.keys(result).length });
  } catch (err) {
    console.error("[/api/classify] failed:", err);
    res.status(500).json({ error: "classify_failed", message: err.message });
  }
});

// Fetch a single message in full, including parsed body.
app.get("/api/gmail/message/:id", auth.requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: "bad_id" });
  }
  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: client });
    const r = await g.users.messages.get({ userId: "me", id, format: "full" });
    const m = r.data;
    const headers = mime.headersToMap(m.payload?.headers || []);
    const body = mime.pickBody(m.payload);
    const safeHtml = mime.sanitizeHtml(body.html);
    res.json({
      id: m.id,
      threadId: m.threadId,
      labelIds: m.labelIds || [],
      snippet: m.snippet || "",
      internalDate: m.internalDate,
      headers: {
        from: headers.from || "",
        to: headers.to || "",
        cc: headers.cc || "",
        bcc: headers.bcc || "",
        subject: headers.subject || "(no subject)",
        date: headers.date || "",
        messageId: headers["message-id"] || "",
        replyTo: headers["reply-to"] || "",
      },
      body: {
        html: safeHtml,
        text: body.text || mime.htmlToText(body.html || ""),
      },
      attachments: body.attachments || [],
      unread: (m.labelIds || []).includes("UNREAD"),
    });
  } catch (err) {
    console.error("[/api/gmail/message/:id] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

// Delta draft a reply — generate a reply body for the open email.
app.post("/api/assistant/draft", auth.requireAuth, async (req, res) => {
  const { openMessageId, instructions } = req.body || {};
  if (!openMessageId) {
    return res.status(400).json({ error: "openMessageId_required" });
  }
  try {
    const result = await assistant.draftReply({
      user: req.user,
      openMessageId,
      instructions: instructions || "",
    });
    res.json({
      to: result.to,
      subject: result.subject,
      body: result.body,
      threadId: result.threadId,
      inReplyTo: result.inReplyTo,
    });
  } catch (err) {
    console.error("[/api/assistant/draft] failed:", err);
    res.status(500).json({ error: "draft_failed", message: err.message });
  }
});

// Create a real Gmail draft in the user's Drafts folder.
// User reviews + sends from Gmail itself; we never send on their behalf.
app.post("/api/gmail/draft", auth.requireAuth, async (req, res) => {
  const { to, subject, body, threadId, inReplyTo } = req.body || {};
  if (!to || !body) return res.status(400).json({ error: "to_and_body_required" });
  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: client });

    // Build an RFC-2822 message. Gmail accepts base64url-encoded raw.
    const lines = [
      `To: ${to}`,
      `Subject: ${subject || "(no subject)"}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: 7bit`,
    ];
    if (inReplyTo) {
      lines.push(`In-Reply-To: ${inReplyTo}`);
      lines.push(`References: ${inReplyTo}`);
    }
    lines.push("");
    lines.push(body);
    const raw = Buffer.from(lines.join("\r\n"), "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const draftRes = await g.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw,
          ...(threadId ? { threadId } : {}),
        },
      },
    });

    res.json({
      ok: true,
      draftId: draftRes.data.id,
      messageId: draftRes.data.message?.id,
      gmailUrl: `https://mail.google.com/mail/u/0/#drafts`,
    });
  } catch (err) {
    console.error("[/api/gmail/draft] failed:", err);
    res.status(500).json({ error: "draft_save_failed", message: err.message });
  }
});

// ====================================================================
// Delta chat — POST /api/assistant
// Stateless: client passes the conversation history each turn.
// ====================================================================
app.post("/api/assistant", auth.requireAuth, async (req, res) => {
  const { message, history, openMessageId, model } = req.body || {};
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
      model: model === "advanced" || model === "basic" ? model : undefined,
    });
    res.json({
      reply: result.reply,
      usage: result.usage,
      model: result.model,
      toolEvents: result.toolEvents || [],
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
