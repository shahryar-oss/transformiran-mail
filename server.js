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

// Phase 5.AQ — Request-level timing middleware. Logs path + method +
// status + duration for every API request, so we can pinpoint slow
// endpoints. Suppresses noise for health checks and static assets.
app.use((req, res, next) => {
  if (req.path === "/healthz" || req.path.startsWith("/favicon")) return next();
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    // Only log API + auth paths, and only when slow OR error.
    const isApi = req.path.startsWith("/api/") || req.path.startsWith("/auth/");
    const shouldLog = isApi && (ms > 500 || res.statusCode >= 400);
    if (shouldLog) {
      console.log(`[req] ${req.method} ${req.path} → ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});
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
  // First-login welcome — shown until the user clicks "Get started".
  // `?welcome=1` query param lets any signed-in user preview the welcome
  // flow again without resetting their DB state. (Synced from NexaMails c6584bc.)
  if (!req.user.welcomed_at || req.query.welcome === "1") {
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

app.get("/promises", (req, res) => {
  if (!req.user) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "promises.html"));
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
    console.error("[/api/tasks/overdue-count] failed:", err);
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
    console.error("[/api/tasks/due-soon] failed:", err);
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
// Phase 5.BQ — set no-cache on HTML and JS so Safari/Chrome always
// revalidate against the server. The Express defaults rely on ETag
// but Safari can stick with a stale copy for hours; explicit
// `no-cache` forces a conditional GET on every request. Images
// and stylesheets still get the default short-lived cache.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (/\.(html|js)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    } else if (/\.css$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    }
  },
}));

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
// Commitments / promises — Phase 5.AK.
//   GET  /api/commitments              → list (default: open)
//   GET  /api/commitments?status=...   → filter by status
//   GET  /api/commitments/overdue      → just the overdue ones
//   GET  /api/commitments/stats        → counts for morning brief
//   POST /api/commitments/:id/dismiss  → cancel a wrongly-extracted one
//   POST /api/commitments/:id/fulfill  → manually mark done
// ====================================================================
app.get("/api/commitments", auth.requireAuth, async (req, res) => {
  try {
    const commitments = require("./lib/commitments");
    const status = req.query.status ? String(req.query.status) : null;
    let rows;
    if (!status || status === "open") {
      rows = await commitments.listOpen(req.user.id, { limit: 100 });
    } else {
      rows = await commitments.listAll(req.user.id, { status, limit: 100 });
    }
    res.json({ ok: true, commitments: rows, count: rows.length });
  } catch (err) {
    console.error("[/api/commitments] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.get("/api/commitments/overdue", auth.requireAuth, async (req, res) => {
  try {
    const commitments = require("./lib/commitments");
    const rows = await commitments.listOverdue(req.user.id);
    res.json({ ok: true, commitments: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.get("/api/commitments/stats", auth.requireAuth, async (req, res) => {
  try {
    const commitments = require("./lib/commitments");
    const stats = await commitments.getStats(req.user.id);
    res.json({ ok: true, ...stats });
  } catch (err) {
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.post("/api/commitments/:id/dismiss", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const commitments = require("./lib/commitments");
    const result = await commitments.dismiss(req.user.id, id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "dismiss_failed", message: err.message });
  }
});

app.post("/api/commitments/:id/fulfill", auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_id" });
  try {
    const commitments = require("./lib/commitments");
    const result = await commitments.markFulfilled(req.user.id, id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "fulfill_failed", message: err.message });
  }
});

// ====================================================================
// Diagnostic — dump raw character codes of a cached subject so we can
// see exactly what mojibake pattern the decoder is failing on.
//   GET /api/diag/subject-bytes?messageId=<gmailId>
// ====================================================================
app.get("/api/diag/subject-bytes", auth.requireAuth, async (req, res) => {
  const messageId = String(req.query.messageId || "");
  if (!messageId) return res.status(400).json({ error: "messageId required" });
  try {
    const r = await pool.query(
      `SELECT subject, from_header FROM inbox_cache WHERE user_id = $1 AND message_id = $2`,
      [req.user.id, messageId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "not in cache" });
    const subj = r.rows[0].subject || "";
    const from = r.rows[0].from_header || "";
    const dump = (s) => ({
      length: s.length,
      preview: s.slice(0, 120),
      codes: [...s].slice(0, 60).map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")),
    });
    // Now try the decoder.
    const decoded = mime.decodeMimeHeader(subj);
    res.json({
      ok: true,
      raw: { subject: dump(subj), from: dump(from) },
      decoded: { subject: decoded, equal: decoded === subj, codes: [...decoded].slice(0, 60).map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================
// Notification center — Phase 5.BB.
// Aggregates overdue promises, due-soon tasks, important-sender unread mail.
//   GET    /api/notifications              → list
//   POST   /api/notifications/seen         → clear unread badge
//   POST   /api/notifications/:id/dismiss  → hide a single notif (id is dismiss_key)
//   POST   /api/notifications/dismiss-all  → clear current list
// ====================================================================
app.get("/api/notifications", auth.requireAuth, async (req, res) => {
  try {
    const notifications = require("./lib/notifications");
    const result = await notifications.listForUser(req.user.id);
    res.json(result);
  } catch (err) {
    console.error("[/api/notifications] failed:", err);
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.post("/api/notifications/seen", auth.requireAuth, async (req, res) => {
  try {
    const notifications = require("./lib/notifications");
    await notifications.setLastSeen(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "update_failed", message: err.message });
  }
});

app.post("/api/notifications/dismiss-all", auth.requireAuth, async (req, res) => {
  try {
    const notifications = require("./lib/notifications");
    const r = await notifications.dismissAll(req.user.id);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: "dismiss_failed", message: err.message });
  }
});

app.post("/api/notifications/:id/dismiss", auth.requireAuth, async (req, res) => {
  try {
    const notifications = require("./lib/notifications");
    // The id param IS the dismiss_key (e.g. "promise-overdue:42").
    const r = await notifications.dismiss(req.user.id, req.params.id);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: "dismiss_failed", message: err.message });
  }
});

// ====================================================================
// Finance-alert diagnostics — Phase 5.AJ.
// GET  /api/finance-alerts/status     → { enabled, notify_url, watch_names }
// GET  /api/finance-alerts/recent     → last 30 alerts sent for this user
// POST /api/finance-alerts/test       → manually fire a test push (admin)
// POST /api/finance-alerts/replay/:id → re-push a previously-failed alert
// ====================================================================
app.get("/api/finance-alerts/status", auth.requireAuth, async (req, res) => {
  try {
    const f = require("./lib/financeAlerts");
    res.json({
      ok: true,
      enabled: f.isEnabled(),
      watch_names: f.watchNames(),
      notify_url: process.env.FINANCE_NOTIFY_URL || "https://transformiran.info/api/delta-bridge/notify",
    });
  } catch (err) {
    res.status(500).json({ error: "status_failed", message: err.message });
  }
});

app.get("/api/finance-alerts/recent", auth.requireAuth, async (req, res) => {
  try {
    const f = require("./lib/financeAlerts");
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const rows = await f.listRecent(req.user.id, { limit });
    res.json({ ok: true, alerts: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: "fetch_failed", message: err.message });
  }
});

app.post("/api/finance-alerts/test", auth.requireAuth, async (req, res) => {
  try {
    const f = require("./lib/financeAlerts");
    if (!f.isEnabled()) {
      return res.status(503).json({ error: "bridge_not_configured" });
    }
    // Synthetic message to exercise the push path without needing a
    // real inbox event.
    const fakeMessage = {
      message_id: "test-" + Date.now(),
      thread_id: null,
      from_header: req.body?.from || "Lana Silk <lana@transformiran.com>",
      subject: req.body?.subject || "TEST: bridge push from Email Delta",
      snippet: req.body?.snippet || "This is a test notification to verify the Email→Finance bridge is alive. Wire of €5,000 example.",
      date_header: new Date().toUTCString(),
      internal_date: Date.now(),
    };
    const match = f.matchesAlert(fakeMessage);
    if (!match) {
      return res.status(400).json({ error: "fake_message_didnt_match", hint: "include 'Lana' / 'Simon' or a financial keyword" });
    }
    const result = await f.pushNotification({
      user: req.user,
      message: fakeMessage,
      match,
    });
    res.json({ ok: result.ok, ...result, match });
  } catch (err) {
    res.status(500).json({ error: "test_failed", message: err.message });
  }
});

// ====================================================================
// Voice INPUT — Phase 5.AI. OpenAI Whisper transcription.
// POST /api/transcribe
//   Headers: Content-Type: audio/webm  (or audio/mp4, audio/ogg…)
//   Body:    raw audio bytes from MediaRecorder
//   Reply:   { ok, text }
// We accept the bytes directly rather than pulling in multer for one
// endpoint. Express's body parsers won't touch audio/* so the raw
// stream is available on req.
// ====================================================================
app.get("/api/transcribe/status", auth.requireAuth, async (req, res) => {
  try {
    const t = require("./lib/transcribe");
    res.json({ ok: true, enabled: t.isEnabled(), model: t.MODEL });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/transcribe", auth.requireAuth, async (req, res) => {
  try {
    const t = require("./lib/transcribe");
    if (!t.isEnabled()) {
      return res.status(503).json({
        error: "transcribe_not_configured",
        message: "Set OPENAI_API_KEY to enable voice input.",
      });
    }
    const mime = req.get("Content-Type") || "audio/webm";
    if (!/^audio\//.test(mime)) {
      return res.status(400).json({ error: "audio_content_type_required" });
    }
    // Cap at 25MB — OpenAI's hard limit on Whisper file size.
    const MAX_BYTES = 25 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    let abort = false;
    await new Promise((resolve, reject) => {
      req.on("data", (chunk) => {
        if (abort) return;
        total += chunk.length;
        if (total > MAX_BYTES) {
          abort = true;
          reject(new Error("audio_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", resolve);
      req.on("error", reject);
    });
    if (abort) return; // promise rejected
    const buffer = Buffer.concat(chunks, total);
    if (buffer.length < 200) {
      return res.status(400).json({ error: "audio_too_short" });
    }
    const language = req.query.language ? String(req.query.language).slice(0, 5) : null;
    const result = await t.transcribe(buffer, { mime, language });
    res.json({ ok: true, text: result.text, model: result.model });
  } catch (err) {
    console.error("[/api/transcribe] failed:", err.message);
    res.status(500).json({ error: "transcribe_failed", message: err.message });
  }
});

// ====================================================================
// TTS — Phase 5.AH. Voice output for Delta replies.
// GET  /api/tts/status      → { enabled, provider, default_voice }
// POST /api/tts             → audio/mpeg bytes for the given text
// ====================================================================
app.get("/api/tts/status", auth.requireAuth, async (req, res) => {
  try {
    const tts = require("./lib/tts");
    const provider = tts.providerInUse();
    res.json({
      ok: true,
      enabled: tts.isEnabled(),
      provider,
      default_voice: provider === "elevenlabs"
        ? tts.DEFAULT_ELEVENLABS_VOICE
        : tts.DEFAULT_OPENAI_VOICE,
      max_chars: tts.MAX_CHARS,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/tts", auth.requireAuth, async (req, res) => {
  const { text, voice, provider } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "text_required" });
  }
  // Hard size cap before we even invoke the provider — defends against
  // pathological inputs that bypass the chat reply path.
  if (text.length > 20_000) {
    return res.status(413).json({ error: "text_too_long" });
  }
  try {
    const tts = require("./lib/tts");
    if (!tts.isEnabled()) {
      return res.status(503).json({
        error: "tts_not_configured",
        message: "Set OPENAI_API_KEY (cheap, default) or ELEVENLABS_API_KEY (higher quality) to enable TTS.",
      });
    }
    const result = await tts.synthesize(text, { voice, provider });
    res.set("Content-Type", result.mime);
    res.set("Content-Length", String(result.buffer.length));
    res.set("X-TTS-Provider", result.provider);
    res.set("X-TTS-Voice", result.voice);
    res.set("Cache-Control", "no-store"); // each reply text differs
    res.send(result.buffer);
  } catch (err) {
    console.error("[/api/tts] failed:", err.message);
    res.status(500).json({ error: "tts_failed", message: err.message });
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
// Slack integration — Phase 5.BR.
//   GET  /api/slack/status              → { configured, workspace, user_connected, ... }
//   GET  /api/slack/install             → 302 to Slack workspace-install OAuth
//   GET  /api/slack/install-callback    → handles bot install redirect
//   GET  /api/slack/connect             → 302 to per-user OAuth
//   GET  /api/slack/oauth-callback      → handles user connect redirect
//   POST /api/slack/disconnect          → revoke this user's connection
// ====================================================================
app.get("/api/slack/status", auth.requireAuth, async (req, res) => {
  try {
    const slack = require("./lib/slack");
    res.json({ ok: true, ...(await slack.status(req.user.id)) });
  } catch (err) {
    console.error("[/api/slack/status] failed:", err);
    res.status(500).json({ error: "status_failed", message: err.message });
  }
});

app.get("/api/slack/install", auth.requireAuth, async (req, res) => {
  try {
    const slack = require("./lib/slack");
    if (!slack.isConfigured()) {
      return res.status(503).send("Slack not configured on server (need SLACK_CLIENT_ID + SLACK_CLIENT_SECRET).");
    }
    const state = await slack.generateState(req.user.id, "install");
    res.redirect(slack.buildInstallUrl(state));
  } catch (err) {
    console.error("[/api/slack/install] failed:", err);
    res.status(500).send("Slack install start failed: " + err.message);
  }
});

app.get("/api/slack/install-callback", auth.requireAuth, async (req, res) => {
  try {
    const slack = require("./lib/slack");
    const { code, state, error } = req.query;
    if (error) return res.redirect(`/settings?slack=denied&error=${encodeURIComponent(String(error))}`);
    if (!code || !state) return res.redirect("/settings?slack=denied&error=missing_code");
    const session = await slack.consumeState(String(state));
    if (!session || session.flow !== "install") {
      return res.redirect("/settings?slack=denied&error=bad_state");
    }
    const data = await slack.exchangeCode(String(code), slack.REDIRECT_URI_INSTALL);
    const installed = await slack.saveWorkspaceInstall(data, session.userId);
    res.redirect(`/settings?slack=installed&team=${encodeURIComponent(installed.teamName || "")}`);
  } catch (err) {
    console.error("[/api/slack/install-callback] failed:", err);
    res.redirect(`/settings?slack=denied&error=${encodeURIComponent(err.message || "exchange_failed")}`);
  }
});

app.get("/api/slack/connect", auth.requireAuth, async (req, res) => {
  try {
    const slack = require("./lib/slack");
    if (!slack.isConfigured()) {
      return res.status(503).send("Slack not configured on server (need SLACK_CLIENT_ID + SLACK_CLIENT_SECRET).");
    }
    const state = await slack.generateState(req.user.id, "connect");
    res.redirect(slack.buildUserConnectUrl(state));
  } catch (err) {
    console.error("[/api/slack/connect] failed:", err);
    res.status(500).send("Slack connect start failed: " + err.message);
  }
});

app.get("/api/slack/oauth-callback", auth.requireAuth, async (req, res) => {
  try {
    const slack = require("./lib/slack");
    const { code, state, error } = req.query;
    if (error) return res.redirect(`/settings?slack=denied&error=${encodeURIComponent(String(error))}`);
    if (!code || !state) return res.redirect("/settings?slack=denied&error=missing_code");
    const session = await slack.consumeState(String(state));
    if (!session || session.flow !== "connect") {
      return res.redirect("/settings?slack=denied&error=bad_state");
    }
    const data = await slack.exchangeCode(String(code), slack.REDIRECT_URI_USER);
    const conn = await slack.saveUserConnect(data, session.userId);
    res.redirect(`/settings?slack=connected&user=${encodeURIComponent(conn.slackUserName || "")}`);
  } catch (err) {
    console.error("[/api/slack/oauth-callback] failed:", err);
    res.redirect(`/settings?slack=denied&error=${encodeURIComponent(err.message || "exchange_failed")}`);
  }
});

app.post("/api/slack/disconnect", auth.requireAuth, async (req, res) => {
  try {
    const slack = require("./lib/slack");
    await slack.disconnectUser(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[/api/slack/disconnect] failed:", err);
    res.status(500).json({ error: "disconnect_failed", message: err.message });
  }
});

// Admin — kick a sync pass right now (out of cycle). Useful for testing.
app.post("/api/slack/admin/sync-now", auth.requireAuth, async (req, res) => {
  try {
    const slackSync = require("./lib/slackSync");
    const result = await slackSync.syncAll();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[/api/slack/admin/sync-now] failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Stats — how much Slack content do we have in the DB?
app.get("/api/slack/admin/stats", auth.requireAuth, async (req, res) => {
  try {
    const slackSync = require("./lib/slackSync");
    const stats = await slackSync.stats(req.query.team_id || null);
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin/diagnostic — list all currently-connected users + the
// workspace install state. Auth-gated but doesn't expose tokens.
app.get("/api/slack/admin/status", auth.requireAuth, async (req, res) => {
  try {
    const { pool } = require("./lib/db");
    const ws = await pool.query(
      `SELECT team_id, team_name, bot_user_id, installed_at FROM slack_workspaces`,
    );
    const users = await pool.query(
      `SELECT u.email AS ti_email, sut.team_id, sut.slack_user_id, sut.slack_user_name,
              sut.slack_email, sut.connected_at, sut.scope
         FROM slack_user_tokens sut
         JOIN users u ON u.id = sut.user_id
         ORDER BY sut.connected_at DESC`,
    );
    res.json({
      ok: true,
      configured: !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET),
      workspaces: ws.rows,
      connected_users: users.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin bootstrap — manually seed a workspace bot token without going
// through the OAuth install flow. Useful when the bot is already
// installed in Slack and you have the xoxb-... token from the
// "Install to Workspace" step. Validates the token via auth.test +
// pulls team metadata before saving.
app.post("/api/slack/admin/seed-workspace", auth.requireAuth, async (req, res) => {
  try {
    const slack = require("./lib/slack");
    const { botToken } = req.body || {};
    if (!botToken || !String(botToken).startsWith("xoxb-")) {
      return res.status(400).json({ error: "bot_token_required (must start with xoxb-)" });
    }
    const test = await slack.callSlackApi("auth.test", {}, botToken);
    if (!test.ok) return res.status(400).json({ error: "auth.test_failed", detail: test });
    const fakeOauthResponse = {
      access_token: botToken,
      bot_user_id: test.user_id,
      scope: "", // unknown without re-OAuth; will be filled on next install
      team: { id: test.team_id, name: test.team },
    };
    const saved = await slack.saveWorkspaceInstall(fakeOauthResponse, req.user.id);
    res.json({ ok: true, ...saved, team_id: test.team_id, bot_user_id: test.user_id });
  } catch (err) {
    console.error("[/api/slack/admin/seed-workspace] failed:", err);
    res.status(500).json({ error: "seed_failed", message: err.message });
  }
});

// ====================================================================
// Realtime voice mode — Phase 5.BF.
//   GET  /api/voice/realtime-status  → { available, model }
//   POST /api/voice/realtime-session → { ok, value, expires_at, model }
//                                       — ephemeral key for browser WebRTC
//   POST /api/voice/tool-call        → server-side tool execution proxy
//                                       (browser forwards function_call args)
// ====================================================================
app.get("/api/voice/realtime-status", auth.requireAuth, async (req, res) => {
  const realtime = require("./lib/realtime");
  res.json({ ok: true, available: realtime.isConfigured(), model: realtime.REALTIME_MODEL });
});

app.post("/api/voice/realtime-session", auth.requireAuth, async (req, res) => {
  try {
    const realtime = require("./lib/realtime");
    if (!realtime.isConfigured()) {
      return res.status(503).json({ ok: false, error: "OPENAI_API_KEY not configured on server" });
    }
    const voice = (req.body?.voice || "").toString();
    const result = await realtime.mintClientSecret(req.user, {
      voice: voice || undefined,
    });
    if (!result.ok) {
      console.error("[/api/voice/realtime-session] mint failed:", result.error);
      return res.status(502).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error("[/api/voice/realtime-session] failed:", err);
    res.status(500).json({ ok: false, error: err.message || "session_failed" });
  }
});

// Voice → tool-call proxy. The browser hears a function_call event from
// OpenAI, forwards { name, arguments } here, we run the tool with the
// real user context (server has the gmail credentials, not the browser),
// return the JSON result, and the browser sends it back to OpenAI as a
// function_call_output. This keeps all the auth + DB access on the server.
app.post("/api/voice/tool-call", auth.requireAuth, async (req, res) => {
  try {
    const { name, arguments: argsRaw, callId } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    let input;
    try {
      input = typeof argsRaw === "string" ? JSON.parse(argsRaw || "{}") : (argsRaw || {});
    } catch (_) {
      input = {};
    }
    // Phase 5.BK — voice mode can't reliably get the user to dictate a
    // Gmail message_id. If draft_reply / read_attachments / extract is
    // called without one, fall back to whatever email is open in the
    // reader pane right now.
    const openMessageId = req.body?.openMessageId || null;
    if (openMessageId && !input.message_id &&
        ["draft_reply", "read_attachments"].includes(name)) {
      input.message_id = openMessageId;
    }
    const assistantLib = require("./lib/assistant");
    const ctx = await assistantLib.buildContext(req.user, { openMessageId });
    const result = await assistantLib.executeTool(name, input, {
      user: req.user,
      ctx,
      userMessage: "",
      bridgeMode: null,
    });
    res.json({ ok: true, callId, name, result });
  } catch (err) {
    console.error("[/api/voice/tool-call] failed:", err);
    res.status(500).json({ ok: false, error: err.message || "tool_call_failed" });
  }
});

// ====================================================================
// Delta Bridge — peer-to-peer with Finance Delta. Added 2026-05-21.
//
// POST /api/delta-bridge/query
//   Auth:   Bearer DELTA_BRIDGE_TOKEN (or ?token=)
//   Body:   { question: string, requestId: string, fromService: "finance" }
//   Reply:  { ok, reply, tools_used, usage }
//
// The Finance dashboard calls this when it needs to consult Email Delta.
// We invoke our own assistant.chat() with bridgeMode='finance-consultation',
// which tightens the system prompt and strips the consult_finance_delta
// tool so we can't loop back.
//
// SCOPE: enforced by the model via the tightened bridgeMode prompt + by
// the runtime tool-strip. The endpoint itself trusts the token; access
// scoping is the model's job, with the bridge contract documented in
// CLAUDE.md.
// ====================================================================

// In-memory loop guard. requestIds expire after 60s — long enough to
// catch sibling-service retries, short enough not to grow unbounded.
// The Finance side carries primary loop-prevention responsibility; this
// is the safety net.
const recentBridgeIds = new Set();

// Resolve the pilot bridge user (Shahryar) by email at boot. This is
// the user identity the bridge endpoint uses to source context (inbox
// snapshot, memories, etc.). When multi-user lands we'll replace this
// with a per-tenant or per-request mapping.
let BRIDGE_USER_ID = null;
let BRIDGE_USER_EMAIL = "shahryar@transformiran.com";
async function resolveBridgeUserId() {
  try {
    const r = await pool.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [BRIDGE_USER_EMAIL]
    );
    BRIDGE_USER_ID = r.rows[0]?.id ? Number(r.rows[0].id) : null;
    if (BRIDGE_USER_ID) console.log(`[delta-bridge] pilot user id resolved: ${BRIDGE_USER_ID} (${BRIDGE_USER_EMAIL})`);
  } catch (err) {
    console.warn("[delta-bridge] failed to resolve pilot user:", err.message);
  }
}

// POST /api/delta-bridge/notify — symmetric inbound notification path.
// Auth: same Bearer DELTA_BRIDGE_TOKEN. Used when the sibling Delta
// has something to TELL us without expecting a reasoning reply.
// Acknowledges + audit-logs the receipt; future-proofs in case Finance
// Delta starts pushing us alerts too.
app.post("/api/delta-bridge/notify", async (req, res) => {
  const startedAt = Date.now();
  const token = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "")
              || req.query.token;
  if (!process.env.DELTA_BRIDGE_TOKEN || token !== process.env.DELTA_BRIDGE_TOKEN) {
    return res.status(401).json({ ok: false, error: "Invalid bridge token" });
  }
  const { event, requestId, fromService, ...payload } = req.body || {};
  if (!event || typeof event !== "string") {
    return res.status(400).json({ ok: false, error: "event required" });
  }
  if (fromService !== "finance") {
    return res.status(400).json({ ok: false, error: "fromService must be 'finance'" });
  }
  // Loop guard re-used.
  if (recentBridgeIds.has(requestId)) {
    return res.status(409).json({ ok: false, error: "duplicate requestId — loop suspected" });
  }
  recentBridgeIds.add(requestId);
  setTimeout(() => recentBridgeIds.delete(requestId), 60_000);

  // Hash the event payload so the audit log never carries content.
  try {
    const crypto = require("crypto");
    const hash = crypto.createHash("sha256")
      .update(JSON.stringify(payload || {}))
      .digest("hex").slice(0, 16);
    console.log("[delta-bridge]", JSON.stringify({
      ts: new Date().toISOString(),
      bridge: true,
      direction: "in",
      peer: "finance",
      event,
      content_hash: hash,
      took_ms: Date.now() - startedAt,
      request_id: requestId,
      status: 200,
    }));
  } catch (_) {}

  res.json({ ok: true, acknowledged: true });
});

app.post("/api/delta-bridge/query", async (req, res) => {
  const startedAt = Date.now();
  const token = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "")
              || req.query.token;
  if (!process.env.DELTA_BRIDGE_TOKEN || token !== process.env.DELTA_BRIDGE_TOKEN) {
    return res.status(401).json({ ok: false, error: "Invalid bridge token" });
  }
  const { question, requestId, fromService } = req.body || {};
  if (!question || typeof question !== "string" || question.length > 4000) {
    return res.status(400).json({ ok: false, error: "question required (max 4000 chars)" });
  }
  if (fromService !== "finance") {
    return res.status(400).json({ ok: false, error: "fromService must be 'finance'" });
  }
  // Loop guard — refuse if we just answered a call with the same
  // requestId. Basic in-memory dedupe; the finance side is responsible
  // for primary loop prevention.
  if (recentBridgeIds.has(requestId)) {
    return res.status(409).json({ ok: false, error: "duplicate requestId — loop suspected" });
  }
  recentBridgeIds.add(requestId);
  setTimeout(() => recentBridgeIds.delete(requestId), 60_000);

  // Make sure we have a pilot user id by the time the first bridge
  // request arrives.
  if (!BRIDGE_USER_ID) await resolveBridgeUserId();
  if (!BRIDGE_USER_ID) {
    return res.status(503).json({ ok: false, error: "Pilot bridge user not yet provisioned in this service" });
  }

  try {
    // Call our own Delta with the bridge-consultation system prompt
    // active. assistant.chat() tightens scope and strips the
    // consult_finance_delta tool so we can't bounce back.
    const result = await assistant.chat({
      user: { id: BRIDGE_USER_ID, email: BRIDGE_USER_EMAIL },
      history: [],
      userMessage: question,
      bridgeMode: "finance-consultation",
    });
    // Audit-log the incoming call. Hash the question; record only the
    // reply length. Matches the contract on the finance side.
    assistant.logBridgeCall({
      direction: "in",
      peer: "finance",
      question,
      replyLength: (result.reply || "").length,
      tookMs: Date.now() - startedAt,
      requestId,
      status: 200,
    });
    res.json({
      ok: true,
      reply: result.reply,
      tools_used: (result.toolEvents || []).map((t) => t.name),
      usage: result.usage,
    });
  } catch (e) {
    assistant.logBridgeCall({
      direction: "in",
      peer: "finance",
      question,
      replyLength: 0,
      tookMs: Date.now() - startedAt,
      requestId,
      status: 500,
      error: e.message,
    });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====================================================================
// Contacts API — per-user people directory
// ====================================================================
// Phase 5.AP — autocomplete for To/Cc/Bcc + @mention in body.
// Fast typeahead over the contacts table. Frequency-weighted: the
// people you email most appear first when the prefix matches. Empty
// query returns top recents so the dropdown is useful even on focus.
app.get("/api/contacts/suggest", auth.requireAuth, async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8));
  try {
    let rows;
    if (!q) {
      const r = await pool.query(
        `SELECT id, name, email, email_count, last_seen_at, organization, job_title
           FROM contacts
          WHERE user_id = $1
          ORDER BY email_count DESC NULLS LAST, last_seen_at DESC NULLS LAST
          LIMIT $2`,
        [req.user.id, limit]
      );
      rows = r.rows;
    } else {
      // ILIKE both name + email. Score = (starts-with name) > (starts-with email)
      // > (contains either). Tiebreak by email_count.
      const r = await pool.query(
        `SELECT id, name, email, email_count, last_seen_at, organization, job_title,
                CASE
                  WHEN LOWER(name)  LIKE $2 || '%' THEN 100
                  WHEN LOWER(email) LIKE $2 || '%' THEN 80
                  WHEN LOWER(name)  LIKE '%' || $2 || '%' THEN 40
                  WHEN LOWER(email) LIKE '%' || $2 || '%' THEN 20
                  ELSE 0
                END AS score
           FROM contacts
          WHERE user_id = $1
            AND ( LOWER(name)  LIKE '%' || $2 || '%'
               OR LOWER(email) LIKE '%' || $2 || '%' )
          ORDER BY score DESC, email_count DESC NULLS LAST, last_seen_at DESC NULLS LAST
          LIMIT $3`,
        [req.user.id, q, limit]
      );
      rows = r.rows;
    }
    res.json({
      ok: true,
      query: q,
      suggestions: rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        emailCount: r.email_count,
        lastSeenAt: r.last_seen_at,
        organization: r.organization || null,
        jobTitle: r.job_title || null,
      })),
    });
  } catch (err) {
    console.error("[/api/contacts/suggest] failed:", err);
    res.status(500).json({ error: "suggest_failed", message: err.message });
  }
});

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
        const headers = mime.headersToMap(message.payload?.headers || []);
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
          // they click refresh. `force: true` overrides any stuck
          // sync_in_progress flag from a previously hung sync.
          await inboxCache.syncForUser(req.user.id, { force: true });
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
      const headers = mime.headersToMap(m.payload?.headers || []);
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
      const headers = mime.headersToMap(m.payload?.headers || []);
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

// Force-sync the current user's inbox cache RIGHT NOW. Bypasses the
// per-user 90s freshness check and the stuck sync_in_progress flag.
// Wired to a button in the UI so when the inbox feels stale, the user
// can refresh on demand without waiting for the background worker.
app.post("/api/inbox/force-sync", auth.requireAuth, async (req, res) => {
  try {
    const result = await inboxCache.syncForUser(req.user.id, { force: true });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[/api/inbox/force-sync] failed:", err);
    res.status(500).json({ error: "force_sync_failed", message: err.message });
  }
});

// Diagnostic — peek at the current user's cache state. Used by the UI
// to show "last refreshed N seconds ago" and detect stale-sync issues.
app.get("/api/inbox/sync-state", auth.requireAuth, async (req, res) => {
  try {
    const state = await inboxCache.getState(req.user.id);
    const count = await inboxCache.getCountForUser(req.user.id);
    res.json({
      ok: true,
      cached_count: count,
      last_sync_at: state?.last_sync_at || null,
      last_sync_count: state?.last_sync_count || 0,
      last_sync_error: state?.last_sync_error || null,
      sync_in_progress: !!state?.sync_in_progress,
      updated_at: state?.updated_at || null,
    });
  } catch (err) {
    console.error("[/api/inbox/sync-state] failed:", err);
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

    // Phase 5.BO — let the client request inline preview (so PDFs and
    // images open in a new tab via the browser's native viewer instead
    // of triggering a download). Query: ?disposition=inline
    const wantsInline = String(req.query.disposition || "").toLowerCase() === "inline";
    // Only allow inline for safe-to-preview mime types. Everything else
    // forces download to avoid clickjacking / executable surprises.
    const previewable =
      mimeType === "application/pdf" ||
      /^image\//i.test(mimeType) ||
      /^text\/plain/i.test(mimeType);
    const disposition = (wantsInline && previewable) ? "inline" : "attachment";

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`
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
// Phase 5.AL — extract action items + smart reply chips for a single
// message. Lazy + cached by (user_id, message_id). Client fetches this
// in PARALLEL with the body endpoint so the message renders instantly
// and the extractions stream in alongside.
app.get("/api/messages/:id/extract", auth.requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: "bad_id" });
  }
  try {
    const emailExtractions = require("./lib/emailExtractions");
    if (!emailExtractions.isAvailable()) {
      return res.json({ ok: true, action_items: [], smart_replies: [], skipped: "no_anthropic_key" });
    }

    // Try cache first using only the message_id — body-less. If hit,
    // return without ever fetching Gmail.
    // (extractFor handles the cache check internally, but we want to
    // skip Gmail entirely on a cache hit.)
    // We can't compute input_hash without the body, so we just call
    // extractFor with snippet — if the cache has the same hash, fine;
    // if not, the body fetch path runs.
    let message = null;

    // Fast path — read from inbox_cache (no Gmail fetch).
    try {
      const r = await pool.query(
        `SELECT message_id, thread_id, from_header, to_header, cc_header,
                subject, snippet, date_header
           FROM inbox_cache
          WHERE user_id = $1 AND message_id = $2`,
        [req.user.id, id]
      );
      if (r.rows[0]) {
        const row = r.rows[0];
        message = {
          id: row.message_id,
          threadId: row.thread_id,
          from: row.from_header,
          to: row.to_header,
          cc: row.cc_header,
          subject: row.subject,
          snippet: row.snippet,
          bodyText: row.snippet, // body fetched below if needed
          date: row.date_header,
        };
      }
    } catch (_) {}

    // If not cached or we need full body, fetch from Gmail.
    let body = null;
    try {
      const creds = await auth.loadGoogleCreds(req.user.id);
      if (creds) {
        const client = gmail.authedClientFromTokens(creds);
        const g = google.gmail({ version: "v1", auth: client });
        const r = await g.users.messages.get({ userId: "me", id, format: "full" });
        const headers = mime.headersToMap(r.data.payload?.headers || []);
        body = mime.pickBody(r.data.payload);
        message = {
          id: r.data.id,
          threadId: r.data.threadId,
          from: headers.from || message?.from || "",
          to: headers.to || message?.to || "",
          cc: headers.cc || message?.cc || "",
          subject: headers.subject || message?.subject || "",
          snippet: r.data.snippet || message?.snippet || "",
          bodyText: body.text || mime.htmlToText(body.html || "") || message?.snippet || "",
          date: headers.date || message?.date || "",
        };
      }
    } catch (err) {
      console.warn("[/api/messages/:id/extract] body fetch failed:", err.message);
    }

    if (!message) {
      return res.status(404).json({ error: "message_not_found" });
    }

    const result = await emailExtractions.extractFor(req.user, message);
    res.json({
      ok: true,
      action_items: result.action_items || [],
      smart_replies: result.smart_replies || [],
      cached: !!result.cached,
    });
  } catch (err) {
    console.error("[/api/messages/:id/extract] failed:", err);
    res.status(500).json({ error: "extract_failed", message: err.message });
  }
});

// POST /api/messages/:id/extract/dismiss — manually clear cached
// extraction for a message (e.g. user disagrees with what Delta
// suggested and doesn't want to see it again on re-open).
app.post("/api/messages/:id/extract/dismiss", auth.requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: "bad_id" });
  }
  try {
    const emailExtractions = require("./lib/emailExtractions");
    const result = await emailExtractions.invalidate(req.user.id, id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "dismiss_failed", message: err.message });
  }
});

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
      // Phase 5.AO — what Delta researched before drafting. Lets the
      // client show a "Sources" panel so the user can verify the
      // grounding instead of trusting the draft on faith.
      grounding: result.grounding || null,
      // Phase 5.AQ — HTML version of the quoted history (Outlook-style
      // header + parent's original HTML body). Composer renders this
      // in a contenteditable so signatures/colors/logos are visible
      // while the user is drafting.
      quotedHtml: result.quotedHtml || "",
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

    // Fetch the parent message's ORIGINAL HTML body so we can preserve
    // its signature, fonts, logo, and colours in the quoted-history
    // portion of the outgoing HTML. Without this, the parent's
    // signature gets flattened to plain text (just "ILSE VISSER /
    // Bible Translation Manager / T: +31..."), losing the red lines,
    // gold colours, and Transform logo. Pass through to
    // buildMultipartMessage which uses it for the HTML quoted block
    // when present, falls back to plain-text rendering otherwise.
    let parentHtmlSnapshot = null;
    let parentHeaderSnapshot = null;
    if (threadId && !bodyHtml /* compose path handles its own quoting */) {
      try {
        const tRes = await g.users.threads.get({ userId: "me", id: threadId, format: "full" });
        const tMsgs = tRes.data.messages || [];
        // Find the message that matches inReplyTo (RFC822 Message-ID),
        // else fall back to the most recent non-SENT message.
        let parent = null;
        if (inReplyTo) {
          parent = tMsgs.find((m) => {
            const hdrs = mime.headersToMap(m.payload?.headers || []);
            const mid = (hdrs["message-id"] || "").trim();
            return mid && (mid === inReplyTo || mid === `<${inReplyTo}>` || mid === inReplyTo.replace(/[<>]/g, ""));
          });
        }
        if (!parent) {
          const userEmailLower = (req.user.email || "").toLowerCase();
          for (let i = tMsgs.length - 1; i >= 0; i--) {
            const hdrs = mime.headersToMap(tMsgs[i].payload?.headers || []);
            const from = (hdrs.from || "").toLowerCase();
            if (!from.includes(userEmailLower)) { parent = tMsgs[i]; break; }
          }
          if (!parent) parent = tMsgs[tMsgs.length - 1];
        }
        if (parent) {
          const phdrs = mime.headersToMap(parent.payload?.headers || []);
          const pbody = mime.pickBody(parent.payload);
          let safeHtml = mime.sanitizeHtml(pbody.html || "");
          // Resolve inline cid: images → data: URIs so they render in
          // the recipient's view (cid: references would dangle).
          if (safeHtml && pbody.inlineImages?.length) {
            for (const img of pbody.inlineImages) {
              try {
                let bytes = null;
                if (img.inlineData) {
                  bytes = Buffer.from(img.inlineData, "binary");
                } else if (img.attachmentId) {
                  const a = await g.users.messages.attachments.get({
                    userId: "me",
                    messageId: parent.id,
                    id: img.attachmentId,
                  });
                  const b64 = (a.data.data || "").replace(/-/g, "+").replace(/_/g, "/");
                  bytes = Buffer.from(b64, "base64");
                }
                if (!bytes || !img.contentId) continue;
                const dataUri = `data:${img.mimeType};base64,${bytes.toString("base64")}`;
                const cidEscaped = img.contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const re = new RegExp(`cid:${cidEscaped}`, "gi");
                safeHtml = safeHtml.replace(re, dataUri);
              } catch (_) {}
            }
          }
          parentHtmlSnapshot = safeHtml || null;
          parentHeaderSnapshot = {
            from: phdrs.from || "",
            date: phdrs.date || "",
            to: phdrs.to || "",
            cc: phdrs.cc || "",
            subject: phdrs.subject || "",
          };
        }
      } catch (err) {
        console.warn("[/api/gmail/send] parent HTML fetch failed (non-fatal):", err.message);
      }
    }

    const raw = buildMultipartMessage({
      to,
      cc, bcc,
      subject: subject || "(no subject)",
      bodyText: body,
      bodyHtml,
      signatureText: sigText,
      signatureHtml: sigHtml,
      inReplyTo,
      parentHtmlSnapshot,
      parentHeaderSnapshot,
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

    // Phase 5.AK — Commitment extraction. Read the just-sent body
    // and extract any promises the user made into delta_commitments.
    // Fire-and-forget — never blocks the send response.
    setImmediate(() => {
      try {
        const commitments = require("./lib/commitments");
        commitments.extractFromSent(req.user, {
          to,
          subject,
          bodyText: body,
          sentMessageId: sendRes.data.id,
          threadId: sendRes.data.threadId || threadId,
          date: new Date().toISOString(),
        }).catch((err) => {
          console.warn("[/api/gmail/send] commitment extraction failed:", err.message);
        });
      } catch (err) {
        console.warn("[/api/gmail/send] commitment extractor unavailable:", err.message);
      }
    });

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

    // Phase 5.CA — auto-complete tasks that came from this email.
    // When the user added a task linked to a message ("Reply to Russ
    // about Azeri trip"), the moment they actually reply we mark that
    // task done. Matches BOTH the exact message they replied to AND
    // any other message in the same thread (covers the case where
    // they added the task on an older message in the conversation).
    let autoCompletedTasks = [];
    try {
      const ids = new Set();
      if (inReplyTo) ids.add(inReplyTo);
      // Pull thread message ids so a reply auto-closes tasks linked to
      // any prior message in the same conversation.
      const finalThreadId = sendRes.data.threadId || threadId;
      if (finalThreadId) {
        try {
          const t = await g.users.threads.get({
            userId: "me", id: finalThreadId, format: "minimal",
          });
          for (const m of (t.data.messages || [])) {
            if (m.id) ids.add(m.id);
          }
        } catch (_) {}
      }
      if (ids.size) {
        const idList = Array.from(ids);
        const r = await pool.query(
          `UPDATE tasks
              SET completed_at = NOW(),
                  updated_at   = NOW()
            WHERE user_id = $1
              AND completed_at IS NULL
              AND source_message_id = ANY($2::text[])
            RETURNING id, title, list_id`,
          [req.user.id, idList],
        );
        autoCompletedTasks = r.rows;
        if (autoCompletedTasks.length) {
          console.log(`[send] auto-completed ${autoCompletedTasks.length} task(s) for user ${req.user.id} (thread ${finalThreadId})`);
        }
      }
    } catch (err) {
      console.warn("[/api/gmail/send] auto-complete tasks failed:", err.message);
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
      autoCompletedTasks,
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
function buildMultipartMessage({ to, cc, bcc, subject, bodyText, bodyHtml, signatureText, signatureHtml, inReplyTo, parentHtmlSnapshot, parentHeaderSnapshot }) {
  const boundary = "delta_" + Math.random().toString(36).slice(2) + Date.now().toString(36);

  // Final layout (every email client expects this order):
  //
  //   1. New prose (what the user just wrote)
  //   2. Signature  ← preserves original Gmail styling (font, logo, etc.)
  //   3. Quoted history (if reply): "On <date>, <name> wrote:" + > lines
  //
  // The signature MUST sit between prose and quoted history, not after
  // the entire thread. And it MUST render standalone — not nested
  // inside the prose wrapper — so its CSS isn't overridden by the
  // outer Arial-13.5px styling we set on the prose paragraphs.

  let proseHtml = "";
  let proseText = "";
  let quotedHtml = "";
  let quotedText = "";

  if (bodyHtml && String(bodyHtml).trim()) {
    // Rich HTML body from the compose editor — use as-is. No quoted
    // history extraction (compose path doesn't carry one).
    proseHtml = String(bodyHtml);
    proseText = mime.htmlToText(proseHtml);
  } else {
    // Plain-text body (Delta drafts, replies). Detect the Outlook-
    // style quoted-history block draftReply appends:
    //
    //   <blank line>
    //   ________________________________________   ← separator
    //   From: ...
    //   Date: ...
    //   To: ...
    //   Cc: ...    (optional)
    //   Subject: ...
    //   <blank line>
    //   <body — plain text, no "> " prefixes>
    //
    // We split into (new prose) + (header block) + (quoted body) so
    // the HTML can render bold labels above a clean body — matching
    // Outlook's reply format.
    const fullText = String(bodyText || "");
    const sepRegex = /\n_{20,}\n/;
    const sepMatch = fullText.match(sepRegex);
    let headerBlock = "";
    let quotedBodyText = "";
    if (sepMatch) {
      proseText = fullText.slice(0, sepMatch.index);
      const afterSep = fullText.slice(sepMatch.index + sepMatch[0].length);
      // Header block ends at the first blank line after the separator.
      const blankIdx = afterSep.indexOf("\n\n");
      if (blankIdx > 0) {
        headerBlock = afterSep.slice(0, blankIdx);
        quotedBodyText = afterSep.slice(blankIdx + 2);
      } else {
        headerBlock = afterSep;
        quotedBodyText = "";
      }
      // Plain-text variant — preserve the exact same format Outlook
      // generates (separator + header lines + body, no "> " prefixes).
      const sep = "________________________________________";
      quotedText = `\r\n\r\n${sep}\r\n${headerBlock}\r\n\r\n${quotedBodyText}`;
    } else {
      proseText = fullText;
    }

    const escHtml = (s) => String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    proseHtml = escHtml(proseText)
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
      .join("\n");

    if (headerBlock) {
      // Render header lines with bold labels (Outlook-style).
      const headerHtml = headerBlock.split(/\r?\n/).map((line) => {
        const m = line.match(/^([A-Za-z][A-Za-z-]*?):\s*(.*)$/);
        if (m) {
          return `<b>${escHtml(m[1])}:</b> ${escHtml(m[2])}`;
        }
        return escHtml(line);
      }).join("<br>");

      // Body rendering: prefer the ORIGINAL HTML snapshot of the parent
      // message (with its signature, fonts, colours, logo intact) over
      // the plain-text-derived HTML. The plain-text version flattens
      // signatures into anaemic monospace prose; the HTML snapshot
      // preserves every span, image, hr, and inline-style the original
      // author set.
      let bodyForQuoted;
      if (parentHtmlSnapshot) {
        bodyForQuoted = parentHtmlSnapshot;
      } else {
        bodyForQuoted = escHtml(quotedBodyText)
          .split(/\n{2,}/)
          .map((p) => `<p style="margin:0 0 12px 0">${p.replace(/\n/g, "<br>")}</p>`)
          .join("\n");
      }

      // Outlook-style header block: light-blue horizontal rule above
      // bold From / Date / To / Cc / Subject lines, then the body
      // verbatim. When parentHtmlSnapshot is available the body
      // section already carries its own font-family / colour from the
      // original email — no outer wrapper that could override it.
      quotedHtml =
        `<div>` +
          `<div style="border-top:solid #B5C4DF 1.0pt;padding:3.0pt 0in 0in 0in;margin-top:16px">` +
            `<p style="margin:0 0 12px 0;font-family:Calibri,Aptos,sans-serif;font-size:11.0pt">${headerHtml}</p>` +
          `</div>` +
          // Wrapper around the parent body. No font-family forced here
          // — the parent's own inline CSS wins. Only colour + default
          // font fallback for the case where parent had no inline
          // styles at all.
          `<div style="color:#000">${bodyForQuoted}</div>` +
        `</div>`;
    }
  }

  // ---- Plain-text part: prose + signature + quoted ----
  // Standard separator: "\n-- \n" between prose and signature (the
  // dash-dash-space-newline is the RFC 3676 signature delimiter many
  // mail clients respect).
  const textPart = [
    proseText,
    signatureText ? `\r\n\r\n-- \r\n${signatureText}` : "",
    quotedText,
  ].join("");

  // ---- HTML part: prose wrapper + signature standalone + quoted ----
  // CRITICAL: signature is OUTSIDE the prose wrapper so its own
  // font-family, font-size, image dimensions, HR styling, and
  // colour scheme are preserved. The prose wrapper only controls
  // styling of the user's typed reply.
  // Phase 5.BD — dir="auto" + unicode-bidi:plaintext so recipients'
  // mail clients render each paragraph in the right direction
  // (English signatures stay LTR, Farsi/Arabic body flips to RTL).
  const htmlPart =
    `<div dir="auto" style="font-family:Arial,sans-serif;font-size:13.5px;line-height:1.5;color:#222;unicode-bidi:plaintext">` +
      proseHtml +
    `</div>` +
    (signatureHtml
      ? `<br><div class="gmail_signature" data-smartmail="gmail_signature" dir="auto">${signatureHtml}</div>`
      : "") +
    quotedHtml;

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
// Delta chat — POST /api/assistant/stream  (Phase 5.AU)
// Server-sent-events variant of /api/assistant. Emits live progress
// updates as Delta thinks + calls tools so the chat panel's loading
// indicator can show "Delta is searching…" / "Delta is drafting…"
// / etc. in real time instead of always "thinking…".
//
// Events:
//   event: progress  data: { type: "thinking" }
//   event: progress  data: { type: "tool_start", tool: "search_inbox" }
//   event: progress  data: { type: "tool_end",   tool: "search_inbox", ok: true }
//   event: done      data: { reply, toolEvents, usage, ... }
//   event: error     data: { error }
// ====================================================================
app.post("/api/assistant/stream", auth.requireAuth, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // tell proxies not to buffer
  res.flushHeaders?.();

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (_) {}
  };

  const { message, history, openMessageId, model } = req.body || {};
  if (!message || typeof message !== "string") {
    send("error", { error: "empty_message" });
    res.end();
    return;
  }

  try {
    const result = await assistant.chat({
      user: req.user,
      history: Array.isArray(history) ? history : [],
      userMessage: message,
      openMessageId,
      model,
      onProgress: (ev) => send("progress", ev),
    });
    send("done", {
      reply: result.reply,
      toolEvents: result.toolEvents,
      usage: result.usage,
      model: result.model,
      stopReason: result.stopReason,
      hops: result.hops,
    });
  } catch (err) {
    console.error("[/api/assistant/stream] failed:", err);
    send("error", { error: err.message || "chat_failed" });
  } finally {
    res.end();
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
  .then(async () => {
    console.log("[boot] db ready");
    startBackfillWorker();
    // Recover from any stuck sync_in_progress flags left behind by a
    // previously crashed/hung worker before the cache loop starts up.
    try { await inboxCache.clearStuckSyncFlags({ olderThanMs: 60_000 }); } catch (_) {}
    // Catch-up: mirror any inbox_cache rows that exist but aren't yet
    // in gmail_messages_indexed. Without this, today's emails are
    // invisible to search_inbox (and thus to Finance Delta queries).
    try { await inboxCache.reindexMissingForAllUsers(); } catch (err) {
      console.warn("[boot] reindexMissingForAllUsers failed (non-fatal):", err.message);
    }
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
    startSlackSyncWorker();
    // Resolve pilot bridge user id at boot (logs a warning if missing).
    resolveBridgeUserId().catch(() => {});
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
  let runningSince = 0;
  let cycleCount = 0;
  // If a cycle is still "running" after 3 minutes, something hung and
  // the worker has been silently skipping ever since. Force-reclaim it.
  const STUCK_GRACE_MS = 3 * 60 * 1000;
  const cycle = async () => {
    if (running) {
      const stuckFor = Date.now() - runningSince;
      if (stuckFor > STUCK_GRACE_MS) {
        console.warn(`[inbox-cache-worker] previous cycle stuck for ${Math.round(stuckFor/1000)}s — force-reclaiming`);
        running = false;
      } else {
        return;
      }
    }
    running = true;
    runningSince = Date.now();
    cycleCount++;
    // Heartbeat log every 10 cycles (~5 min) so we can see the worker
    // is alive without flooding logs every 30s.
    if (cycleCount % 10 === 1) {
      console.log(`[inbox-cache-worker] heartbeat cycle=${cycleCount}`);
    }
    try {
      const due = await inboxCache.listUsersDueForSync({ stalerThanMs: 90_000, limit: 3 });
      if (due.length) {
        console.log(`[inbox-cache-worker] cycle ${cycleCount}: ${due.length} user(s) due`);
      }
      await Promise.all(
        due.map((row) =>
          inboxCache.syncForUser(row.user_id).then((res) => {
            if (res && res.count !== undefined) {
              console.log(`[inbox-cache-worker] user ${row.user_id}: synced ${res.count} messages`);
            } else if (res && res.error) {
              console.warn(`[inbox-cache-worker] user ${row.user_id}: sync error: ${res.error}`);
            }
          }).catch((err) => {
            console.warn(`[inbox-cache-worker] user ${row.user_id} sync threw:`, err.message);
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
  console.log("[boot] inbox cache worker scheduled (cycle 30s, per-user 90s freshness, 12s gmail timeout, 3min stuck-grace)");
}

// ====================================================================
// SLACK SYNC WORKER — Phase 5.BS. Hourly pass over every workspace +
// every TI user with a connected Slack. Each run pulls only NEW messages
// since the last cursor. First run for a fresh install pulls a 90-day
// backfill, then incremental from there.
// ====================================================================
function startSlackSyncWorker() {
  let running = false;
  const cycle = async () => {
    if (running) return;
    try {
      const slack = require("./lib/slack");
      if (!slack.isConfigured()) return;
    } catch (_) { return; }
    running = true;
    try {
      const slackSync = require("./lib/slackSync");
      await slackSync.syncAll();
    } catch (err) {
      console.warn("[slack-sync] cycle failed:", err.message);
    } finally {
      running = false;
    }
  };
  // First run 60s after boot, then hourly. Manual /api/slack/admin/sync-now
  // kicks an out-of-cycle run for testing.
  setTimeout(cycle, 60_000);
  setInterval(cycle, 60 * 60 * 1000);
  console.log("[boot] slack sync worker scheduled (cycle 60min, first run T+60s)");
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
