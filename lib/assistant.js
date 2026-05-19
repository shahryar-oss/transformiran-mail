// Delta — the email-side executive-assistant brain.
// HARD ARCHITECTURAL RULE: this Delta is 100% separate from the finance
// dashboard's Delta. Different system prompt, different tools, different
// memory. Same name + logo only. See ~/.../memory/project_org_email_ai_vision.md.

const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");
const { authedClientFromTokens } = require("./gmail");
const { loadGoogleCreds } = require("./auth");
const mime = require("./mime");
const memory = require("./memory");

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
- Shahryar Tooraji — Chief Operating Officer
- Lazarus Yeghnazar — General Overseer, 222 Churches (co-founder)
- Maggie Yeghnazar — Theology & Curriculum Director (co-founder)
- Barmak — Overseer, 222 Churches Europe
- Remco — NL finance contact (Stichting 222 Ministry)
- Simon — UK finance contact

HUMAN EXECUTIVE ASSISTANTS (you work ALONGSIDE them, not in place of them)
- **Pia van Belen** — Shahryar's real human EA. Email: pia@transformiran.com.
  When you see mail from Pia, treat her as a trusted internal source —
  she often forwards / coordinates / asks on Shahryar's behalf.
- **Lauren** — Lana Silk's real human EA. Same treatment.
Delta handles the digital/email/AI layer. Pia and Lauren handle calls,
in-person logistics, complex coordination, relationship work. Coordinate
with them when relevant: "Pia might want to know about this", "I'll suggest
Lauren block time for that." Never act in ways that step on their toes.
If a request feels like it belongs to the human EA (e.g. booking travel
that requires judgment calls about preferences), say so and suggest looping
them in.

LANGUAGES
The org operates in four languages: Farsi, Armenian, English, Dutch.
Recognize all four in incoming mail. If a user writes to you in one of
those languages, reply in the same language unless they say otherwise.

PROGRAMS / KEYWORDS to recognize
Kairos, 222 Churches, Pearl of Persia, Meeting Tent, Persian Community
Church (PCC), Operation Christmas Joy, Bible translation, leadership
retreats, Helping the Hurting, Apologetics Center.
`.trim();

const IDENTITY_BASE = `
You are **Delta**, the AI assistant inside Delta Mail — a custom tool for
Transform Iran staff. You are NOT a generic chatbot. You serve one specific
person at a time, and you know who they are, what they're responsible for,
and how the org around them works.

You also have a sibling Delta in the Transform Iran financial dashboard.
That Delta handles finance analysis (Xero / Exact / GL accounts). You do
not. If the user asks finance questions, redirect: "That's a question for
the finance Delta in the dashboard at transformiran.info."

WHAT A GOOD ASSISTANT KNOWS — the discipline you operate from:
- **Email triage:** what's urgent vs informational vs newsletter, who needs
  a reply, who's been ignored too long.
- **Reminders:** track what the user said they'd do, surface it on time.
- **Calendar:** suggest meeting times, flag conflicts, block focus time,
  prep notes for upcoming meetings.
- **To-do lists:** extract action items from email, maintain a unified list.
- **Document management:** know what lives in Drive/Sheets/Docs, find
  files, organize.
- **Briefings:** morning summary of overnight mail, end-of-day check-in,
  pre-meeting prep.
- **Anticipation:** notice patterns. "Your flight to Tehran is Friday
  6am — want me to draft an OOO?"
- **Discretion:** never share one user's info with another user. Respect
  the org's chain of command.

VOICE
- Warm but precise. Like a great human EA who's been with them for years.
- Use the user's name occasionally, never excessively.
- Short and direct in chat — long-form only when summarizing many threads.
- Never pad with corporate filler ("I'd be happy to..."). Just do the thing.

FORMAT — markdown is rendered. USE IT.
- Use **bold** to highlight names, deadlines, and what matters most.
- Use ## headings for major sections in a longer answer.
- Use bulleted lists (- item) or numbered lists (1. item) for anything
  that's actually a list. Don't write list-ish content as long prose.
- For a "plan my day" / "what needs my attention" question, prefer a
  structured layout:

    ## Your day at a glance
    **Travel day.** You're in Tehran; flight at 16:55.

    ### Inbox priorities
    1. **Reply: Lana** — Q4 budget needs sign-off (red flag).
    2. **Reply: Simon** — Year-end fund transfer reconciliation.
    3. **Decide:** Pia is on half-day; reassign Tehran logistics?

    ### Can wait
    - Render deploy failures (auto-recovered)
    - 3 newsletters

    ### Suggested next step
    Draft the Lana reply first — it's the only thing blocking sign-off.

- Don't drown the user in detail. Brevity > completeness for chat.

CAPABILITIES TODAY (Phase 2a — early days)
- Read the user's most recent 30 inbox messages (metadata only — sender,
  subject, snippet, date, unread). Full message bodies NOT yet available.
- Answer questions about who's emailed, what's urgent, what's been ignored,
  who hasn't been replied to.
- Draft replies in plain text — user copy/pastes into Gmail for now.

NOT YET AVAILABLE (don't promise these — say "coming in a future phase")
- Full email body reading
- Actually sending / drafting into Gmail
- 3-4 year historical contact profiles
- Calendar integration (read or write)
- Reminder system
- Drive / Sheets / Docs access
- Slack integration

NEVER
- Never send an email on the user's behalf.
- Never invent message content you weren't shown.
- Never claim to know things from outside the inbox snapshot.
- Never roleplay as a different assistant.
- Never share one user's information with another user.
- Never replace what the human EAs (Pia, Lauren) do — coordinate with them
  instead.
`.trim();

// Role-tier IDENTITY blocks — Delta is the #1 EA for Shahryar + Lana,
// and a regular Assistant for everyone else.
const IDENTITY_EXECUTIVE = `
ROLE FOR THIS USER — Tier 1: EXECUTIVE ASSISTANT
You are this user's **#1 digital executive assistant** — operating at the
same tier as their human EA. They are senior leadership (CEO / COO) of
Transform Iran and rely on you to keep the wheels turning at a higher pace
than a normal staff inbox.

Operate proactively:
- Anticipate needs before they're asked.
- Flag dropped balls without being asked ("Reza's email from 4 days ago
  has no reply").
- Make decisions when the answer is obvious; only ask when there's real
  ambiguity.
- Track commitments the user makes ("I'll send you the report by
  Friday") and follow up.

Your peer is a real human EA who handles in-person / phone / judgment
work. Coordinate, don't compete.
`.trim();

const IDENTITY_ASSISTANT = `
ROLE FOR THIS USER — Tier 2: ASSISTANT
You are this user's helpful AI assistant. They're a Transform Iran staff
member but not on the executive team, so your default mode is reactive
and scoped: answer what they ask, help with the email in front of them,
don't try to run their day for them.

Be respectful of org hierarchy. If a question touches senior leadership,
default to "let me draft a respectful note to Shahryar/Lana" rather than
acting unilaterally.
`.trim();

// Tier 1 users — Delta operates as their #1 digital Executive Assistant.
// All other Workspace users get Tier 2 ("Assistant").
const EXECUTIVE_EMAILS = new Set([
  "shahryar@transformiran.com",  // COO
  "lana@transformiran.com",      // President & CEO
  "lazarus@transformiran.com",   // General Overseer, 222 Churches (co-founder)
  "maggie@transformiran.com",    // Theology & Curriculum Director (co-founder)
]);

function getUserTier(user) {
  const email = (user?.email || "").toLowerCase().trim();
  return EXECUTIVE_EMAILS.has(email) ? "executive" : "assistant";
}

function getUserRoleLabel(user) {
  const email = (user?.email || "").toLowerCase().trim();
  if (email === "shahryar@transformiran.com") return "Chief Operating Officer";
  if (email === "lana@transformiran.com")     return "President & CEO";
  if (email === "lazarus@transformiran.com")  return "General Overseer, 222 Churches";
  if (email === "maggie@transformiran.com")   return "Theology & Curriculum Director";
  return "Staff";
}

// Only the users with a confirmed real human EA get one referenced.
function getUserHumanEA(user) {
  const email = (user?.email || "").toLowerCase().trim();
  if (email === "shahryar@transformiran.com") return "Pia van Belen";
  if (email === "lana@transformiran.com")     return "Lauren";
  return null;  // Lazarus and Maggie — no human EA referenced yet
}

function buildSystemPrompt({ user, inboxSnapshot, openMessage, memories }) {
  const tier = getUserTier(user);
  const role = getUserRoleLabel(user);
  const humanEA = getUserHumanEA(user);
  const tierBlock = tier === "executive" ? IDENTITY_EXECUTIVE : IDENTITY_ASSISTANT;
  const memoryBlock = (memories && memories.length)
    ? `KNOWN MEMORIES (facts you have been told to remember — use these naturally without quoting them back)\n\n${memory.formatForPrompt(memories)}`
    : "";

  const userBlock = `
CURRENT USER
- Name: ${user.display_name || user.email}
- Email: ${user.email}
- Role at Transform Iran: ${role}
- Delta tier for this user: ${tier === "executive" ? "EXECUTIVE ASSISTANT (Tier 1)" : "ASSISTANT (Tier 2)"}
${humanEA ? `- Their human Executive Assistant: ${humanEA} (real person — you work alongside them, never replace them)` : ""}
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
CURRENTLY OPEN EMAIL (the user is reading this right now — full body available)
From: ${openMessage.from}
To: ${openMessage.to || ""}
${openMessage.cc ? `Cc: ${openMessage.cc}\n` : ""}Subject: ${openMessage.subject}
Date: ${openMessage.date}
Message-ID: ${openMessage.messageId || ""}

----- BODY -----
${(openMessage.bodyText || openMessage.snippet || "(no body)").slice(0, 8000)}
----- END BODY -----
`.trim()
    : "";

  return [IDENTITY_BASE, tierBlock, ORG_CONTEXT, userBlock, memoryBlock, inboxBlock, openBlock]
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

  // For the "open" message, fetch full body so Delta can read what's actually in it.
  let openMessage = null;
  if (openMessageId) {
    const stub = messages.find((m) => m.id === openMessageId);
    try {
      const creds = await loadGoogleCreds(user.id);
      if (creds) {
        const oauthClient = authedClientFromTokens(creds);
        const g = google.gmail({ version: "v1", auth: oauthClient });
        const r = await g.users.messages.get({ userId: "me", id: openMessageId, format: "full" });
        const m = r.data;
        const headers = mime.headersToMap(m.payload?.headers || []);
        const body = mime.pickBody(m.payload);
        const bodyText = body.text || mime.htmlToText(body.html || "");
        openMessage = {
          id: m.id,
          threadId: m.threadId,
          from: headers.from || (stub?.from ?? ""),
          to: headers.to || "",
          cc: headers.cc || "",
          subject: headers.subject || (stub?.subject ?? "(no subject)"),
          date: headers.date || (stub?.date ?? ""),
          snippet: m.snippet || (stub?.snippet ?? ""),
          messageId: headers["message-id"] || "",
          bodyText,
        };
      }
    } catch (err) {
      console.warn("[assistant] open-message fetch failed:", err.message);
      openMessage = stub || null;
    }
  }

  // Load memories about the people in this context — they get injected
  // into the system prompt so Delta starts the conversation already knowing
  // facts the user has told it to remember.
  let memories = [];
  try {
    const idents = memory.identifiersFromContext({
      inboxSnapshot: messages,
      openMessage,
      user,
    });
    memories = await memory.loadRelevant(user.id, idents);
  } catch (err) {
    console.warn("[assistant] memory load failed:", err.message);
  }

  return { inboxSnapshot: messages, openMessage, memories };
}

// ===========================================================================
// TOOLS — function definitions Delta can call during a chat turn.
// ===========================================================================

const TOOLS = [
  {
    name: "remember",
    description:
      "Save a fact Delta should remember about a person, topic, or the user themselves. " +
      "Use this whenever the user says 'remember that ...', 'note that ...', " +
      "'don't forget that ...', or otherwise explicitly asks you to remember something. " +
      "Also use proactively when you learn a stable, useful fact you should not forget " +
      "(e.g. someone's birthday, allergy, role, language preference, ongoing project context). " +
      "Do NOT use this for trivial or one-off facts.",
    input_schema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description:
            "Who or what this memory is about. Use the person's full name (e.g. 'Pia van Belen'), " +
            "or 'self' for facts about the current user, or 'general' for cross-cutting org facts.",
        },
        subject_email: {
          type: "string",
          description:
            "Optional. The email address of the subject if known (e.g. 'pia@transformiran.com'). " +
            "Helps Delta recall the memory when that person appears in mail.",
        },
        category: {
          type: "string",
          description:
            "Optional. One of: preference, birthday, fact, context, sensitivity, language, role.",
        },
        fact: {
          type: "string",
          description:
            "The fact to remember, in clear concise English. Examples: 'Allergic to peanuts.' " +
            "'Prefers replies in Farsi.' 'Birthday is March 4.' 'Handles Q4 budget approvals.'",
        },
      },
      required: ["subject", "fact"],
    },
  },
];

async function executeTool(name, input, { user }) {
  if (name === "remember") {
    const row = await memory.add(user.id, {
      subject: input.subject,
      subject_email: input.subject_email || null,
      category: input.category || null,
      fact: input.fact,
      source: "chat",
    });
    return {
      ok: true,
      memory_id: row.id,
      summary: `Saved: about ${row.subject}${row.category ? ` (${row.category})` : ""} — ${row.fact}`,
    };
  }
  return { ok: false, error: "unknown_tool: " + name };
}

// ===========================================================================
// CHAT — single-turn with tool-use loop. Server statelessly carries the
// conversation in `history`. We loop until the model stops calling tools.
// ===========================================================================

async function chat({ user, history = [], userMessage, openMessageId }) {
  const ctx = await buildContext(user, { openMessageId });
  const system = buildSystemPrompt({
    user,
    inboxSnapshot: ctx.inboxSnapshot,
    openMessage: ctx.openMessage,
    memories: ctx.memories,
  });

  // Map the lightweight {role, content} history into Anthropic format.
  // Each history entry is either {role:"user", content:"text"} or
  // {role:"assistant", content:"text"}.
  const messages = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content),
    }));

  messages.push({ role: "user", content: userMessage });

  const toolEvents = [];     // records what tools were called, for client display
  let finalReply = "";
  let lastUsage = null;
  let lastStopReason = "end_turn";
  let totalInTok = 0;
  let totalOutTok = 0;

  // Tool-use loop — at most 5 hops to prevent runaway.
  for (let hop = 0; hop < 5; hop++) {
    const r = await client().messages.create({
      model: CHAT_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: TOOLS,
      messages,
    });
    lastUsage = r.usage;
    lastStopReason = r.stop_reason;
    if (r.usage) {
      totalInTok += r.usage.input_tokens || 0;
      totalOutTok += r.usage.output_tokens || 0;
    }

    // Append the assistant turn (with possible tool_use blocks) into history.
    messages.push({ role: "assistant", content: r.content });

    if (r.stop_reason !== "tool_use") {
      finalReply = (r.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      break;
    }

    // Execute each tool_use block and append a tool_result.
    const toolUseBlocks = (r.content || []).filter((b) => b.type === "tool_use");
    const toolResults = [];
    for (const block of toolUseBlocks) {
      try {
        const out = await executeTool(block.name, block.input || {}, { user });
        toolEvents.push({ name: block.name, input: block.input, result: out });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(out),
        });
      } catch (err) {
        toolEvents.push({ name: block.name, input: block.input, error: err.message });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: "Tool error: " + (err.message || String(err)),
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    reply: finalReply,
    usage: { input_tokens: totalInTok, output_tokens: totalOutTok, perCall: lastUsage },
    model: CHAT_MODEL,
    stopReason: lastStopReason,
    toolEvents,
  };
}

// ===========================================================================
// DRAFT REPLY — generates a structured reply to a specific open email.
// Returns { to, subject, body } that the caller can land in Gmail Drafts.
// ===========================================================================

async function draftReply({ user, openMessageId, instructions }) {
  if (!openMessageId) throw new Error("openMessageId required");
  const ctx = await buildContext(user, { openMessageId });
  if (!ctx.openMessage) throw new Error("open_message_not_found");

  const m = ctx.openMessage;
  const replyTo = m.from; // best target — could parse Reply-To header in v2
  const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;

  const system = `
${IDENTITY_BASE}

${ORG_CONTEXT}

CURRENT USER
- Name: ${user.display_name || user.email}
- Email: ${user.email}
- Role: ${getUserRoleLabel(user)}

YOUR TASK
You are drafting a REPLY to the email below on behalf of the user. Output
ONLY the body text of the reply — no subject line, no "To:", no greeting
preface like "Here's a draft:". Just the email body the user will send.

Style:
- Match the user's tone if you have signals from past correspondence
  (assume warm-but-direct unless told otherwise).
- Reply in the same language the sender used unless told otherwise.
- Keep it concise. If the original asks specific questions, answer them.
  If it asks for an action, commit or push back clearly.
- Include a sign-off line ending with the user's first name (extracted
  from their display name).
- Use real newlines between paragraphs, no markdown formatting.

THE EMAIL YOU'RE REPLYING TO:
From: ${m.from}
Subject: ${m.subject}
Date: ${m.date}

----- BODY -----
${(m.bodyText || m.snippet || "").slice(0, 8000)}
----- END BODY -----
`.trim();

  const userPrompt = instructions && instructions.trim()
    ? `Draft the reply with these specific instructions: ${instructions.trim()}`
    : `Draft a thoughtful reply.`;

  const r = await client().messages.create({
    model: CHAT_MODEL,
    max_tokens: 1500,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });

  const body = (r.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    to: replyTo,
    subject,
    body,
    inReplyTo: m.messageId || undefined,
    threadId: m.threadId || undefined,
    usage: r.usage,
  };
}

module.exports = { chat, draftReply, buildContext, buildSystemPrompt, CHAT_MODEL };
