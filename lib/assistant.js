// Delta — the email-side executive-assistant brain.
// HARD ARCHITECTURAL RULE: this Delta is 100% separate from the finance
// dashboard's Delta. Different system prompt, different tools, different
// memory. Same name + logo only. See ~/.../memory/project_org_email_ai_vision.md.

const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");
const { authedClientFromTokens } = require("./gmail");
const { loadGoogleCreds } = require("./auth");

// Models — use Sonnet for speed/cost in chat, Opus for heavy reasoning later.
const CHAT_MODEL = process.env.DELTA_CHAT_MODEL || "claude-sonnet-4-5-20251022";
const MAX_TOKENS = 1024;

let _anthropic = null;
function client() {
  if (!_anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// ===========================================================================
// SYSTEM PROMPT
// ===========================================================================

const ORG_CONTEXT = `
ORGANIZATION
You serve Transform Iran (formerly 222 Ministries) — an evangelical Christian
ministry founded 1991 by Lazarus and Maggie Yeghnazar. Mission: preach the
gospel to Iranians, plant churches, disciple believers, develop leaders,
transform Iran. The org runs 222 Churches (~100 across 17 nations), Kairos
(AI discipleship tool), Pearl of Persia, Meeting Tent, and 12+ other programs.
100k+ converts since founding. Three legal entities: Transform Iran UK (charity
1171159), Transform Iran Inc. (US 501c3), Stichting 222 Ministry (NL).

KEY PEOPLE (recognize when names appear in mail)
- Lana Silk — President & CEO (daughter of founders; uses married name)
- Shahryar Tooraji — Chief Operating Officer (the typical Delta Mail user)
- Lazarus Yeghnazar — General Overseer, 222 Churches (co-founder)
- Maggie Yeghnazar — Theology & Curriculum Director (co-founder)
- Barmak — Overseer, 222 Churches Europe
- Pia Fanbele — Shahryar's Executive Assistant
- Remco — NL finance contact (Stichting 222 Ministry)
- Simon — UK finance contact

LANGUAGES
The org operates in four languages: Farsi, Armenian, English, Dutch.
Recognize all four in incoming mail. If a user writes to you in one of
those languages, reply in the same language unless they say otherwise.

PROGRAMS / KEYWORDS to recognize
Kairos, 222 Churches, Pearl of Persia, Meeting Tent, Persian Community
Church (PCC), Operation Christmas Joy, Bible translation, leadership
retreats, Helping the Hurting, Apologetics Center.
`.trim();

const IDENTITY = `
You are **Delta**, the executive-assistant AI inside Delta Mail — a custom
email tool for Transform Iran staff. You are NOT a generic chatbot. You exist
to help one specific person manage their inbox: read it, prioritize it, draft
replies in their voice, summarize threads, translate between Farsi / Armenian
/ English / Dutch, surface what's being asked of them, and never let
important messages fall through the cracks.

You also have a sibling Delta in the Transform Iran financial dashboard. That
Delta handles finance analysis (Xero / Exact / GL accounts). You do not. If
the user asks finance questions, redirect: "That's a question for the finance
Delta in the dashboard at transformiran.info."

VOICE
- Warm but precise. Like a great human EA who's been with them for years.
- Use the user's name occasionally, never excessively.
- Short and direct in chat — long-form only when summarizing many threads.
- Never pad with corporate filler ("I'd be happy to..."). Just do the thing.

CAPABILITIES TODAY (Phase 2a)
- Read the user's most recent 30 inbox messages (metadata: sender, subject,
  snippet, date, unread status). The full message body is NOT yet available
  to you — say so if asked to quote verbatim.
- Answer questions about who's emailed, what's urgent, what's been ignored,
  who hasn't been replied to.
- Suggest replies in plain text — but you cannot actually send them yet.
  The user copy/pastes drafts into Gmail manually for now.

NOT YET AVAILABLE (don't promise these)
- Full email body reading
- Actual sending or drafting into Gmail
- 3-4 year historical context / contact profiles
- Calendar integration
- Slack
If asked about these, say "coming in a future phase."

NEVER
- Never send an email on the user's behalf.
- Never invent message content you weren't shown.
- Never claim to know things from outside the inbox snapshot.
- Never roleplay as a different assistant.
`.trim();

function buildSystemPrompt({ user, inboxSnapshot, openMessage }) {
  const userBlock = `
CURRENT USER
- Name: ${user.display_name || user.email}
- Email: ${user.email}
- Role at Transform Iran: ${user.email === "shahryar@transformiran.com" ? "Chief Operating Officer" : "Staff"}
- Preferred reply language: English (default; switch if they write to you in another)
`.trim();

  const inboxBlock = inboxSnapshot && inboxSnapshot.length
    ? `
INBOX SNAPSHOT (most recent ${inboxSnapshot.length} messages, newest first)
${inboxSnapshot.map((m, i) => formatMsgForPrompt(m, i + 1)).join("\n")}
`.trim()
    : "INBOX SNAPSHOT\n(inbox empty or not yet loaded)";

  const openBlock = openMessage
    ? `
CURRENTLY OPEN EMAIL (the user is reading this right now)
From: ${openMessage.from}
Subject: ${openMessage.subject}
Date: ${openMessage.date}
Snippet: ${openMessage.snippet}
`.trim()
    : "";

  return [IDENTITY, ORG_CONTEXT, userBlock, inboxBlock, openBlock]
    .filter(Boolean)
    .join("\n\n────────────────────────────────────\n\n");
}

function formatMsgForPrompt(m, idx) {
  const unread = m.unread ? " [UNREAD]" : "";
  return `${idx}. ${m.date ? "(" + m.date + ") " : ""}${m.from}${unread}
   subject: ${m.subject}
   snippet: ${(m.snippet || "").slice(0, 220)}`;
}

// ===========================================================================
// CONTEXT BUILDING — fetch the user's recent inbox to give Delta situational
// awareness. Cached for ~60s per user so chat follow-ups are instant.
// ===========================================================================

const _inboxCache = new Map(); // userId → { fetchedAt, messages }

async function buildContext(user, { openMessageId } = {}) {
  let messages = [];
  const cached = _inboxCache.get(user.id);
  if (cached && Date.now() - cached.fetchedAt < 60_000) {
    messages = cached.messages;
  } else {
    try {
      const creds = await loadGoogleCreds(user.id);
      if (!creds) throw new Error("no_google_creds");
      const oauthClient = authedClientFromTokens(creds);
      const g = google.gmail({ version: "v1", auth: oauthClient });
      const list = await g.users.messages.list({
        userId: "me",
        maxResults: 30,
        labelIds: ["INBOX"],
      });
      const ids = (list.data.messages || []).map((m) => m.id);
      const fetches = ids.map((id) =>
        g.users.messages
          .get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          })
          .then((r) => r.data)
          .catch(() => null)
      );
      const detailed = (await Promise.all(fetches)).filter(Boolean);
      messages = detailed.map((m) => {
        const headers = Object.fromEntries(
          (m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
        );
        return {
          id: m.id,
          threadId: m.threadId,
          snippet: m.snippet || "",
          from: headers.from || "",
          subject: headers.subject || "(no subject)",
          date: headers.date || "",
          internalDate: m.internalDate,
          unread: (m.labelIds || []).includes("UNREAD"),
        };
      });
      _inboxCache.set(user.id, { fetchedAt: Date.now(), messages });
    } catch (err) {
      console.warn("[assistant] inbox fetch failed:", err.message);
      messages = [];
    }
  }

  const openMessage = openMessageId
    ? messages.find((m) => m.id === openMessageId) || null
    : null;

  return { inboxSnapshot: messages, openMessage };
}

// ===========================================================================
// CHAT — single-turn (server statelessly carries the conversation in `history`)
// ===========================================================================

async function chat({ user, history = [], userMessage, openMessageId }) {
  const ctx = await buildContext(user, { openMessageId });
  const system = buildSystemPrompt({
    user,
    inboxSnapshot: ctx.inboxSnapshot,
    openMessage: ctx.openMessage,
  });

  // Map the lightweight {role, content} history into Anthropic format.
  const messages = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content),
    }));

  messages.push({ role: "user", content: userMessage });

  const r = await client().messages.create({
    model: CHAT_MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages,
  });

  const reply = (r.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return {
    reply,
    usage: r.usage,
    model: r.model,
    stopReason: r.stop_reason,
  };
}

module.exports = { chat, buildContext, buildSystemPrompt, CHAT_MODEL };
