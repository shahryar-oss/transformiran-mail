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
const backfill = require("./lib/backfill");
const tasks = require("./lib/tasks");
const importantContacts = require("./lib/important_contacts");
const memoryExtractor = require("./lib/memory_extractor");
const inboxCache = require("./lib/inbox_cache");
const calendarLib = require("./lib/calendar");
const contactsLib = require("./lib/contacts");
const snooze = require("./lib/snooze");
const briefing = require("./lib/briefing");
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

// Tasks page — Microsoft To Do-style task manager
app.get("/tasks", (req, res) => {
  if (!req.user) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "tasks.html"));
});

// Calendar page — Google Calendar integration (Outlook-style month grid)
app.get("/calendar", (req, res) => {
  if (!req.user) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "calendar.html"));
});

// Contacts page — per-user people directory (auto-extracted from inbox)
app.get("/contacts", (req, res) => {
  if (!req.user) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "contacts.html"));
});

// ====================================================================
// Tasks API
// ====================================================================
app.get("/api/tasks/lists", auth.requireAuth, async (req, res) => {
  try {
    const lists = await tasks.listLists(req.user.id);
    const counts = await tasks.smartListCounts(req.user.id);
    res.json({ lists, counts });
  } catch (err) {
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.post("/api/tasks/lists", auth.requireAuth, async (req, res) => {
  try {
    const list = await tasks.createList(req.user.id, req.body || {});
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "create_failed", message: err.message });
  }
});

app.patch("/api/tasks/lists/:id", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const list = await tasks.updateList(req.user.id, id, req.body || {});
    if (!list) return res.status(404).json({ error: "not_found" });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "update_failed", message: err.message });
  }
});

app.delete("/api/tasks/lists/:id", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    await tasks.deleteList(req.user.id, id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "delete_failed", message: err.message });
  }
});

// Tasks within a view (smart list or custom list)
// GET /api/tasks?view=my-day|important|planned|completed|all|tasks  OR view=<list_id_number>
app.get("/api/tasks", auth.requireAuth, async (req, res) => {
  let view = req.query.view || "tasks";
  if (/^\d+$/.test(view)) view = Number(view);
  const includeCompleted = req.query.includeCompleted === "true";
  try {
    const rows = await tasks.listTasksForView(req.user.id, view, { includeCompleted });
    res.json({ tasks: rows, view });
  } catch (err) {
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.post("/api/tasks", auth.requireAuth, async (req, res) => {
  try {
    const task = await tasks.createTask(req.user.id, req.body || {});
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: "create_failed", message: err.message });
  }
});

app.patch("/api/tasks/:id", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const task = await tasks.updateTask(req.user.id, id, req.body || {});
    if (!task) return res.status(404).json({ error: "not_found" });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: "update_failed", message: err.message });
  }
});

app.delete("/api/tasks/:id", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    await tasks.deleteTask(req.user.id, id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "delete_failed", message: err.message });
  }
});

// Count of incomplete tasks past their due date — powers the rail badge
// on /inbox, /tasks, /calendar, /contacts, etc.
app.get("/api/tasks/overdue-count", auth.requireAuth, async (req, res) => {
  try {
    const n = await tasks.overdueCount(req.user.id);
    res.json({ count: n });
  } catch (err) {
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

// Tasks whose due_at or reminder_at hits within the next ~minute or has
// just passed — for the client-side notification poller.
app.get("/api/tasks/due-soon", auth.requireAuth, async (req, res) => {
  try {
    const rows = await tasks.dueSoon(req.user.id);
    res.json({ tasks: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

// Steps (sub-tasks) for a task
app.get("/api/tasks/:id/steps", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const steps = await tasks.listSteps(req.user.id, id);
    res.json({ steps });
  } catch (err) {
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.post("/api/tasks/:id/steps", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  const { title } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: "title_required" });
  try {
    const step = await tasks.createStep(req.user.id, id, title);
    res.json(step);
  } catch (err) {
    res.status(500).json({ error: "create_failed", message: err.message });
  }
});

app.patch("/api/tasks/:taskId/steps/:stepId", auth.requireAuth, async (req, res) => {
  const taskId = Number(req.params.taskId);
  const stepId = Number(req.params.stepId);
  if (!Number.isFinite(taskId) || !Number.isFinite(stepId)) return res.status(400).json({ error: "bad_id" });
  try {
    const step = await tasks.updateStep(req.user.id, taskId, stepId, req.body || {});
    res.json(step || { ok: false });
  } catch (err) {
    res.status(500).json({ error: "update_failed", message: err.message });
  }
});

app.delete("/api/tasks/:taskId/steps/:stepId", auth.requireAuth, async (req, res) => {
  const taskId = Number(req.params.taskId);
  const stepId = Number(req.params.stepId);
  if (!Number.isFinite(taskId) || !Number.isFinite(stepId)) return res.status(400).json({ error: "bad_id" });
  try {
    await tasks.deleteStep(req.user.id, taskId, stepId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "delete_failed", message: err.message });
  }
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

// ====================================================================
// Calendar API — Google Calendar via the calendar.events OAuth scope.
// ====================================================================
app.get("/api/calendar/calendars", auth.requireAuth, async (req, res) => {
  try {
    const calendars = await calendarLib.listCalendars(req.user.id);
    res.json({ calendars });
  } catch (err) {
    console.error("[/api/calendar/calendars] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.get("/api/calendar/events", auth.requireAuth, async (req, res) => {
  const { start, end, calendarIds } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start_and_end_required" });
  try {
    const ids = calendarIds ? String(calendarIds).split(",").map((s) => s.trim()).filter(Boolean) : null;
    const events = await calendarLib.listEvents(req.user.id, { start, end, calendarIds: ids });
    res.json({ events, count: events.length });
  } catch (err) {
    console.error("[/api/calendar/events] list failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.post("/api/calendar/events", auth.requireAuth, async (req, res) => {
  try {
    const event = await calendarLib.createEvent(req.user.id, req.body || {});
    res.json(event);
  } catch (err) {
    console.error("[/api/calendar/events] create failed:", err);
    res.status(500).json({ error: "create_failed", message: err.message });
  }
});

app.patch("/api/calendar/events/:id", auth.requireAuth, async (req, res) => {
  const eventId = req.params.id;
  const { calendarId, ...patch } = req.body || {};
  try {
    const event = await calendarLib.updateEvent(req.user.id, { calendarId, eventId, patch });
    res.json(event);
  } catch (err) {
    console.error("[/api/calendar/events/:id] update failed:", err);
    res.status(500).json({ error: "update_failed", message: err.message });
  }
});

app.delete("/api/calendar/events/:id", auth.requireAuth, async (req, res) => {
  const eventId = req.params.id;
  const calendarId = req.query.calendarId || "primary";
  try {
    await calendarLib.deleteEvent(req.user.id, { calendarId, eventId });
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/calendar/events/:id] delete failed:", err);
    res.status(500).json({ error: "delete_failed", message: err.message });
  }
});

// ====================================================================
// Morning briefing — Phase 5.AD. Lazy-generated daily brief delivered as
// a chat card when the user opens Delta on a new day.
// ====================================================================
app.get("/api/briefing/today", auth.requireAuth, async (req, res) => {
  try {
    const row = await briefing.getTodayForUser(req.user, { allowGenerate: true });
    if (!row) return res.json({ ok: false, brief: null });
    res.json({
      ok: true,
      id: Number(row.id),
      date: row.briefing_date,
      generated_at: row.generated_at,
      shown_at: row.shown_at,
      dismissed_at: row.dismissed_at,
      brief: typeof row.brief_json === "string" ? JSON.parse(row.brief_json) : row.brief_json,
    });
  } catch (err) {
    console.error("[/api/briefing/today] failed:", err);
    res.status(500).json({ error: "generate_failed", message: err.message });
  }
});

app.post("/api/briefing/shown", auth.requireAuth, async (req, res) => {
  try {
    await briefing.markShown(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "mark_shown_failed", message: err.message });
  }
});

app.post("/api/briefing/dismiss", auth.requireAuth, async (req, res) => {
  try {
    await briefing.markDismissed(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "dismiss_failed", message: err.message });
  }
});

// Save one of the briefing's pre-drafted replies straight to Gmail Drafts.
// The body is the draft text from the brief; we look up the message_id to
// thread it correctly + grab the From header for the To field.
app.post("/api/briefing/save-draft", auth.requireAuth, async (req, res) => {
  const { messageId, draft, subject } = req.body || {};
  if (!messageId || !draft) return res.status(400).json({ error: "messageId_and_draft_required" });
  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: client });

    // Look up the source message to get From / Subject / Message-ID headers.
    const src = await g.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Message-ID"],
    });
    const headers = mime.headersToMap(src.data.payload?.headers || []);
    const to = headers.from || "";
    const replySubject = subject || (
      /^re:/i.test(headers.subject || "") ? headers.subject : `Re: ${headers.subject || ""}`
    );
    const threadId = src.data.threadId;
    const inReplyTo = headers["message-id"];

    // Honor user's signature mode (same as /api/gmail/draft).
    const sig = await gmail.getCachedSignature(req.user.id, client);
    const mode = req.user.signature_mode || "always";
    const useSig =
      mode === "never" ? false :
      mode === "first" ? !inReplyTo : true;
    const sigHtml = useSig && sig?.html ? sig.html : "";
    const sigText = useSig && sig ? gmail.signatureToPlainText(sig.html) : "";

    const raw = require("./lib/mime").buildReplyMessage
      ? mime.buildReplyMessage({ to, subject: replySubject, bodyText: draft, signatureText: sigText, signatureHtml: sigHtml, inReplyTo })
      : null;
    // Fallback if buildReplyMessage isn't exported — use buildMultipartMessage
    const finalRaw = raw || (typeof buildMultipartMessage === "function"
      ? buildMultipartMessage({ to, subject: replySubject, bodyText: draft, signatureText: sigText, signatureHtml: sigHtml, inReplyTo })
      : null);

    if (!finalRaw) {
      // Build a minimal RFC822 raw message ourselves
      const headerLines = [
        `To: ${to}`,
        `Subject: ${replySubject}`,
        inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
        inReplyTo ? `References: ${inReplyTo}` : null,
        "Content-Type: text/plain; charset=utf-8",
        "MIME-Version: 1.0",
        "",
      ].filter(Boolean).join("\r\n");
      const bodyWithSig = sigText ? `${draft}\n\n${sigText}` : draft;
      const rfc = `${headerLines}\r\n${bodyWithSig}`;
      const b64 = Buffer.from(rfc, "utf-8").toString("base64")
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const draftRes = await g.users.drafts.create({
        userId: "me",
        requestBody: {
          message: { raw: b64, ...(threadId ? { threadId } : {}) },
        },
      });
      return res.json({
        ok: true,
        draftId: draftRes.data.id,
        gmailUrl: `https://mail.google.com/mail/u/0/#drafts`,
      });
    }

    const draftRes = await g.users.drafts.create({
      userId: "me",
      requestBody: {
        message: { raw: finalRaw, ...(threadId ? { threadId } : {}) },
      },
    });
    res.json({
      ok: true,
      draftId: draftRes.data.id,
      gmailUrl: `https://mail.google.com/mail/u/0/#drafts`,
    });
  } catch (err) {
    console.error("[/api/briefing/save-draft] failed:", err);
    res.status(500).json({ error: "save_draft_failed", message: err.message });
  }
});

// ====================================================================
// Gmail Push (Cloud Pub/Sub) — Phase 5.AG. Real-time inbox.
// POST /api/gmail/push/webhook       → Pub/Sub destination (no auth header;
//                                       shared-secret in ?token=)
// POST /api/gmail/push/enable        → start watch for this user
// POST /api/gmail/push/disable       → stop watch
// GET  /api/gmail/push/status        → watch state for this user
// ====================================================================

// Pub/Sub webhook. Mounted as plain POST — auth is the shared-secret
// `token` query param matched against GMAIL_PUSH_TOKEN. Pub/Sub will
// retry on 5xx, so we always 200 unless the token's wrong.
app.post("/api/gmail/push/webhook", async (req, res) => {
  try {
    const gmailPush = require("./lib/gmailPush");
    if (!gmailPush.isEnabled()) {
      // Acknowledge to stop Pub/Sub retries when push isn't configured.
      return res.status(204).end();
    }
    if (req.query.token !== gmailPush.PUSH_TOKEN) {
      console.warn("[push/webhook] bad token from", req.ip);
      return res.status(401).json({ error: "bad_token" });
    }
    // Process asynchronously — Pub/Sub timeout is generous but we want
    // to ack quickly so it doesn't retry on slow processing.
    gmailPush.handleNotification(req.body).then((result) => {
      if (!result?.ok) {
        console.warn("[push/webhook] handler returned non-ok:", result?.error);
      } else if (result.newMessageIds > 0) {
        console.log(`[push/webhook] user ${result.user_id}: ${result.newMessageIds} new, ${result.ruleHandled} auto-handled`);
      }
    }).catch((err) => {
      console.error("[push/webhook] handler failed:", err);
    });
    res.status(204).end();
  } catch (err) {
    console.error("[push/webhook] failed:", err);
    res.status(500).json({ error: "webhook_failed" });
  }
});

app.post("/api/gmail/push/enable", auth.requireAuth, async (req, res) => {
  try {
    const gmailPush = require("./lib/gmailPush");
    if (!gmailPush.isEnabled()) {
      return res.status(400).json({ ok: false, error: "push_not_configured" });
    }
    const result = await gmailPush.startWatchForUser(req.user.id);
    res.json(result);
  } catch (err) {
    console.error("[/api/gmail/push/enable] failed:", err);
    res.status(500).json({ error: "enable_failed", message: err.message });
  }
});

app.post("/api/gmail/push/disable", auth.requireAuth, async (req, res) => {
  try {
    const gmailPush = require("./lib/gmailPush");
    const result = await gmailPush.stopWatchForUser(req.user.id);
    res.json(result);
  } catch (err) {
    console.error("[/api/gmail/push/disable] failed:", err);
    res.status(500).json({ error: "disable_failed", message: err.message });
  }
});

app.get("/api/gmail/push/status", auth.requireAuth, async (req, res) => {
  try {
    const gmailPush = require("./lib/gmailPush");
    const status = await gmailPush.getWatchStatus(req.user.id);
    res.json({
      ok: true,
      enabled: gmailPush.isEnabled(),
      configured: gmailPush.isEnabled(),
      topic: gmailPush.TOPIC || null,
      watch: status,
    });
  } catch (err) {
    console.error("[/api/gmail/push/status] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

// ====================================================================
// Decision Rules API — Phase 5.AF. Pattern mining + confirm-first rules.
// GET    /api/decision-rules/candidates                 → pending suggestions
// POST   /api/decision-rules/candidates/:id/confirm     → promote to rule
// POST   /api/decision-rules/candidates/:id/reject      → mark rejected
// GET    /api/decision-rules/rules                      → active rules
// PATCH  /api/decision-rules/rules/:id                  → enable/disable
// DELETE /api/decision-rules/rules/:id                  → remove rule
// POST   /api/decision-rules/mine                       → force mine now (admin)
// ====================================================================
app.get("/api/decision-rules/candidates", auth.requireAuth, async (req, res) => {
  try {
    const decisionRules = require("./lib/decisionRules");
    const candidates = await decisionRules.listPendingCandidates(req.user.id);
    res.json({
      ok: true,
      candidates: candidates.map((c) => ({
        ...c,
        prompt: decisionRules.describeCandidate(c),
      })),
    });
  } catch (err) {
    console.error("[/api/decision-rules/candidates] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.post("/api/decision-rules/candidates/:id/confirm", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const decisionRules = require("./lib/decisionRules");
    const result = await decisionRules.confirmCandidate(req.user.id, id);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    console.error("[/api/decision-rules/candidates/:id/confirm] failed:", err);
    res.status(500).json({ error: "confirm_failed", message: err.message });
  }
});

app.post("/api/decision-rules/candidates/:id/reject", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const decisionRules = require("./lib/decisionRules");
    const result = await decisionRules.rejectCandidate(req.user.id, id);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    console.error("[/api/decision-rules/candidates/:id/reject] failed:", err);
    res.status(500).json({ error: "reject_failed", message: err.message });
  }
});

app.get("/api/decision-rules/rules", auth.requireAuth, async (req, res) => {
  try {
    const decisionRules = require("./lib/decisionRules");
    const rules = await decisionRules.listActiveRules(req.user.id);
    res.json({ ok: true, rules });
  } catch (err) {
    console.error("[/api/decision-rules/rules] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.patch("/api/decision-rules/rules/:id", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  const { enabled } = req.body || {};
  try {
    const decisionRules = require("./lib/decisionRules");
    const result = enabled
      ? await decisionRules.enableRule(req.user.id, id)
      : await decisionRules.disableRule(req.user.id, id);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    console.error("[/api/decision-rules/rules/:id] PATCH failed:", err);
    res.status(500).json({ error: "update_failed", message: err.message });
  }
});

app.delete("/api/decision-rules/rules/:id", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const decisionRules = require("./lib/decisionRules");
    const result = await decisionRules.deleteRule(req.user.id, id);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    console.error("[/api/decision-rules/rules/:id] DELETE failed:", err);
    res.status(500).json({ error: "delete_failed", message: err.message });
  }
});

app.post("/api/decision-rules/mine", auth.requireAuth, async (req, res) => {
  try {
    const decisionRules = require("./lib/decisionRules");
    const result = await decisionRules.mineCandidates(req.user.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[/api/decision-rules/mine] failed:", err);
    res.status(500).json({ error: "mine_failed", message: err.message });
  }
});

// ====================================================================
// Voice Profile API — Phase 5.AE. Edit-diff learning surface.
// GET  /api/voice/profile         → stats + distilled cheatsheet
// POST /api/voice/distill         → force a re-distill now (manual refresh)
// ====================================================================
app.get("/api/voice/profile", auth.requireAuth, async (req, res) => {
  try {
    const voice = require("./lib/voice");
    const stats = await voice.getStats(req.user.id);
    res.json({ ok: true, ...stats });
  } catch (err) {
    console.error("[/api/voice/profile] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.post("/api/voice/distill", auth.requireAuth, async (req, res) => {
  try {
    const voice = require("./lib/voice");
    // Triggered by a "refresh now" button. Will succeed if at least
    // REDISTILL_AFTER_NEW_EDITS edits have accumulated since the last
    // distill (or there's no profile yet and enough edits exist).
    const result = await voice.distillProfile(req.user);
    res.json({ ok: true, result });
  } catch (err) {
    console.error("[/api/voice/distill] failed:", err);
    res.status(500).json({ error: "distill_failed", message: err.message });
  }
});

// ====================================================================
// Contacts API — per-user people directory
// ====================================================================
app.get("/api/contacts", auth.requireAuth, async (req, res) => {
  const search = req.query.search ? String(req.query.search).trim() : "";
  const sort = req.query.sort || "name";
  try {
    const contacts = await contactsLib.list(req.user.id, { search, sort });
    res.json({ contacts, count: contacts.length });
  } catch (err) {
    console.error("[/api/contacts] list failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.get("/api/contacts/:id", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const contact = await contactsLib.get(req.user.id, id);
    if (!contact) return res.status(404).json({ error: "not_found" });
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.get("/api/contacts/:id/messages", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const contact = await contactsLib.get(req.user.id, id);
    if (!contact) return res.status(404).json({ error: "not_found" });
    const messages = await contactsLib.recentEmails(req.user.id, contact.email, { limit: 12 });
    res.json({ messages, count: messages.length });
  } catch (err) {
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.post("/api/contacts", auth.requireAuth, async (req, res) => {
  try {
    const contact = await contactsLib.create(req.user.id, req.body || {});
    res.json(contact);
  } catch (err) {
    const code = err.message === "invalid_email" ? 400 : 500;
    res.status(code).json({ error: err.message, message: err.message });
  }
});

app.patch("/api/contacts/:id", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const contact = await contactsLib.update(req.user.id, id, req.body || {});
    if (!contact) return res.status(404).json({ error: "not_found" });
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: "update_failed", message: err.message });
  }
});

app.delete("/api/contacts/:id", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    await contactsLib.remove(req.user.id, id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "delete_failed", message: err.message });
  }
});

// Refresh / populate contacts from the user's inbox_cache. Fire-and-forget
// from the frontend on /contacts load.
app.post("/api/contacts/extract-from-inbox", auth.requireAuth, async (req, res) => {
  try {
    const result = await contactsLib.extractFromInbox(req.user.id);
    res.json(result);
  } catch (err) {
    console.error("[/api/contacts/extract-from-inbox] failed:", err);
    res.status(500).json({ error: "extract_failed", message: err.message });
  }
});

// ====================================================================
// Important contacts API — per-user 'Important' folders + VIP weighting
// ====================================================================
app.get("/api/important-contacts", auth.requireAuth, async (req, res) => {
  try {
    const contacts = await importantContacts.list(req.user.id);
    res.json({ contacts });
  } catch (err) {
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.post("/api/important-contacts", auth.requireAuth, async (req, res) => {
  try {
    const row = await importantContacts.add(req.user.id, req.body || {});
    res.json(row);
  } catch (err) {
    const msg = err.message === "invalid_email" ? "invalid_email" : "add_failed";
    res.status(400).json({ error: msg, message: err.message });
  }
});

app.delete("/api/important-contacts/:id", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    await importantContacts.remove(req.user.id, id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "delete_failed", message: err.message });
  }
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

// ====================================================================
// Historical backfill — indexes the user's entire Gmail history
// ====================================================================
app.post("/api/backfill/start", auth.requireAuth, async (req, res) => {
  try {
    const job = await backfill.startJob(req.user.id);
    res.json({ ok: true, job });
  } catch (err) {
    console.error("[/api/backfill/start] failed:", err);
    res.status(500).json({ error: "start_failed", message: err.message });
  }
});

app.get("/api/backfill/status", auth.requireAuth, async (req, res) => {
  try {
    const job = await backfill.getJob(req.user.id);
    if (!job) return res.json({ status: "none" });
    const pct = job.total_estimated && job.total_estimated > 0
      ? Math.min(100, Math.round((job.total_indexed / job.total_estimated) * 100))
      : null;
    res.json({
      status: job.status,
      phase: job.phase,
      total_estimated: job.total_estimated,
      total_indexed: job.total_indexed,
      percent: pct,
      started_at: job.started_at,
      completed_at: job.completed_at,
      last_progress_at: job.last_progress_at,
      error: job.error,
    });
  } catch (err) {
    res.status(500).json({ error: "status_failed", message: err.message });
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

// Unified messages list — handles all folders + search via one endpoint.
//   ?folder=inbox|sent|drafts|archive|starred|trash
//   ?q=<gmail search query>  (overrides folder)
//   ?limit=30
//   ?pageToken=<next-page-token from previous response>
app.get("/api/messages", auth.requireAuth, async (req, res) => {
  const folder = String(req.query.folder || "inbox").toLowerCase();
  const q = String(req.query.q || "").trim();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
  const pageToken = req.query.pageToken || null;

  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: client });

    // Drafts uses a different API and returns wrapped data.
    if (folder === "drafts" && !q) {
      const list = await g.users.drafts.list({
        userId: "me",
        maxResults: limit,
        pageToken: pageToken || undefined,
      });
      const draftStubs = list.data.drafts || [];
      const fetches = draftStubs.map((d) =>
        g.users.drafts
          .get({ userId: "me", id: d.id, format: "metadata" })
          .then((r) => ({ draftId: d.id, message: r.data.message }))
          .catch(() => null)
      );
      const items = (await Promise.all(fetches)).filter(Boolean);
      const messages = items.map(({ draftId, message }) => {
        const headers = Object.fromEntries(
          (message.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
        );
        return {
          id: message.id,
          threadId: message.threadId,
          draftId,
          snippet: message.snippet || "",
          from: headers.from || "",
          to: headers.to || "",
          subject: headers.subject || "(no subject)",
          date: headers.date || "",
          internalDate: message.internalDate,
          labelIds: message.labelIds || [],
          unread: false,
        };
      });
      return res.json({
        messages,
        count: messages.length,
        nextPageToken: list.data.nextPageToken || null,
        folder,
      });
    }

    // FAST PATH — inbox folder, no query, no pagination → serve from cache.
    // Drops a typical page load from ~1.5-2s (Gmail list + 30 metadata calls)
    // to ~50ms (a single Postgres SELECT). The background worker keeps the
    // cache fresh, and user actions invalidate affected rows. forceFresh=1
    // (from the manual Refresh button) skips the cache and re-syncs first.
    const forceFresh = req.query.forceFresh === "1" || req.query.forceFresh === "true";
    if (folder === "inbox" && !q && !pageToken) {
      try {
        if (forceFresh) {
          // Synchronous sync — block on Gmail to guarantee the user sees
          // fresh state right now. This is what they're asking for when
          // they click refresh.
          await inboxCache.syncForUser(req.user.id);
        }
        const cachedCount = await inboxCache.getCountForUser(req.user.id);
        if (cachedCount > 0) {
          const cached = await inboxCache.getRecent(req.user.id, { limit });
          const state = await inboxCache.getState(req.user.id);
          // Fire-and-forget background sync if cache is older than 60s and
          // we didn't already do a synchronous one above.
          if (!forceFresh && (!state?.last_sync_at || (Date.now() - new Date(state.last_sync_at).getTime()) > 60_000)) {
            setImmediate(() => {
              inboxCache.syncForUser(req.user.id).catch((err) => {
                console.warn("[/api/messages] background sync failed:", err.message);
              });
            });
          }

          // Grab a Gmail nextPageToken so the client can continue paginating
          // past the cached page. This is a metadata-light call (no body
          // fetches) so it's fast — typically 100-200ms. Worth it to make
          // infinite scroll actually work for older mail.
          let cachedNextPageToken = null;
          try {
            const creds = await auth.loadGoogleCreds(req.user.id);
            if (creds) {
              const client = gmail.authedClientFromTokens(creds);
              const g = google.gmail({ version: "v1", auth: client });
              const listRes = await g.users.messages.list({
                userId: "me",
                maxResults: limit,
                labelIds: ["INBOX"],
              });
              cachedNextPageToken = listRes.data.nextPageToken || null;
            }
          } catch (err) {
            // Non-fatal — just means infinite scroll won't work for this
            // request. Frontend gracefully shows end-of-list.
            console.warn("[/api/messages] cache-path token fetch failed:", err.message);
          }

          return res.json({
            messages: cached,
            count: cached.length,
            nextPageToken: cachedNextPageToken,
            folder,
            cached: true,
            cachedAt: state?.last_sync_at || null,
          });
        }
        // Cache miss (first ever read for this user) — fall through to live
        // Gmail fetch, but also kick off a sync so subsequent reads hit cache.
        setImmediate(() => {
          inboxCache.syncForUser(req.user.id).catch((err) => {
            console.warn("[/api/messages] cold-cache sync failed:", err.message);
          });
        });
      } catch (err) {
        console.warn("[/api/messages] cache lookup failed, falling through to Gmail:", err.message);
      }
    }

    // Everything else uses messages.list with the appropriate query.
    let query = q;
    if (!q) {
      switch (folder) {
        case "sent":     query = "in:sent"; break;
        case "starred":  query = "in:starred"; break;
        case "trash":    query = "in:trash"; break;
        case "archive":  query = "-in:inbox -in:sent -in:drafts -in:trash -in:spam"; break;
        case "inbox":
        default:         query = "in:inbox"; break;
      }
    }

    const list = await g.users.messages.list({
      userId: "me",
      maxResults: limit,
      pageToken: pageToken || undefined,
      q: query,
    });
    const ids = (list.data.messages || []).map((m) => m.id);
    if (ids.length === 0) {
      return res.json({ messages: [], count: 0, nextPageToken: null, folder, query });
    }

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

    res.json({
      messages,
      count: messages.length,
      nextPageToken: list.data.nextPageToken || null,
      folder,
      query,
    });
  } catch (err) {
    console.error("[/api/messages] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

// Bulk action across many threads — used by the cleanup wizard.
// Body: { threadIds: ["..."], action: "mark_done"|"archive"|"trash"|"unsubscribe" }
app.post("/api/inbox/bulk-action", auth.requireAuth, async (req, res) => {
  const { threadIds, action } = req.body || {};
  if (!Array.isArray(threadIds) || !threadIds.length) {
    return res.status(400).json({ error: "threadIds_required" });
  }
  if (threadIds.length > 100) {
    return res.status(400).json({ error: "too_many", max: 100 });
  }
  if (!["mark_done", "archive", "trash", "unsubscribe"].includes(action)) {
    return res.status(400).json({ error: "bad_action" });
  }
  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: client });

    const results = {
      action,
      requested: threadIds.length,
      succeeded: 0,
      failed: 0,
      doneMessageIds: [],
      unsubscribeUrls: [], // for unsubscribe action
    };

    // Run actions in parallel batches of 5 to stay under Gmail rate limits.
    const CHUNK = 5;
    for (let i = 0; i < threadIds.length; i += CHUNK) {
      const slice = threadIds.slice(i, i + CHUNK);
      await Promise.all(
        slice.map(async (tid) => {
          try {
            if (action === "mark_done" || action === "archive") {
              const tRes = await g.users.threads.modify({
                userId: "me",
                id: tid,
                requestBody: { removeLabelIds: ["INBOX"] },
              });
              if (action === "mark_done") {
                const msgIds = (tRes.data.messages || []).map((m) => m.id);
                results.doneMessageIds.push(...msgIds);
              }
            } else if (action === "trash") {
              await g.users.threads.trash({ userId: "me", id: tid });
            } else if (action === "unsubscribe") {
              // Try to extract List-Unsubscribe from the most recent message.
              const thread = await g.users.threads.get({
                userId: "me",
                id: tid,
                format: "metadata",
                metadataHeaders: ["List-Unsubscribe", "List-Unsubscribe-Post", "From"],
              });
              const msgs = thread.data.messages || [];
              const newest = msgs[msgs.length - 1];
              const headers = mime.headersToMap(newest?.payload?.headers || []);
              const luRaw = headers["list-unsubscribe"];
              const luPost = headers["list-unsubscribe-post"];
              let url = null;
              if (luRaw) {
                // Format: <https://example.com/unsub>, <mailto:unsub@example.com>
                const matches = luRaw.match(/<([^>]+)>/g) || [];
                for (const m of matches) {
                  const u = m.slice(1, -1);
                  if (u.startsWith("http")) { url = u; break; }
                }
                if (!url && matches.length) {
                  // mailto: fallback — return so the client can mailto:
                  url = matches[0].slice(1, -1);
                }
              }
              // If sender supports one-click POST unsubscribe, do it server-side.
              if (url && url.startsWith("http") && luPost && /One-Click/i.test(luPost)) {
                try {
                  await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
                } catch (_) {}
              } else if (url) {
                results.unsubscribeUrls.push({ threadId: tid, url, from: headers.from || "" });
              }
              // Always archive after unsubscribing.
              await g.users.threads.modify({
                userId: "me",
                id: tid,
                requestBody: { removeLabelIds: ["INBOX"] },
              });
            }
            results.succeeded++;
          } catch (err) {
            console.warn(`[bulk-action ${action} ${tid}] failed:`, err.message);
            results.failed++;
          }
        })
      );
    }

    // For mark_done, also stamp the classification table.
    if (results.doneMessageIds.length) {
      try {
        await classifier.markMessagesDone(
          req.user.id,
          results.doneMessageIds,
          "Bulk cleanup"
        );
      } catch (err) {
        console.warn("[bulk-action] markMessagesDone failed:", err.message);
      }
    }

    // Invalidate cached inbox rows for every thread we acted on, so the
    // next read doesn't show stale URGENT pills on already-archived rows.
    if (action !== "unsubscribe") {
      for (const tid of threadIds) {
        try { await inboxCache.invalidateThread(req.user.id, tid); } catch (_) {}
      }
    } else {
      // unsubscribe also archives — invalidate any thread we successfully processed.
      for (const tid of threadIds) {
        try { await inboxCache.invalidateThread(req.user.id, tid); } catch (_) {}
      }
    }

    // Phase 5.AF — log each thread-level action for decision-rule mining.
    // Best-effort: failures don't affect the response. We log BEFORE
    // invalidating cache… wait, we already invalidated above. Cache still
    // has the rows briefly because invalidation marks-for-refresh rather
    // than deleting — but to be safe we capture metadata up front next time.
    try {
      const decisionRules = require("./lib/decisionRules");
      await decisionRules.logActionsForThreads(req.user, action, threadIds);
    } catch (err) {
      console.warn("[bulk-action] action log failed:", err.message);
    }

    res.json({ ok: true, ...results });
  } catch (err) {
    console.error("[/api/inbox/bulk-action] failed:", err);
    res.status(500).json({ error: "bulk_action_failed", message: err.message });
  }
});

// Convert a batch of inbox threads into to-do tasks.
// Used by the guided inbox-organize routine (steps 5+6 — high/medium
// priority unanswered). Each item becomes one task linked back to its
// source email via source_message_id + source_thread_id.
// Body: {
//   items: [{ threadId, messageId, senderName, senderEmail, subject }],
//   listName?: string,   // defaults to "Reply to"; auto-created if missing
//   important?: boolean, // step 5 = true, step 6 = false
//   inMyDay?: boolean    // step 5 = true, step 6 = false
// }
app.post("/api/inbox/add-to-todo", auth.requireAuth, async (req, res) => {
  const { items, listName, important, inMyDay } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "items_required" });
  }
  if (items.length > 100) {
    return res.status(400).json({ error: "too_many", max: 100 });
  }
  try {
    // Resolve target list — find by case-insensitive name or auto-create.
    let listId = null;
    let resolvedName = null;
    const wantedName = (listName || "Reply to").trim();
    const existing = await tasks.listLists(req.user.id);
    const match = existing.find(
      (l) => (l.name || "").toLowerCase() === wantedName.toLowerCase()
    );
    if (match) {
      listId = Number(match.id);
      resolvedName = match.name;
    } else {
      const created = await tasks.createList(req.user.id, { name: wantedName });
      listId = Number(created.id);
      resolvedName = created.name;
    }

    const created = [];
    const deduped = [];
    const failed = [];
    for (const it of items) {
      try {
        const senderLabel = it.senderName || it.senderEmail || "(unknown sender)";
        const title = `Reply to ${senderLabel}${it.subject ? ` — ${it.subject}` : ""}`.slice(0, 500);
        const row = await tasks.createTask(req.user.id, {
          title,
          list_id: listId,
          notes: null,
          important: !!important,
          in_my_day: !!inMyDay,
          source_message_id: it.messageId || null,
          source_thread_id: it.threadId || null,
        });
        const entry = { taskId: Number(row.id), messageId: it.messageId };
        if (row.deduped) deduped.push(entry);
        else created.push(entry);
      } catch (err) {
        console.warn("[add-to-todo] create failed:", err.message);
        failed.push({ messageId: it.messageId, error: err.message });
      }
    }

    res.json({
      ok: true,
      created: created.length,
      deduped: deduped.length,
      failed: failed.length,
      listId,
      listName: resolvedName,
      tasks: created,
      dedupedTasks: deduped,
      failures: failed,
    });
  } catch (err) {
    console.error("[/api/inbox/add-to-todo] failed:", err);
    res.status(500).json({ error: "add_to_todo_failed", message: err.message });
  }
});

// Counts for the folder rail badges — unread inbox + total drafts.
app.get("/api/counts", auth.requireAuth, async (req, res) => {
  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: client });

    // Use labels.get for fast totals (no fetch).
    const [inboxLabel, draftsLabel] = await Promise.all([
      g.users.labels.get({ userId: "me", id: "INBOX" }).catch(() => null),
      g.users.labels.get({ userId: "me", id: "DRAFT" }).catch(() => null),
    ]);

    res.json({
      inbox: inboxLabel?.data.messagesTotal || 0,
      inboxUnread: inboxLabel?.data.messagesUnread || 0,
      drafts: draftsLabel?.data.messagesTotal || 0,
    });
  } catch (err) {
    console.error("[/api/counts] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
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
    // Update inbox cache so the UI reflects label changes immediately
    // without waiting for the next background sync.
    try {
      if (remove.includes("INBOX")) {
        await inboxCache.invalidateMessage(req.user.id, id);
      }
      if (add.includes("UNREAD"))   await inboxCache.setUnread(req.user.id, id, true);
      if (remove.includes("UNREAD")) await inboxCache.setUnread(req.user.id, id, false);
      if (add.includes("STARRED"))   await inboxCache.setStarred(req.user.id, id, true);
      if (remove.includes("STARRED")) await inboxCache.setStarred(req.user.id, id, false);
    } catch (_) {}

    // Phase 5.AF — log label changes as either "archive" (INBOX removed)
    // or generic "label" so the miner can find sender-level archive
    // patterns even when users single-click Archive from the row hover.
    try {
      const decisionRules = require("./lib/decisionRules");
      // Look up cached metadata by message_id.
      const metaRow = await pool.query(
        `SELECT thread_id, from_header, subject FROM inbox_cache
          WHERE user_id = $1 AND message_id = $2 LIMIT 1`,
        [req.user.id, id]
      );
      const meta = metaRow.rows[0];
      if (meta) {
        if (remove.includes("INBOX")) {
          await decisionRules.logAction(req.user, "archive", {
            messageId: id,
            threadId: meta.thread_id,
            from: meta.from_header,
            subject: meta.subject,
          });
        } else if (add.length || remove.length) {
          await decisionRules.logAction(req.user, "label", {
            messageId: id,
            threadId: meta.thread_id,
            from: meta.from_header,
            subject: meta.subject,
            signals: { add, remove },
          });
        }
      }
    } catch (err) {
      console.warn("[/api/gmail/message/:id/labels] action log failed:", err.message);
    }

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
    // Capture metadata BEFORE invalidating, so action-log has sender info.
    let trashMeta = null;
    try {
      const r = await pool.query(
        `SELECT thread_id, from_header, subject FROM inbox_cache
          WHERE user_id = $1 AND message_id = $2 LIMIT 1`,
        [req.user.id, id]
      );
      trashMeta = r.rows[0] || null;
    } catch (_) {}

    await g.users.messages.trash({ userId: "me", id });
    try { await inboxCache.invalidateMessage(req.user.id, id); } catch (_) {}

    // Phase 5.AF — log the delete for decision-rule mining.
    if (trashMeta) {
      try {
        const decisionRules = require("./lib/decisionRules");
        await decisionRules.logAction(req.user, "delete", {
          messageId: id,
          threadId: trashMeta.thread_id,
          from: trashMeta.from_header,
          subject: trashMeta.subject,
        });
      } catch (err) {
        console.warn("[/api/gmail/message/:id/trash] action log failed:", err.message);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/gmail/message/:id/trash] failed:", err);
    res.status(500).json({ error: "trash_failed", message: err.message });
  }
});

// Snooze a message/thread until a future time. Removes INBOX label so it
// disappears from the inbox view, then a background worker re-adds it at
// the wake time.
app.post("/api/inbox/snooze", auth.requireAuth, async (req, res) => {
  const { messageId, threadId, snoozeUntil, stub } = req.body || {};
  if (!messageId) return res.status(400).json({ error: "messageId_required" });
  if (!snoozeUntil) return res.status(400).json({ error: "snoozeUntil_required" });
  try {
    const row = await snooze.snoozeThread(req.user.id, {
      messageId,
      threadId,
      snoozeUntil,
      stub: stub || {},
    });
    // Phase 5.AF — log this snooze for decision-rule mining.
    try {
      const decisionRules = require("./lib/decisionRules");
      await decisionRules.logAction(req.user, "snooze", {
        messageId,
        threadId,
        from: stub?.from || row?.from_header,
        subject: stub?.subject || row?.subject,
        signals: { snooze_until: snoozeUntil },
      });
    } catch (err) {
      console.warn("[/api/inbox/snooze] action log failed:", err.message);
    }
    res.json({ ok: true, snoozeUntil: row.snooze_until, id: Number(row.id) });
  } catch (err) {
    console.error("[/api/inbox/snooze] failed:", err);
    res.status(500).json({ error: err.message, message: err.message });
  }
});

// List currently-snoozed messages (the "Snoozed" smart folder).
app.get("/api/inbox/snoozed", auth.requireAuth, async (req, res) => {
  try {
    const messages = await snooze.listSnoozed(req.user.id);
    res.json({ messages, count: messages.length });
  } catch (err) {
    console.error("[/api/inbox/snoozed] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

// Un-snooze — wake the message now (re-add INBOX + UNREAD).
app.delete("/api/inbox/snooze/:messageId", auth.requireAuth, async (req, res) => {
  const messageId = req.params.messageId;
  if (!messageId) return res.status(400).json({ error: "messageId_required" });
  try {
    const result = await snooze.unsnooze(req.user.id, messageId);
    if (!result) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/inbox/snooze/:id] unsnooze failed:", err);
    res.status(500).json({ error: "unsnooze_failed", message: err.message });
  }
});

// Stream a Gmail attachment back to the browser. Gmail's API returns
// base64-encoded bytes; we decode + set the right Content-Type + filename
// headers so the browser saves it cleanly.
app.get("/api/gmail/message/:id/attachment/:attachmentId", auth.requireAuth, async (req, res) => {
  const id = req.params.id;
  const attachmentId = req.params.attachmentId;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: "bad_id" });
  if (!attachmentId) return res.status(400).json({ error: "bad_attachment_id" });

  const filename = (req.query.filename || "attachment").toString().replace(/[/\\]/g, "_");
  const mimeType = (req.query.mimeType || "application/octet-stream").toString();

  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: client });
    const r = await g.users.messages.attachments.get({
      userId: "me",
      messageId: id,
      id: attachmentId,
    });
    // Gmail returns urlsafe base64 — convert to standard b64 then decode.
    const b64 = (r.data.data || "").replace(/-/g, "+").replace(/_/g, "/");
    const buffer = Buffer.from(b64, "base64");

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(buffer);
  } catch (err) {
    console.error("[/api/gmail/message/:id/attachment/:attachmentId] failed:", err);
    res.status(500).json({ error: "attachment_fetch_failed", message: err.message });
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
// Body: { messages: [{ id, threadId, from, subject, snippet }, ...] }
//
// BEFORE classifying, checks each unique thread for SENT messages from the
// user. If the user has replied to a thread, all of its inbox messages get
// auto-marked DONE — no AI call needed. This keeps the live state in sync
// with Gmail, including replies sent from the Gmail web/mobile UI directly.
app.post("/api/classify", auth.requireAuth, async (req, res) => {
  const { messages, force } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages_required" });
  }
  if (messages.length > 100) {
    return res.status(400).json({ error: "too_many", max: 100 });
  }

  try {
    // ---- 1. Detect threads the user has already replied to. ----
    const threadIds = [
      ...new Set(messages.map((m) => m.threadId).filter(Boolean)),
    ];
    let repliedThreadIds = new Set();
    let liveSyncCount = 0;
    if (threadIds.length) {
      try {
        const creds = await auth.loadGoogleCreds(req.user.id);
        if (creds) {
          const oauthClient = gmail.authedClientFromTokens(creds);
          const g = google.gmail({ version: "v1", auth: oauthClient });
          const states = await Promise.all(
            threadIds.slice(0, 50).map((id) =>
              g.users.threads
                .get({ userId: "me", id, format: "minimal" })
                .then((r) => {
                  const msgs = r.data.messages || [];
                  // User has replied if any message in thread has SENT label
                  // AND the LAST message in the thread is from the user.
                  const lastMsg = msgs[msgs.length - 1];
                  const userIsLastSender =
                    lastMsg && (lastMsg.labelIds || []).includes("SENT");
                  return { id, userReplied: !!userIsLastSender };
                })
                .catch(() => null)
            )
          );
          for (const s of states) {
            if (s && s.userReplied) repliedThreadIds.add(s.id);
          }
        }
      } catch (err) {
        console.warn("[classify] thread-state check failed:", err.message);
      }
    }

    // Messages whose thread has been replied to → mark DONE immediately.
    const doneMessageIds = messages
      .filter((m) => m.threadId && repliedThreadIds.has(m.threadId))
      .map((m) => m.id);
    if (doneMessageIds.length) {
      try {
        await classifier.markMessagesDone(
          req.user.id,
          doneMessageIds,
          "Replied — live sync"
        );
        liveSyncCount = doneMessageIds.length;
      } catch (err) {
        console.warn("[classify] markMessagesDone failed:", err.message);
      }
    }

    // ---- 2. Enrich each remaining message with recipient headers + body.
    // The classifier needs to know if THIS user is in TO vs CC vs BCC, and
    // whether the body has a direct ask for them. Snippet alone isn't enough.
    // Fetch in parallel batches of 10 to stay under Gmail rate limits.
    const remaining = messages.filter((m) => !doneMessageIds.includes(m.id));
    let enriched = remaining;
    if (remaining.length) {
      try {
        const creds = await auth.loadGoogleCreds(req.user.id);
        if (creds) {
          const oauthClient = gmail.authedClientFromTokens(creds);
          const g = google.gmail({ version: "v1", auth: oauthClient });
          const CHUNK = 10;
          const enrichedRows = [];
          for (let i = 0; i < remaining.length; i += CHUNK) {
            const slice = remaining.slice(i, i + CHUNK);
            const fetches = await Promise.all(
              slice.map((m) =>
                g.users.messages
                  .get({ userId: "me", id: m.id, format: "full" })
                  .then((r) => r.data)
                  .catch(() => null)
              )
            );
            for (let j = 0; j < slice.length; j++) {
              const orig = slice[j];
              const data = fetches[j];
              if (!data) {
                enrichedRows.push(orig);
                continue;
              }
              const headers = mime.headersToMap(data.payload?.headers || []);
              const body = mime.pickBody(data.payload);
              const bodyText = (body.text || mime.htmlToText(body.html || "") || "").slice(0, 1500);
              enrichedRows.push({
                ...orig,
                from: headers.from || orig.from || "",
                to: headers.to || "",
                cc: headers.cc || "",
                bcc: headers.bcc || "",
                subject: headers.subject || orig.subject || "",
                bodyText,
              });
            }
          }
          enriched = enrichedRows;
        }
      } catch (err) {
        console.warn("[classify] enrichment failed:", err.message);
      }
    }

    // ---- 2b. Phase 5.AF — Apply confirmed decision rules. Each matched
    // message gets actioned (archive / delete / mark_done) and stripped
    // from the to-be-classified set so we don't pay classifier tokens
    // for mail we already auto-handled.
    let ruleHandledIds = [];
    let ruleByAction = {};
    try {
      const decisionRules = require("./lib/decisionRules");
      const creds = await auth.loadGoogleCreds(req.user.id);
      let g = null;
      if (creds) {
        const oauthClient = gmail.authedClientFromTokens(creds);
        g = google.gmail({ version: "v1", auth: oauthClient });
      }
      const result = await decisionRules.applyRulesTo(req.user, g, enriched);
      ruleHandledIds = result.handled.map((h) => h.id);
      ruleByAction = result.byAction;
      // Invalidate inbox cache + mark-done where appropriate.
      for (const h of result.handled) {
        try { await inboxCache.invalidateMessage(req.user.id, h.id); } catch (_) {}
      }
      const markDoneIds = result.handled.filter((h) => h.action === "mark_done").map((h) => h.id);
      if (markDoneIds.length) {
        await classifier.markMessagesDone(req.user.id, markDoneIds, "Auto-applied rule");
      }
    } catch (err) {
      console.warn("[classify] rule application failed:", err.message);
    }
    const toClassify = enriched.filter((m) => !ruleHandledIds.includes(m.id));

    // ---- 3. Classify the enriched set (and pick up any already-cached). ----
    const aiClassifications = await classifier.classifyForUser(
      req.user,
      toClassify,
      { force: !!force }
    );

    // Merge: build the full response including DONE entries.
    const full = { ...aiClassifications };
    for (const id of doneMessageIds) {
      full[id] = {
        id,
        category: "DONE",
        urgency: "low",
        reason: "Replied — live sync",
      };
    }
    // Rule-handled messages return as DONE / archived so the row hides.
    for (const id of ruleHandledIds) {
      full[id] = {
        id,
        category: "DONE",
        urgency: "low",
        reason: "Auto-handled by your rule",
      };
    }

    res.json({
      classifications: full,
      count: Object.keys(full).length,
      liveSyncCount,
      ruleHandledCount: ruleHandledIds.length,
      ruleByAction,
    });
  } catch (err) {
    console.error("[/api/classify] failed:", err);
    res.status(500).json({ error: "classify_failed", message: err.message });
  }
});

// Fetch a single message in full, including parsed body.
// Also fetches inline images (signature logos, embedded screenshots) and
// rewrites cid: references in the HTML to data: URIs so they render.
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
    let safeHtml = mime.sanitizeHtml(body.html);

    // Resolve inline images (cid: references → data: URIs).
    if (body.inlineImages && body.inlineImages.length && safeHtml) {
      const fetches = await Promise.all(
        body.inlineImages.map(async (img) => {
          try {
            let bytes;
            if (img.inlineData) {
              // Already raw bytes from a base64-decoded data part.
              bytes = Buffer.from(img.inlineData, "binary");
            } else if (img.attachmentId) {
              const a = await g.users.messages.attachments.get({
                userId: "me",
                messageId: id,
                id: img.attachmentId,
              });
              const b64 = (a.data.data || "")
                .replace(/-/g, "+")
                .replace(/_/g, "/");
              bytes = Buffer.from(b64, "base64");
            }
            if (!bytes) return null;
            const dataUri = `data:${img.mimeType};base64,${bytes.toString("base64")}`;
            return { contentId: img.contentId, dataUri };
          } catch (err) {
            console.warn("[inline-image fetch] failed:", err.message);
            return null;
          }
        })
      );
      for (const img of fetches.filter(Boolean)) {
        if (!img.contentId) continue;
        // Match both cid:<id> and cid:<id> (case-insensitive); content IDs may
        // include angle-bracket-stripped form. Escape regex special chars.
        const cidEscaped = img.contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`cid:${cidEscaped}`, "gi");
        safeHtml = safeHtml.replace(re, img.dataUri);
      }
    }

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
      inlineImageCount: (body.inlineImages || []).length,
      unread: (m.labelIds || []).includes("UNREAD"),
    });
  } catch (err) {
    console.error("[/api/gmail/message/:id] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

// Delta draft a reply — generate a reply body for the open email.
app.post("/api/assistant/draft", auth.requireAuth, async (req, res) => {
  const { openMessageId, instructions, mode } = req.body || {};
  if (!openMessageId) {
    return res.status(400).json({ error: "openMessageId_required" });
  }
  try {
    const result = await assistant.draftReply({
      user: req.user,
      openMessageId,
      instructions: instructions || "",
      mode: mode === "reply-all" ? "reply-all" : "reply",
    });
    // Tell client whether the signature will be appended on save.
    let signatureAvailable = false;
    try {
      const creds = await auth.loadGoogleCreds(req.user.id);
      if (creds) {
        const client = gmail.authedClientFromTokens(creds);
        const sig = await gmail.getCachedSignature(req.user.id, client);
        signatureAvailable = !!(sig && sig.html);
      }
    } catch (_) {}

    res.json({
      to: result.to,
      cc: result.cc || "",
      subject: result.subject,
      body: result.body,
      mode: result.mode,
      threadId: result.threadId,
      inReplyTo: result.inReplyTo,
      styleExamples: result.styleExamples,
      signatureAvailable,
      // Phase 5.AE — opaque id the client carries back through send so
      // we can capture the user's edits.
      deltaDraftId: result.deltaDraftId || null,
      voiceProfileApplied: !!result.voiceProfileApplied,
    });
  } catch (err) {
    console.error("[/api/assistant/draft] failed:", err);
    res.status(500).json({ error: "draft_failed", message: err.message });
  }
});

// ====================================================================
// Compose settings — aliases (sendAs) + signature import + preferences
// ====================================================================
app.get("/api/compose/settings", auth.requireAuth, async (req, res) => {
  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const sendAs = await gmail.getCachedSendAs(req.user.id, client, false);

    res.json({
      signatureMode: req.user.signature_mode || "always",
      defaultSendAs: req.user.default_send_as || null,
      aliases: sendAs.aliases,
      primarySignature: sendAs.primarySignature
        ? {
            sendAsEmail: sendAs.primarySignature.sendAsEmail,
            displayName: sendAs.primarySignature.displayName,
            html: sendAs.primarySignature.html,
            plainText: gmail.signatureToPlainText(sendAs.primarySignature.html),
          }
        : null,
    });
  } catch (err) {
    console.error("[/api/compose/settings] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.patch("/api/compose/settings", auth.requireAuth, async (req, res) => {
  const { signatureMode, defaultSendAs } = req.body || {};
  if (signatureMode && !["always", "first", "never"].includes(signatureMode)) {
    return res.status(400).json({ error: "bad_signature_mode" });
  }
  try {
    const fields = [];
    const values = [];
    let i = 1;
    if (signatureMode !== undefined) {
      fields.push(`signature_mode = $${i++}`);
      values.push(signatureMode);
    }
    if (defaultSendAs !== undefined) {
      fields.push(`default_send_as = $${i++}`);
      values.push(defaultSendAs || null);
    }
    if (!fields.length) return res.json({ ok: true });
    values.push(req.user.id);
    await pool.query(`UPDATE users SET ${fields.join(", ")} WHERE id = $${i}`, values);
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/compose/settings] patch failed:", err);
    res.status(500).json({ error: "update_failed", message: err.message });
  }
});

// Force-refresh aliases + signature from Gmail (busts the 60-min cache).
app.post("/api/compose/refresh", auth.requireAuth, async (req, res) => {
  try {
    gmail.invalidateGmailCaches(req.user.id);
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const sendAs = await gmail.getCachedSendAs(req.user.id, client, true);
    res.json({
      ok: true,
      aliases: sendAs.aliases.length,
      hasSignature: !!sendAs.primarySignature,
    });
  } catch (err) {
    res.status(500).json({ error: "refresh_failed", message: err.message });
  }
});

// Read the user's current Gmail signature — for verification.
// Visit /api/gmail/signature in the browser to see the raw HTML + plain text.
app.get("/api/gmail/signature", auth.requireAuth, async (req, res) => {
  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const sig = await gmail.fetchPrimarySignature(client);
    if (!sig) {
      return res.json({
        configured: false,
        note: "No signature found in users.settings.sendAs.list — either you have none set, or Gmail returned an empty signature field.",
      });
    }
    res.json({
      configured: true,
      sendAsEmail: sig.sendAsEmail,
      displayName: sig.displayName,
      htmlLength: sig.html?.length || 0,
      plainText: gmail.signatureToPlainText(sig.html).slice(0, 1500),
      htmlPreview: (sig.html || "").slice(0, 4000),
    });
  } catch (err) {
    console.error("[/api/gmail/signature] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

// SEND a real email through Gmail. Same multipart/alternative builder as
// drafts. User clicks Send inside Delta Mail — Gmail's users.messages.send
// is the actual send call. This is the trust line: human clicks Send;
// Delta never auto-sends without that explicit click.
app.post("/api/gmail/send", auth.requireAuth, async (req, res) => {
  const { to, cc, bcc, subject, body, bodyHtml, threadId, inReplyTo, deltaDraftId } = req.body || {};
  if (!to || (!body && !bodyHtml)) return res.status(400).json({ error: "to_and_body_required" });
  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: client });

    // Same signature handling as the draft endpoint — honor signature_mode.
    const sig = await gmail.getCachedSignature(req.user.id, client);
    const mode = req.user.signature_mode || "always";
    const useSig =
      mode === "never" ? false :
      mode === "first" ? !inReplyTo :
      true;
    const sigHtml = useSig && sig?.html ? sig.html : "";
    const sigText = useSig && sig ? gmail.signatureToPlainText(sig.html) : "";

    const raw = buildMultipartMessage({
      to,
      cc, bcc,
      subject: subject || "(no subject)",
      bodyText: body,
      bodyHtml,
      signatureText: sigText,
      signatureHtml: sigHtml,
      inReplyTo,
    });

    const sendRes = await g.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        ...(threadId ? { threadId } : {}),
      },
    });

    // After-send hygiene: if this was a REPLY (we have a threadId from the
    // original message), auto-archive the thread + mark all messages in it
    // as DONE so the row shows a green ✓ chip and disappears from inbox.
    // Standard Gmail "Send and Archive" pattern.
    let archivedThreadId = null;
    let markedDone = 0;
    if (threadId) {
      try {
        // Archive the entire thread (remove INBOX label from all messages in it).
        const tRes = await g.users.threads.modify({
          userId: "me",
          id: threadId,
          requestBody: { removeLabelIds: ["INBOX"] },
        });
        archivedThreadId = threadId;
        try { await inboxCache.invalidateThread(req.user.id, threadId); } catch (_) {}
        // Mark the messages in the thread as DONE in our classification table.
        const messageIds = (tRes.data.messages || []).map((m) => m.id);
        if (messageIds.length) {
          markedDone = await classifier.markMessagesDone(
            req.user.id,
            messageIds,
            "Replied + archived"
          );
        }
      } catch (err) {
        console.warn("[/api/gmail/send] auto-archive failed:", err.message);
        // Send still succeeded — archive failure is non-fatal.
      }
    }

    // Phase 5.AE — if this send carries a Delta draft id, look up the
    // original draft + diff against what was actually sent. The diff is
    // the "voice signal" Delta will learn from. Best-effort; failure does
    // not affect the user-visible send result.
    let voiceRecorded = null;
    if (deltaDraftId) {
      try {
        const voice = require("./lib/voice");
        voiceRecorded = await voice.recordSend(req.user.id, deltaDraftId, body || bodyHtml || "");
      } catch (err) {
        console.warn("[/api/gmail/send] voice capture failed:", err.message);
      }
    }

    // Phase 5.AF — log this reply (and the implicit archive) for
    // decision-rule mining. Best-effort.
    if (threadId) {
      try {
        const decisionRules = require("./lib/decisionRules");
        await decisionRules.logActionsForThreads(req.user, "reply", [threadId]);
        if (archivedThreadId) {
          await decisionRules.logActionsForThreads(req.user, "archive", [archivedThreadId]);
        }
      } catch (err) {
        console.warn("[/api/gmail/send] action log failed:", err.message);
      }
    }

    res.json({
      ok: true,
      sentMessageId: sendRes.data.id,
      threadId: sendRes.data.threadId,
      signatureUsed: !!sigHtml,
      archived: !!archivedThreadId,
      archivedThreadId,
      markedDone,
      voiceRecorded,
    });
  } catch (err) {
    console.error("[/api/gmail/send] failed:", err);
    res.status(500).json({ error: "send_failed", message: err.message });
  }
});

// Create a real Gmail draft in the user's Drafts folder.
// User reviews + sends from Gmail itself; we never send on their behalf.
//
// Builds a multipart/alternative MIME message with:
//   - text/plain part (body + signature in plain text)
//   - text/html part (body in <p>s + the user's actual HTML signature)
// Gmail then shows the proper formatted signature in the draft.
app.post("/api/gmail/draft", auth.requireAuth, async (req, res) => {
  const { to, cc, bcc, subject, body, bodyHtml, threadId, inReplyTo } = req.body || {};
  if (!to || (!body && !bodyHtml)) return res.status(400).json({ error: "to_and_body_required" });
  try {
    const creds = await auth.loadGoogleCreds(req.user.id);
    if (!creds) return res.status(400).json({ error: "no_google_creds" });
    const client = gmail.authedClientFromTokens(creds);
    const g = google.gmail({ version: "v1", auth: client });

    // Fetch the user's official Gmail signature (cached for 60 min).
    const sig = await gmail.getCachedSignature(req.user.id, client);

    // Decide whether to actually append the signature for THIS draft.
    // 'always'  → every outgoing message
    // 'first'   → only the first message of a NEW thread (no inReplyTo)
    // 'never'   → never
    const mode = req.user.signature_mode || "always";
    const useSig =
      mode === "never"
        ? false
        : mode === "first"
        ? !inReplyTo  // first message in a new thread
        : true;       // always (default)

    const sigHtml = useSig && sig?.html ? sig.html : "";
    const sigText = useSig && sig ? gmail.signatureToPlainText(sig.html) : "";

    const raw = buildMultipartMessage({
      to,
      cc, bcc,
      subject: subject || "(no subject)",
      bodyText: body,
      bodyHtml,
      signatureText: sigText,
      signatureHtml: sigHtml,
      inReplyTo,
    });

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
      signatureUsed: !!sigHtml,
    });
  } catch (err) {
    console.error("[/api/gmail/draft] failed:", err);
    res.status(500).json({ error: "draft_save_failed", message: err.message });
  }
});

// Builds a multipart/alternative RFC-2822 message, base64url-encoded for Gmail.
// Accepts EITHER:
//   - bodyText (plain text — auto-escaped and wrapped into HTML), OR
//   - bodyHtml (already-rich HTML from the rich-text compose editor)
// Always emits BOTH a text/plain and a text/html part so any client renders OK.
function buildMultipartMessage({ to, cc, bcc, subject, bodyText, bodyHtml, signatureText, signatureHtml, inReplyTo }) {
  const boundary = "delta_" + Math.random().toString(36).slice(2) + Date.now().toString(36);

  let textForPlain;
  let htmlForBody;
  if (bodyHtml && String(bodyHtml).trim()) {
    // Rich HTML body from the compose editor — use as-is. Plain-text version
    // generated from HTML so the text/plain part stays meaningful.
    htmlForBody = String(bodyHtml);
    textForPlain = mime.htmlToText(htmlForBody);
  } else {
    // Plain-text body (Delta drafts, replies) — escape + wrap into <p>s.
    textForPlain = String(bodyText || "");
    htmlForBody = textForPlain
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
      .join("\n");
  }

  // Plain-text part — body, blank line, "--", signature
  const textPart = [
    textForPlain,
    signatureText ? `\r\n\r\n-- \r\n${signatureText}` : "",
  ].join("");

  // HTML part — body HTML + signature HTML (already in HTML form)
  const htmlPart =
    `<div style="font-family:Arial,sans-serif;font-size:13.5px;line-height:1.5;color:#222">` +
    htmlForBody +
    (signatureHtml
      ? `<br><div class="gmail_signature" data-smartmail="gmail_signature">${signatureHtml}</div>`
      : "") +
    `</div>`;

  const headers = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }

  const message =
    headers.join("\r\n") +
    "\r\n\r\n" +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n\r\n` +
    textPart +
    "\r\n\r\n" +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n\r\n` +
    htmlPart +
    "\r\n\r\n" +
    `--${boundary}--\r\n`;

  return Buffer.from(message, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

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
  .then(async () => {
    console.log("[boot] db ready");
    startBackfillWorker();
    startInboxCacheWorker();
    startSnoozeWakeWorker();
    startMemoryEmbeddingBackfillWorker();
    try {
      await memoryExtractor.ensureSchema();
      startMemoryExtractorWorker();
    } catch (err) {
      console.warn("[boot] memory extractor schema/worker failed (non-fatal):", err.message);
    }
    try {
      await briefing.ensureSchema();
      startBriefingPrewarmWorker();
    } catch (err) {
      console.warn("[boot] briefing schema/worker failed (non-fatal):", err.message);
    }
    startVoiceDistillWorker();
    startDecisionRuleMinerWorker();
    startGmailPushRenewerWorker();
  })
  .catch((err) => console.error("[boot] db init failed (non-fatal):", err));

// ====================================================================
// BACKFILL WORKER — runs every 20s, finds active jobs and advances them.
// Each user gets ~1 tick per worker cycle to share the loop fairly.
// ====================================================================
function startBackfillWorker() {
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      const r = await pool.query(
        `SELECT user_id FROM backfill_jobs
          WHERE status IN ('pending', 'running')
          ORDER BY updated_at ASC
          LIMIT 3`
      );
      for (const row of r.rows) {
        try {
          await backfill.tick(row.user_id);
        } catch (err) {
          console.error(`[backfill-worker] user ${row.user_id} tick failed:`, err);
        }
      }
    } catch (err) {
      console.error("[backfill-worker] cycle failed:", err);
    } finally {
      running = false;
    }
  };
  // First run 10s after boot, then every 20s.
  setTimeout(cycle, 10_000);
  setInterval(cycle, 20_000);
  console.log("[boot] backfill worker scheduled (cycle 20s)");
}

// ====================================================================
// INBOX CACHE WORKER — every 30s, finds users whose inbox cache is older
// than 90s and refreshes them in parallel (up to 3 at a time). This keeps
// the cache within 90s of Gmail truth without overwhelming the Gmail API.
// ====================================================================
function startInboxCacheWorker() {
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      const due = await inboxCache.listUsersDueForSync({ stalerThanMs: 90_000, limit: 3 });
      await Promise.all(
        due.map((row) =>
          inboxCache.syncForUser(row.user_id).catch((err) => {
            console.warn(`[inbox-cache-worker] user ${row.user_id} sync failed:`, err.message);
          })
        )
      );
    } catch (err) {
      console.error("[inbox-cache-worker] cycle failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(cycle, 5_000);
  setInterval(cycle, 30_000);
  console.log("[boot] inbox cache worker scheduled (cycle 30s, per-user 90s freshness)");
}

// ====================================================================
// MORNING BRIEFING PRE-WARM — Phase 5.AD. Every 15 minutes between
// 04:00–10:00 UTC, generate today's brief for any user who hasn't gotten
// one yet. Users who open Delta first still hit the lazy path and get
// the brief generated on-demand.
// ====================================================================
function startBriefingPrewarmWorker() {
  let running = false;
  const cycle = async () => {
    if (running) return;
    const hourUTC = new Date().getUTCHours();
    // Only run during morning prep window — outside this, lazy generation
    // on /api/briefing/today handles it.
    if (hourUTC < 3 || hourUTC > 11) return;
    running = true;
    try {
      const due = await briefing.listUsersNeedingBrief({ limit: 3 });
      for (const user of due) {
        try {
          await briefing.generateForUser(user);
          console.log(`[briefing-prewarm] generated for user ${user.id} (${user.email})`);
        } catch (err) {
          console.warn(`[briefing-prewarm] user ${user.id} failed:`, err.message);
        }
      }
    } catch (err) {
      console.error("[briefing-prewarm] cycle failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(cycle, 60_000);            // 1 min after boot
  setInterval(cycle, 15 * 60 * 1000);   // every 15 min
  console.log("[boot] briefing prewarm scheduled (cycle 15m, window 03-11 UTC)");
}

// ====================================================================
// MEMORY EMBEDDING BACKFILL — Phase 5.AC. Once per minute, look for
// delta_memory rows without an embedding and generate one (via OpenAI).
// Throttled to 25 rows per cycle to keep the OpenAI bill predictable.
// No-op when OPENAI_API_KEY isn't set.
// ====================================================================
function startMemoryEmbeddingBackfillWorker() {
  const memory = require("./lib/memory");
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      const result = await memory.backfillEmbeddings({ limit: 25 });
      if (result.backfilled > 0) {
        console.log(`[memory-embedding-backfill] backfilled ${result.backfilled} memories`);
      }
    } catch (err) {
      console.error("[memory-embedding-backfill] cycle failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(cycle, 30_000);
  setInterval(cycle, 60_000);
  console.log("[boot] memory embedding backfill scheduled (cycle 60s, 25/cycle)");
}

// ====================================================================
// VOICE DISTILL WORKER — Phase 5.AE. Every 6h, picks up to 5 users who
// have accumulated enough new edits since their last voice-profile
// distill, and refreshes the profile from their recent edits. Most
// users will also see their profile refreshed opportunistically right
// after a send via voice.distillProfileIfReady(), so this worker is
// mostly a safety net for slow-trickle users.
//
// Also prunes original-draft rows older than 30d on the same cadence.
// ====================================================================
function startVoiceDistillWorker() {
  const voice = require("./lib/voice");
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      const due = await voice.listUsersNeedingDistill({ limit: 5 });
      for (const user of due) {
        try {
          const result = await voice.distillProfile(user);
          if (result.ok) {
            console.log(`[voice-distill] user ${user.id} (${user.email}): refreshed from ${result.distilled_from} edits`);
          }
        } catch (err) {
          console.warn(`[voice-distill] user ${user.id} failed:`, err.message);
        }
      }
      const pruned = await voice.pruneOriginals({ olderThanDays: 30 });
      if (pruned > 0) console.log(`[voice-distill] pruned ${pruned} old draft originals`);
    } catch (err) {
      console.error("[voice-distill] cycle failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(cycle, 120_000); // 2 min after boot — let the rest settle
  setInterval(cycle, 6 * 60 * 60 * 1000); // every 6 hours
  console.log("[boot] voice distill scheduled (cycle 6h, 5 users/cycle)");
}

// ====================================================================
// DECISION-RULE MINER WORKER — Phase 5.AF. Every 12h, scans the action
// log per user and proposes high-confidence patterns. Candidates land
// in delta_rule_candidates and the next time the user opens Delta's
// chat they see "I noticed a pattern — confirm?" cards. Also prunes
// old action-log rows on the same cadence.
// ====================================================================
function startDecisionRuleMinerWorker() {
  const decisionRules = require("./lib/decisionRules");
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      const userIds = await decisionRules.listUsersNeedingMine({ limit: 10 });
      for (const uid of userIds) {
        try {
          const result = await decisionRules.mineCandidates(uid);
          if (result.inserted > 0) {
            console.log(`[decision-miner] user ${uid}: ${result.inserted} new candidates`);
          }
        } catch (err) {
          console.warn(`[decision-miner] user ${uid} failed:`, err.message);
        }
      }
      const pruned = await decisionRules.prune({});
      if (pruned > 0) console.log(`[decision-miner] pruned ${pruned} old action-log rows`);
    } catch (err) {
      console.error("[decision-miner] cycle failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(cycle, 180_000); // 3 min after boot
  setInterval(cycle, 12 * 60 * 60 * 1000); // every 12h
  console.log("[boot] decision-rule miner scheduled (cycle 12h, 10 users/cycle)");
}

// ====================================================================
// GMAIL PUSH RENEWER — Phase 5.AG. Gmail watches expire after 7 days.
// Once per hour, find any watch expiring within 24h and re-call
// users.watch() so it stays active. No-op if push isn't configured.
// ====================================================================
function startGmailPushRenewerWorker() {
  const gmailPush = require("./lib/gmailPush");
  if (!gmailPush.isEnabled()) {
    console.log("[boot] gmail-push renewer skipped (push not configured)");
    return;
  }
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      const result = await gmailPush.renewExpiring({ withinHours: 24, limit: 10 });
      if (result.renewed > 0) {
        console.log(`[push-renewer] renewed ${result.renewed} watches`);
      }
    } catch (err) {
      console.error("[push-renewer] cycle failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(cycle, 60_000); // 1 min after boot
  setInterval(cycle, 60 * 60 * 1000); // every hour
  console.log("[boot] gmail-push renewer scheduled (cycle 1h)");
}

// ====================================================================
// SNOOZE WAKE WORKER — every 60s, find snoozes whose time has come,
// re-add INBOX + UNREAD labels in Gmail, and mark the row woken.
// ====================================================================
function startSnoozeWakeWorker() {
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      await snooze.wakeDue({ limit: 50 });
    } catch (err) {
      console.error("[snooze-wake-worker] cycle failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(cycle, 10_000);
  setInterval(cycle, 60_000);
  console.log("[boot] snooze wake worker scheduled (cycle 60s)");
}

// ====================================================================
// MEMORY EXTRACTOR — nightly per-user pass that mines recent activity
// for durable observations. Internally each user is rate-limited to one
// run per 20h, so a cycle that fires every 60 minutes is harmless.
// ====================================================================
function startMemoryExtractorWorker() {
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      const due = await memoryExtractor.listDueUsers();
      for (const user of due) {
        try {
          await memoryExtractor.runForUser(user);
        } catch (err) {
          console.error(`[memory-extractor] user ${user.id} run failed:`, err);
        }
      }
    } catch (err) {
      console.error("[memory-extractor] cycle failed:", err);
    } finally {
      running = false;
    }
  };
  // First check 2 minutes after boot (let other things settle), then hourly.
  // The 20h rate limit inside runForUser ensures users only get a real
  // extraction pass once a day.
  setTimeout(cycle, 2 * 60 * 1000);
  setInterval(cycle, 60 * 60 * 1000);
  console.log("[boot] memory extractor scheduled (cycle 60m, per-user 20h cap)");
}
