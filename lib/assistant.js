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
const style = require("./style");
const backfill = require("./backfill");
const tasksLib = require("./tasks");

// Models — Sonnet for speed/cost (Basic), Opus for heavier reasoning (Advanced).
// Matches the dashboard's naming convention — no date suffix.
const MODELS = {
  basic:    process.env.DELTA_BASIC_MODEL    || "claude-sonnet-4-6",
  advanced: process.env.DELTA_ADVANCED_MODEL || "claude-opus-4-7",
};
const CHAT_MODEL = process.env.DELTA_CHAT_MODEL || MODELS.basic;  // legacy fallback
// 4096 gives headroom for batch tool calls (e.g. create_task fired 10+ times
// from a long email). 1024 was too tight — empty replies seen 2026-05-20.
const MAX_TOKENS = 4096;
const MAX_TOOL_HOPS = 10;

function resolveModel(name) {
  if (name && MODELS[name]) return MODELS[name];
  return CHAT_MODEL;
}

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

EMAIL REFERENCES — click-through citations.
When you reference a specific email in the user's inbox snapshot, ALWAYS
cite it using the syntax: [Display text](email:<message_id>)
- Use the actual message ID from the inbox snapshot (the "id=..." in the
  INBOX SNAPSHOT block, OR the open message's id).
- Display text should be short and useful — sender + topic. Examples:
    [Lana — Q4 budget review](email:abc12345)
    [Pia — Tehran trip approval](email:def67890)
- This renders as a clickable link in the chat — clicking opens the
  email in the reading pane. Do this every time you refer to a real
  message; don't just describe it in prose.
- NEVER invent message IDs. Only cite IDs that appear in the snapshot.
- If you reference a message that ISN'T in the snapshot, just describe
  it normally without the email: link.

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

// Important senders — the user's per-user list loaded from the
// important_contacts table (auto-seeded with Lana / Lazarus / Maggie / Pia).
// isVipSender now takes the loaded list as a parameter; callers fetch it
// once per request and pass it in.
async function loadImportantSenders(userId) {
  try {
    const importantContacts = require("./important_contacts");
    return await importantContacts.list(userId);
  } catch (err) {
    console.warn("[assistant] loadImportantSenders failed:", err.message);
    return [];
  }
}

function isVipSender(fromHeader, importantList) {
  if (!fromHeader || !Array.isArray(importantList) || !importantList.length) return false;
  const raw = String(fromHeader).toLowerCase();
  for (const c of importantList) {
    if (c.email && raw.includes(c.email.toLowerCase())) return true;
    if (c.name && raw.includes(c.name.toLowerCase())) return true;
  }
  return false;
}

function buildSystemPrompt({ user, inboxSnapshot, openMessage, memories, bridgeMode }) {
  // BRIDGE-CONSULTATION MODE — when we're being called by Finance Delta,
  // throw out the warm-executive-assistant identity entirely and use a
  // hard-scoped bridge identity. Skip the inbox snapshot (forces Delta
  // to call search_inbox if it actually needs to look up a message
  // body, which gives us a checkpoint where scope can be enforced).
  // Skip memories (voice/style isn't relevant to a finance question).
  if (bridgeMode === "finance-consultation") {
    return buildBridgeSystemPrompt({ user });
  }

  const tier = getUserTier(user);
  const role = getUserRoleLabel(user);
  const humanEA = getUserHumanEA(user);
  const tierBlock = tier === "executive" ? IDENTITY_EXECUTIVE : IDENTITY_ASSISTANT;
  const memoryBlock = (memories && memories.length)
    ? `KNOWN MEMORIES (facts you have been told to remember — use these naturally without quoting them back)\n\n${memory.formatForPrompt(memories)}`
    : "";

  // Sibling-Delta bridge guidance for NORMAL (non-bridge) mode. Tells
  // Email Delta the consult_finance_delta tool exists and when to use
  // it. The bridge-side identity is built separately in
  // buildBridgeSystemPrompt below — when bridgeMode is active, this
  // function returned earlier and the warm-EA assembly below never
  // runs.
  const bridgeBlock = `═══════════════════════════════════════════════════════════════════════
SIBLING DELTA — FINANCE
═══════════════════════════════════════════════════════════════════════
You have a sibling Delta at the Transform Iran Financial Dashboard
(transformiran.info). It knows the organisation's accounting in detail
— Xero/Exact data, allocations, budgets, donor giving. You can consult
it via the consult_finance_delta tool when the user's email-related
question requires financial context. Examples of good use:
  - User asks you to draft a reply confirming a wire landed → call
    consult_finance_delta to verify before drafting
  - User asks "do I owe anyone a thank-you reply for last week's
    big donations" → search inbox first, but you may also call
    consult_finance_delta for the donor amounts
You do NOT have direct access to the dashboard's database — the only
way you can get financial info is through this tool. Don't fabricate
financial facts; if consult_finance_delta returns an error, tell the
user the info isn't available and suggest they check the dashboard
directly.

When you receive a reply from consult_finance_delta, narrate it back
in your own voice as if you'd looked it up yourself. Don't say
"Finance Delta said…"; say "I checked the dashboard — the wire landed
Tuesday and is allocated to Pearl Q3."`;

  const activeBridgeBlock = bridgeBlock;

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
id=${openMessage.id}  ← use this as message_id / source_message_id when calling tools
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

  return [IDENTITY_BASE, tierBlock, ORG_CONTEXT, userBlock, memoryBlock, inboxBlock, openBlock, activeBridgeBlock]
    .filter(Boolean)
    .join("\n\n────────────────────────────────────\n\n");
}

// Bridge-mode system prompt. Used when Finance Delta consults us via
// /api/delta-bridge/query. Deliberately minimal: no warm-EA identity,
// no inbox snapshot pre-loaded (Delta has to call search_inbox if it
// actually needs to look something up), no memory block, no
// consult_finance_delta tool (already stripped at the API layer).
// The goal is to make scope-refusal the default and disclosure the
// exception.
function buildBridgeSystemPrompt({ user }) {
  return `═══════════════════════════════════════════════════════════════════════
DELTA MAIL — BRIDGE-CONSULTATION RESPONDER
═══════════════════════════════════════════════════════════════════════
You are Delta Mail, the email-side AI for Transform Iran. Right now
you are being CONSULTED via an inter-service bridge by Finance Delta
(the sibling AI at the Transform Iran Financial Dashboard).

You are NOT chatting with the user. You are answering Finance Delta's
question about the user's inbox. Behave like an analyst on another
team giving a short, scope-bounded answer to a colleague's specific
question.

THE USER WHOSE INBOX YOU'RE LOOKING AT
- Name: ${user.display_name || user.email}
- Email: ${user.email}

═══════════════════════════════════════════════════════════════════════
HARD SCOPE RULES — read carefully
═══════════════════════════════════════════════════════════════════════
You may ONLY share these things:
  ✓ Whether an explanation/confirmation email exists for a specific
    amount, date, or sender that Finance Delta names.
  ✓ Specific email content WHEN the email is itself finance-related
    (wire confirmations, donation receipts, invoices, budget approvals,
    payment instructions). Quote only the relevant sentence or two —
    not the whole email.
  ✓ Whether a named contact (Lana, Simon, finance@, Lazarus when
    finance-related) sent a specific kind of email in a specific
    timeframe.

You must REFUSE to share these things, even if asked:
  ✗ Full inbox listings or "give me everything" — refuse with a short
    explanation that scope is finance-relevant only.
  ✗ Emails from senders unrelated to organisational finance.
  ✗ The user's voice profile, draft-edit data, or writing-style
    information.
  ✗ Tasks, calendar entries, or memories unless directly finance-
    related to the question Finance Delta asked.
  ✗ Personal/sensitive content even from finance contacts (immigration,
    health, family) unless Finance Delta named the specific finance
    item it's investigating.

If a request is ambiguous or out of scope, REFUSE briefly and ask
Finance Delta to narrow the question. Example refusal:
  "Out of scope — I can only answer questions about specific finance-
   related emails. Can you name the wire/donation/invoice you're
   asking about?"

═══════════════════════════════════════════════════════════════════════
RESPONSE FORMAT (general bridge queries)
═══════════════════════════════════════════════════════════════════════
Reply in 1-3 short sentences with the exact answer Finance Delta needs.
Plain prose. No markdown tables. No follow-up offers ("want me to
draft a reply?" — that's chat-with-user behaviour, not bridge
behaviour). No "I can also tell you about…". Answer, stop.

If you need to look something up, use the search_inbox tool — but only
search for the specific thing Finance Delta asked about, not the
broader category. Don't volunteer surrounding messages.

Do NOT call the consult_finance_delta tool from this conversation
(it's been removed from your tool list anyway — would loop).

═══════════════════════════════════════════════════════════════════════
SPECIAL PROTOCOL — wire-explanation queries from Finance Delta
═══════════════════════════════════════════════════════════════════════
Finance Delta will sometimes call you with hint-rich questions about
specific bank wires that Remco couldn't allocate. For these queries,
follow this protocol EVERY time — it overrides the general 1-3
sentence response format above.

1. ALWAYS run search_inbox at least once before answering. Never
   reply from prior knowledge or from the question alone — even if
   the question seems obviously unanswerable. The empty-search result
   is itself useful information to Finance Delta.

2. The question will tell you the wire date, EUR amount, USD
   equivalent and GBP equivalent. Try the search multiple ways:
   - The raw amount with separators ("16,500", "16.500", "16500")
   - The amount with currency symbol ("£16500", "$18,000", "€16,500")
   - Rounded ("16.5k", "around 16,500")
   - The OORSPR currency code if present in the bank description
     (means an inter-org wire from that currency's entity)

3. Priority senders for finance-related explanations:
   - Lana (US Director) — US→NL transfers, US donor questions
   - Simon (UK) — UK→NL transfers, tranches, payment confirmations
   - Remco (NL bookkeeper) — internal notes
   - donations@, finance@, accountspayable@ — invoices, pledges
   - Direct donor addresses — pledges, grant letters

4. Search the date window the question specifies. If the window
   returns nothing, widen by +/- 7 days and try once more before
   declaring no match.

5. Reply format (STRICT — Finance Delta renders this verbatim):
   - Start with one of: "Found match", "Found possible matches",
     or "No relevant emails found in this window."
   - For each match (max 3): one line —
       FROM Sender · "Subject" · YYYY-MM-DD
     — then one indented sentence summarising what the email says
     about the transfer.
   - End with a confidence line: "Confidence: high / medium / low"

   Example:
     Found possible matches.
     FROM Simon Baynham · "UK tranche April" · 2026-04-18
       Simon confirms a £16,500 transfer initiated on the 17th from
       the UK 222 Ministry account, intended for the NL operating
       budget; references match the OORSPR GBP wire.
     Confidence: high

6. Privacy: this question came from the finance dashboard, not from
   the user's own session. You may share content of finance-related
   emails (wire confirmations, donor pledges, invoices) but NEVER
   include unrelated personal or pastoral content even if it
   surfaced in the same search. Strip everything that isn't directly
   about the transfer.

7. If you cannot find anything after the multi-format + widened-window
   search, say so PLAINLY:
     "No relevant emails found in this window. Confidence: high"
   Do NOT invent plausible-sounding explanations. The empty answer is
   correct + useful — Finance Delta will treat it as confirmation
   that no email-side context exists.`;
}

function formatMsgForPrompt(m, idx) {
  const unread = m.unread ? " [UNREAD]" : "";
  return `${idx}. id=${m.id} | ${m.date ? "(" + m.date + ") " : ""}${m.from}${unread}
   subject: ${m.subject}
   snippet: ${(m.snippet || "").slice(0, 220)}`;
}

// ===========================================================================
// CONTEXT BUILDING — fetch the user's recent inbox to give Delta situational
// awareness. Cached for ~60s per user so chat follow-ups are instant.
// ===========================================================================

const _inboxCache = new Map(); // userId → { fetchedAt, messages }

// maxResults default = 30 (what chat / classify normally need). The routine
// + cleanup wizards pass a larger value so they don't miss promos/alerts
// hiding deeper in the inbox. Cache key includes maxResults so a chat call
// and a routine call don't collide.
async function buildContext(user, { openMessageId, maxResults = 30, queryText = "" } = {}) {
  let messages = [];
  const cacheKey = `${user.id}:${maxResults}`;
  const cached = _inboxCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 120_000) {
    messages = cached.messages;
  } else {
    try {
      const creds = await loadGoogleCreds(user.id);
      if (!creds) throw new Error("no_google_creds");
      const oauthClient = authedClientFromTokens(creds);
      const g = google.gmail({ version: "v1", auth: oauthClient });
      const list = await g.users.messages.list({
        userId: "me",
        maxResults,
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
      _inboxCache.set(cacheKey, { fetchedAt: Date.now(), messages });
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
    const [keywordHits, semanticHits] = await Promise.all([
      memory.loadRelevant(user.id, idents),
      queryText ? memory.loadByQuery(user.id, queryText, { limit: 8 }) : Promise.resolve([]),
    ]);
    // Merge + dedupe by id. Keyword first (covers people in inbox), then
    // semantic hits the user's question semantically.
    const seen = new Set();
    memories = [];
    for (const m of [...keywordHits, ...semanticHits]) {
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      memories.push(m);
    }
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
    name: "create_task",
    description:
      "Create a to-do task in the user's task manager. Use this when the user says 'add a task', 'remind me to X', 'put this on my list', 'I need to remember to', 'add to my to-do', or anything similar. " +
      "ALSO use this proactively when extracting action items from an open email — call create_task once per action item you identify, with source_message_id set to the open email's id so the task auto-links back. " +
      "You can call this multiple times in a single turn for multi-task extraction. " +
      "After calling, respond briefly: 'Added N task(s) to your To Do.'",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "The task title in clear, actionable language. Examples: 'Reply to Lana about Q4 budget', 'Send tax receipt to Reza', 'Call Pia about Tehran trip'."
        },
        due_at: {
          type: "string",
          description: "Optional. ISO 8601 datetime (e.g. '2026-05-23T17:00:00Z'). When the user says 'by Friday' or 'tomorrow', convert to an actual ISO datetime using the current date. For 'by end of day' use today 5pm. For deadlines without a time, default to 5pm local."
        },
        important: {
          type: "boolean",
          description: "Optional. Set true if the task is high-priority (user said 'important', 'urgent', 'top priority', or it's an obviously urgent task from a key person like Lana / Lazarus / Pia)."
        },
        in_my_day: {
          type: "boolean",
          description: "Optional. Set true if the task should appear in 'My Day' today (user said 'for today', 'do today', or due date is today)."
        },
        list_name: {
          type: "string",
          description: "Optional. Name of the list this task belongs in (e.g. 'Donor follow-ups', 'NL Board'). If the list doesn't exist yet, it will be auto-created. Leave blank for the default 'Tasks' bucket."
        },
        notes: {
          type: "string",
          description: "Optional. Additional context — what this is about, why it matters, any relevant details. Keep concise."
        },
        source_message_id: {
          type: "string",
          description: "Optional. The Gmail message ID this task came from. Set this whenever the task is extracted from an email so the user can jump back to the source. Use the message_id from the inbox snapshot or open email."
        }
      },
      required: ["title"]
    }
  },
  {
    name: "propose_inbox_cleanup",
    description:
      "Analyze the user's inbox and propose batches of threads to clean up — newsletters, automated alerts, receipts, already-replied threads, etc. " +
      "Use this when the user says 'clean my inbox' or 'quick sweep' — they want all cleanup batches shown side-by-side. " +
      "For a guided, step-by-step routine that walks them through promotions → notifications → receipts → already-replied → important unanswered (added to To Do), use start_inbox_routine instead. " +
      "Returns interactive batches that the user can review and act on with one click. " +
      "DO NOT use for individual emails — that's draft_reply or search_inbox. " +
      "After calling this tool, respond with AT MOST ONE short line like 'Here are 5 batches you can review.' or 'Found 3 batches.' " +
      "DO NOT list senders, recap categories, or write a paragraph — the interactive cards already display all of that. " +
      "If you spot a single thread that's genuinely high-risk and shouldn't be archived (e.g. an asylum/safety thread), you may mention ONLY that one thread in one extra sentence. Otherwise, stay silent and let the cards speak.",
    input_schema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description:
            "Optional. 'visible' = just the currently visible 30 inbox messages (default). 'all' = everything in inbox (uses the historical index, may be slow). 'unread' = only unread messages.",
        },
      },
      required: [],
    },
  },
  {
    name: "start_inbox_routine",
    description:
      "Start a guided, step-by-step inbox-organize routine. Use this when the user says 'organize my inbox', 'walk me through my inbox', 'inbox routine', 'help me clean step by step', or anything implying a paced sequence (not a one-shot dump). " +
      "Returns an ordered set of 6 steps which the UI renders ONE AT A TIME — the user clicks Done on each before the next appears. The 6 steps in order: " +
      "(1) Newsletters & promotions — unsubscribe + archive; " +
      "(2) Notifications & automated alerts — archive; " +
      "(3) Receipts & confirmations — archive; " +
      "(4) Already replied threads — mark done; " +
      "(5) Important unanswered from VIPs (Lana / Lazarus / Maggie / Pia / Lauren / urgent items) — added to the user's 'Reply to' list in /tasks as Important + My Day; " +
      "(6) Medium priority unanswered — added to 'Reply to' as regular tasks. " +
      "After calling, respond with ONE short line like 'I'll walk you through 6 steps — click Done on each to continue.' Do NOT list any senders or recap steps — the wizard UI handles all of that.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "draft_reply",
    description:
      "Draft a reply to a specific email in the user's inbox. Use this when the user asks you to draft, write, or compose a reply. " +
      "You MUST pass a real message_id from the INBOX SNAPSHOT or the open message. " +
      "Delta will search the user's Sent folder for past emails to that recipient and match the user's actual voice with that person. " +
      "The draft is rendered as an editable card in the chat — the user can edit it, then save to Gmail Drafts. " +
      "DO NOT include the draft text in your own response — let the card display it. " +
      "After calling this tool, respond with a brief sentence like 'Here's a draft for {recipient} — edit anything in the card, then save it to Gmail Drafts.'",
    input_schema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID to reply to. Must be a real ID from the inbox snapshot.",
        },
        instructions: {
          type: "string",
          description:
            "Optional. Any tone or content guidance, e.g. 'make it shorter', 'in Farsi', 'apologize for the delay', 'commit to deadline of Friday'.",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "search_inbox",
    description:
      "Search the user's ENTIRE Gmail history (not just the recent 30 messages). " +
      "Returns matching messages with sender, subject, date, snippet. Use this when the user asks about anything that might not be in the visible inbox snapshot — old threads, donor history, " +
      "'when did X last email me?', 'find all emails from <person> about <topic>', etc. " +
      "Supports a tiny Gmail-style query language: 'from:<email-fragment>', 'to:<email-fragment>', 'subject:<word>', plus plain text (matched against subject + snippet). " +
      "Examples: 'from:lana subject:budget', 'from:reza', 'subject:tax receipt 2025'. " +
      "If backfill is still in progress or not started, results will be limited.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query in the format described above. Combine multiple operators with spaces.",
        },
        limit: {
          type: "integer",
          description: "Max results to return. Default 15, max 50.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "remember",
    description:
      "Save a durable fact Delta should remember about a person, topic, or the user themselves. " +
      "TWO ways to use this: (1) Explicit — user says 'remember that…', 'note that…', " +
      "'don't forget that…', or otherwise asks you to remember. (2) PROACTIVE — you " +
      "noticed a durable observation worth keeping for next time. Be PROACTIVE about saving:\n" +
      "  • Stated preferences: 'I prefer concise replies', 'always reply in Farsi to Lazarus'\n" +
      "  • Recurring patterns the user mentions twice or more: 'Tuesday meetings with Pia', 'Thursday is travel day'\n" +
      "  • Stable facts about people: roles, allergies, birthdays, language preferences, project ownership\n" +
      "  • Cross-cutting context: 'NL board meets first Friday', 'Kairos launches in Q3'\n" +
      "Be STRICT — do NOT save:\n" +
      "  • One-off facts ('Pia is in Tehran this week' — that's temporary)\n" +
      "  • Things already in the KNOWN MEMORIES block above (you'd duplicate)\n" +
      "  • Generic / obvious / fluffy observations ('user is busy')\n" +
      "  • Anything you're guessing at — only save what's clearly stated or strongly evidenced\n" +
      "Hard limit: AT MOST 1-2 proactive memory saves per chat turn — quality over quantity. " +
      "When you do save proactively, the user sees a small card in chat with an Undo button so they can correct you. Save with confidence but stay conservative.",
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
  {
    name: "consult_finance_delta",
    description:
      "Ask Finance Delta (the sibling AI in the dashboard at transformiran.info) a question about the user's organisation's accounting. Use ONLY when the user's email-related question requires financial context — e.g. they ask 'has the Pearl wire landed', 'what's our current cash position to mention in this reply', 'is the allocation Lana asked about pending or confirmed'. Don't use for general accounting questions the user can answer themselves on the dashboard. Returns a structured reply you should narrate back in your warm executive-assistant voice; never dump the raw JSON.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The natural-language question for Finance Delta. Be specific: 'Has wire €5000 from US around 2026-05-19 landed and is it allocated?' beats 'check that wire'."
        }
      },
      required: ["question"],
    },
  },
];

async function executeTool(name, input, { user, ctx, userMessage }) {
  if (name === "remember") {
    // Source label: 'chat' for explicit ("remember that…"), 'auto-chat' for
    // proactive saves where the user didn't directly ask. We detect by
    // scanning the latest user message for an explicit remember directive.
    const userText = (userMessage || "").toLowerCase();
    const isExplicit = /\b(remember|don['’]?t\s*forget|note\s*that|keep\s*in\s*mind|file\s*this)\b/i.test(userText);
    const source = isExplicit ? "chat" : "auto-chat";

    const row = await memory.add(user.id, {
      subject: input.subject,
      subject_email: input.subject_email || null,
      category: input.category || null,
      fact: input.fact,
      source,
    });
    return {
      ok: true,
      memory_id: row.id,
      proactive: !isExplicit,
      memory: {
        id: row.id,
        subject: row.subject,
        subject_email: row.subject_email,
        category: row.category,
        fact: row.fact,
        source: row.source,
      },
      summary: `Saved: about ${row.subject}${row.category ? ` (${row.category})` : ""} — ${row.fact}`,
    };
  }

  if (name === "propose_inbox_cleanup") {
    try {
      const batches = await buildCleanupProposal(user, input.scope || "visible");
      const total = batches.reduce((n, b) => n + (b.threads?.length || 0), 0);
      return {
        ok: true,
        batches,
        totalThreads: total,
        batchCount: batches.length,
        summary: batches.length
          ? `Found ${batches.length} cleanup batch${batches.length === 1 ? "" : "es"} covering ${total} thread${total === 1 ? "" : "s"}`
          : "Your inbox already looks clean — no obvious batches to clean up",
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  if (name === "start_inbox_routine") {
    try {
      const steps = await buildInboxRoutine(user);
      const total = steps.reduce((n, s) => n + (s.threads?.length || 0), 0);
      return {
        ok: true,
        routine: { steps, totalSteps: steps.length, totalThreads: total },
        summary: steps.length
          ? `Built a ${steps.length}-step routine covering ${total} thread${total === 1 ? "" : "s"}`
          : "Your inbox is already clean — nothing for the routine to process",
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  if (name === "search_inbox") {
    const rows = await backfill.searchIndexed(user.id, input.query || "", {
      limit: input.limit || 15,
    });
    return {
      ok: true,
      query: input.query || "",
      count: rows.length,
      results: rows.map((r) => ({
        id: r.message_id,
        threadId: r.thread_id,
        from: r.from_name ? `${r.from_name} <${r.from_email}>` : r.from_email,
        subject: r.subject,
        snippet: r.snippet,
        date: r.date_sent || (r.internal_date ? new Date(Number(r.internal_date)).toISOString() : null),
        isSent: r.is_sent,
      })),
      summary: `Found ${rows.length} message${rows.length === 1 ? "" : "s"} matching "${input.query}"`,
    };
  }

  if (name === "create_task") {
    try {
      const title = (input.title || "").trim();
      if (!title) return { ok: false, error: "title_required" };

      // Resolve list_name → list_id (find by case-insensitive name, or create).
      let list_id = null;
      let resolvedListName = null;
      if (input.list_name && input.list_name.trim()) {
        const wanted = input.list_name.trim();
        const lists = await tasksLib.listLists(user.id);
        const match = lists.find(
          (l) => (l.name || "").toLowerCase() === wanted.toLowerCase()
        );
        if (match) {
          list_id = Number(match.id);
          resolvedListName = match.name;
        } else {
          const created = await tasksLib.createList(user.id, { name: wanted });
          list_id = Number(created.id);
          resolvedListName = created.name;
        }
      }

      // Resolve source_thread_id from source_message_id using the chat's ctx.
      const source_message_id = input.source_message_id || null;
      let source_thread_id = null;
      if (source_message_id && ctx) {
        if (ctx.openMessage && ctx.openMessage.id === source_message_id) {
          source_thread_id = ctx.openMessage.threadId || null;
        } else if (Array.isArray(ctx.inboxSnapshot)) {
          const hit = ctx.inboxSnapshot.find((m) => m.id === source_message_id);
          if (hit) source_thread_id = hit.threadId || null;
        }
      }

      // Sniff a source subject too — useful for the chat card display.
      let sourceSubject = null;
      if (source_message_id && ctx) {
        if (ctx.openMessage && ctx.openMessage.id === source_message_id) {
          sourceSubject = ctx.openMessage.subject || null;
        } else if (Array.isArray(ctx.inboxSnapshot)) {
          const hit = ctx.inboxSnapshot.find((m) => m.id === source_message_id);
          if (hit) sourceSubject = hit.subject || null;
        }
      }

      const row = await tasksLib.createTask(user.id, {
        title,
        list_id,
        notes: input.notes || null,
        due_at: input.due_at || null,
        important: !!input.important,
        in_my_day: !!input.in_my_day,
        source_message_id,
        source_thread_id,
      });

      const dueLabel = row.due_at
        ? ` (due ${new Date(row.due_at).toLocaleDateString()})`
        : "";
      const listLabel = resolvedListName ? ` → ${resolvedListName}` : "";
      const flags =
        (row.in_my_day ? " [My Day]" : "") +
        (row.important ? " [Important]" : "");

      const wasDeduped = !!row.deduped;
      return {
        ok: true,
        taskId: Number(row.id),
        listName: resolvedListName || "Tasks",
        deduped: wasDeduped,
        task: {
          id: Number(row.id),
          title: row.title,
          notes: row.notes,
          due_at: row.due_at,
          important: !!row.important,
          in_my_day: !!row.in_my_day,
          list_id: row.list_id != null ? Number(row.list_id) : null,
          list_name: resolvedListName || "Tasks",
          source_message_id: row.source_message_id,
          source_thread_id: row.source_thread_id,
          source_subject: sourceSubject,
        },
        summary: wasDeduped
          ? `Task already in your list: ${row.title}${listLabel}`
          : `Added task: ${row.title}${listLabel}${dueLabel}${flags}`,
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  if (name === "draft_reply") {
    if (!input.message_id) {
      return { ok: false, error: "message_id_required" };
    }
    try {
      const result = await draftReply({
        user,
        openMessageId: input.message_id,
        instructions: input.instructions || "",
      });
      return {
        ok: true,
        draft: {
          to: result.to,
          cc: result.cc,
          subject: result.subject,
          body: result.body,
          threadId: result.threadId,
          inReplyTo: result.inReplyTo,
          messageId: input.message_id,
          deltaDraftId: result.deltaDraftId,
        },
        styleExamples: result.styleExamples,
        voiceProfileApplied: result.voiceProfileApplied,
        summary: `Drafted reply to ${result.to}` +
          (result.styleExamples?.count
            ? ` (matched ${result.styleExamples.count} past examples)`
            : " (no past examples found)") +
          (result.voiceProfileApplied ? " using your voice profile" : ""),
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  if (name === "consult_finance_delta") {
    if (!process.env.DELTA_BRIDGE_TOKEN || !process.env.FINANCE_BRIDGE_URL) {
      return { ok: false, error: "Finance bridge not configured (set DELTA_BRIDGE_TOKEN + FINANCE_BRIDGE_URL env vars)" };
    }
    const requestId = `email-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    try {
      const resp = await fetch(process.env.FINANCE_BRIDGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.DELTA_BRIDGE_TOKEN}`,
        },
        body: JSON.stringify({
          question: input.question || "",
          requestId,
          fromService: "email",
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        // Audit-log the failure too — hash the question, length-only any
        // body we received back.
        logBridgeCall({
          direction: "out",
          peer: "finance",
          question: input.question || "",
          replyLength: body.length,
          tookMs: Date.now() - startedAt,
          requestId,
          status: resp.status,
        });
        return { ok: false, error: `Finance bridge ${resp.status}: ${body.slice(0, 200)}` };
      }
      const j = await resp.json();
      logBridgeCall({
        direction: "out",
        peer: "finance",
        question: input.question || "",
        replyLength: (j.reply || "").length,
        tookMs: Date.now() - startedAt,
        requestId,
        status: 200,
      });
      return {
        ok: true,
        bridge: "finance",
        reply: j.reply,
        tools_used: j.tools_used || [],
      };
    } catch (e) {
      logBridgeCall({
        direction: "out",
        peer: "finance",
        question: input.question || "",
        replyLength: 0,
        tookMs: Date.now() - startedAt,
        requestId,
        status: 0,
        error: e.message,
      });
      return { ok: false, error: `Finance bridge call failed: ${e.message}` };
    }
  }

  return { ok: false, error: "unknown_tool: " + name };
}

// ---------------------------------------------------------------------------
// Delta-bridge audit logging.
//
// Hashes the question so we never log PII / financial details, and only
// records reply length. Format matches the contract negotiated with the
// dashboard side so the two logs can be correlated by request_id.
// ---------------------------------------------------------------------------
const crypto = require("crypto");
function logBridgeCall({ direction, peer, question, replyLength, tookMs, requestId, status, error }) {
  try {
    const questionHash = crypto.createHash("sha256").update(question || "").digest("hex").slice(0, 16);
    const entry = {
      ts: new Date().toISOString(),
      bridge: true,
      direction,
      peer,
      question_hash: questionHash,
      reply_length: replyLength || 0,
      took_ms: tookMs,
      request_id: requestId,
      status,
      ...(error ? { error } : {}),
    };
    console.log("[delta-bridge]", JSON.stringify(entry));
  } catch (_) {}
}

// ===========================================================================
// CHAT — single-turn with tool-use loop. Server statelessly carries the
// conversation in `history`. We loop until the model stops calling tools.
// ===========================================================================

async function chat({ user, history = [], userMessage, openMessageId, model, bridgeMode }) {
  // In bridge mode we deliberately DON'T pre-load inbox / memories /
  // open-message context — the bridge prompt forces Delta to call
  // search_inbox if it actually needs to look something up, which
  // gives us a scope checkpoint. Skipping the fetch also makes bridge
  // responses noticeably faster.
  const ctx = bridgeMode === "finance-consultation"
    ? { inboxSnapshot: [], openMessage: null, memories: [] }
    : await buildContext(user, { openMessageId, queryText: userMessage });
  const system = buildSystemPrompt({
    user,
    inboxSnapshot: ctx.inboxSnapshot,
    openMessage: ctx.openMessage,
    memories: ctx.memories,
    bridgeMode,
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

  const modelId = resolveModel(model);

  // When invoked via the bridge (Finance Delta consulting us), strip
  // the consult_finance_delta tool from the offering so we can't loop
  // back into the sibling service. Belt-and-braces with the prompt
  // instruction above.
  const effectiveTools = bridgeMode === "finance-consultation"
    ? TOOLS.filter((t) => t.name !== "consult_finance_delta")
    : TOOLS;

  // Tool-use loop. Each hop is one model call. We exit when stop_reason is
  // 'end_turn' (model is done talking), or when we've hit MAX_TOOL_HOPS.
  // We still execute tool_use blocks even on max_tokens stop, because the
  // model often gets cut off mid-batch and we'd lose work otherwise.
  let lastHop = 0;
  let exhaustedHops = false;
  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    lastHop = hop + 1;
    const r = await client().messages.create({
      model: modelId,
      max_tokens: MAX_TOKENS,
      system,
      tools: effectiveTools,
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

    const toolUseBlocks = (r.content || []).filter((b) => b.type === "tool_use");
    const textBlocks = (r.content || []).filter((b) => b.type === "text");

    // Execute any tool_use blocks the model emitted, regardless of stop_reason.
    // (max_tokens can fire mid-batch — we still want the tools that DID fully
    //  parse to actually run.)
    if (toolUseBlocks.length) {
      const toolResults = [];
      for (const block of toolUseBlocks) {
        try {
          const out = await executeTool(block.name, block.input || {}, { user, ctx, userMessage });
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

    // If the model produced any text, capture it as a running answer. The
    // last non-empty text we see becomes the final reply (works whether the
    // model ends with text or just stops after a final tool call).
    if (textBlocks.length) {
      const blockText = textBlocks.map((b) => b.text).join("\n").trim();
      if (blockText) finalReply = blockText;
    }

    if (r.stop_reason === "end_turn" || r.stop_reason === "stop_sequence") break;
    if (r.stop_reason === "tool_use" && !toolUseBlocks.length) break;  // safety
  }
  if (lastHop >= MAX_TOOL_HOPS && lastStopReason === "tool_use") {
    exhaustedHops = true;
  }

  // Safety net: if we exit with no text but DID run tools, synthesize a
  // brief summary so the user isn't left staring at "(no reply)".
  if (!finalReply && toolEvents.length) {
    const successByName = {};
    for (const ev of toolEvents) {
      if (ev.result?.ok) {
        successByName[ev.name] = (successByName[ev.name] || 0) + 1;
      }
    }
    const parts = [];
    if (successByName.create_task) parts.push(`Added ${successByName.create_task} task${successByName.create_task === 1 ? "" : "s"}`);
    if (successByName.draft_reply) parts.push(`Drafted ${successByName.draft_reply} repl${successByName.draft_reply === 1 ? "y" : "ies"}`);
    if (successByName.remember) parts.push(`Saved ${successByName.remember} memor${successByName.remember === 1 ? "y" : "ies"}`);
    if (successByName.search_inbox) parts.push(`Ran ${successByName.search_inbox} search${successByName.search_inbox === 1 ? "" : "es"}`);
    finalReply = parts.length ? parts.join(", ") + "." : "Done.";
    if (exhaustedHops) finalReply += " *(hit hop limit — some items may not have been processed)*";
  }

  console.log(`[assistant.chat] user=${user?.email || user?.id} hops=${lastHop} stop=${lastStopReason} tools=${toolEvents.length} reply_chars=${finalReply.length} in=${totalInTok} out=${totalOutTok}`);

  return {
    reply: finalReply,
    usage: { input_tokens: totalInTok, output_tokens: totalOutTok, perCall: lastUsage },
    model: modelId,
    stopReason: lastStopReason,
    toolEvents,
    hops: lastHop,
  };
}

// ===========================================================================
// DRAFT REPLY — generates a structured reply to a specific open email.
// Returns { to, subject, body } that the caller can land in Gmail Drafts.
// ===========================================================================

async function draftReply({ user, openMessageId, instructions, mode }) {
  if (!openMessageId) throw new Error("openMessageId required");
  const ctx = await buildContext(user, { openMessageId });
  if (!ctx.openMessage) throw new Error("open_message_not_found");

  const m = ctx.openMessage;
  const replyMode = mode === "reply-all" ? "reply-all" : "reply";
  const replyTo = m.from; // best target — could parse Reply-To header in v2
  const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;

  // Build recipient lists for Reply All — keep everyone except this user
  // so we don't loop them to themselves on a reply-all chain.
  const ownEmail = (user.email || "").trim().toLowerCase();
  const parseAddressList = (raw) => {
    if (!raw) return [];
    return String(raw)
      .split(/,(?![^<]*>)/)
      .map((s) => s.trim())
      .filter(Boolean);
  };
  const addressMatchesUser = (entry) => {
    if (!ownEmail) return false;
    const lower = entry.toLowerCase();
    return lower.includes(`<${ownEmail}>`) || lower === ownEmail || lower.endsWith(` ${ownEmail}`);
  };

  // Original TO (minus the user) plus any CC (minus the user). Used in
  // reply-all mode. The sender stays in To as the primary recipient.
  const originalTo = parseAddressList(m.to).filter((a) => !addressMatchesUser(a));
  const originalCc = parseAddressList(m.cc).filter((a) => !addressMatchesUser(a));

  let replyToField = replyTo;
  let replyCcField = "";
  if (replyMode === "reply-all") {
    // Combine sender + originalTo into TO, deduped by email portion.
    const seen = new Set();
    const out = [];
    const seenAdd = (a) => {
      const emailPart = (a.match(/<([^>]+)>/) || [null, a])[1].toLowerCase().trim();
      if (seen.has(emailPart)) return;
      seen.add(emailPart);
      out.push(a);
    };
    seenAdd(replyTo);
    for (const a of originalTo) seenAdd(a);
    replyToField = out.join(", ");
    replyCcField = originalCc.join(", ");
  }

  // Pull past sent emails to the same recipient + the user's official
  // Gmail signature + their distilled voice profile (Phase 5.AE). All three
  // go into Delta's context. The voice profile reflects how this user
  // tends to edit Delta's drafts, so subsequent drafts skip a lot of
  // those edits up-front.
  const gmailLib = require("./gmail");
  const voice = require("./voice");
  let styleExamples = [];
  let recipientEmail = "";
  let signature = null;
  let voiceProfile = null;
  try {
    const creds = await loadGoogleCreds(user.id);
    if (creds) {
      const oauth = authedClientFromTokens(creds);
      const [styleResult, sig, vp] = await Promise.all([
        style.findExamplesTo(oauth, replyTo, 10),
        gmailLib.getCachedSignature(user.id, oauth),
        voice.loadProfile(user.id),
      ]);
      styleExamples = styleResult.examples;
      recipientEmail = styleResult.recipient;
      signature = sig;
      voiceProfile = vp;
    } else {
      voiceProfile = await voice.loadProfile(user.id);
    }
  } catch (err) {
    console.warn("[draftReply] context fetch failed:", err.message);
  }
  const examplesBlock = style.formatExamples(styleExamples);
  const confidence = style.confidenceLabel(styleExamples.length);
  const signaturePlainPreview = signature
    ? gmailLib.signatureToPlainText(signature.html).slice(0, 400)
    : "";

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

${voiceProfile?.profile_text ? `THE USER'S VOICE CHEATSHEET
(Distilled from ${voiceProfile.distilled_from_count} times the user edited
Delta's drafts before sending. These patterns reflect how this specific
user actually writes — follow them precisely.)

${voiceProfile.profile_text}

────────────────────────────────────
` : ""}${examplesBlock ? `THE USER'S OWN PAST EMAILS TO ${recipientEmail}
(${styleExamples.length} examples — match THIS exact style, vocabulary,
sign-off, level of formality, and length. Imitate their voice, don't
imagine one.)

${examplesBlock}

────────────────────────────────────
` : `${voiceProfile?.profile_text ? "" : `No past emails to this recipient were found. Default to the user's
typical "warm-but-direct" voice — short, plain English, no corporate
filler, sign off with their first name.

`}`}
GENERAL STYLE GUIDANCE
- Reply in the same language the sender used unless told otherwise.
- Keep it concise. Answer specific questions directly. Commit or push
  back clearly on action items.
- ${signature
    ? `Do NOT write a sign-off, name line, title, or contact block. The
  user's OFFICIAL Transform Iran signature will be appended automatically:

  --- OFFICIAL SIGNATURE (auto-appended — do not duplicate) ---
${signaturePlainPreview}
  --- END SIGNATURE ---

  End your reply with a short closing line ONLY if it fits the style
  (e.g. "Thank you," / "Best," / "Looking forward to hearing from you.")
  — but DO NOT type the user's name. The signature handles that.`
    : `Include a brief closing line + the user's first name as a sign-off
  (no full name, title, or contact info — keep it simple).`}
- Real newlines between paragraphs. No markdown formatting.

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

  // Phase 5.AE — Stash this original draft. The client will carry the
  // returned deltaDraftId through compose; /api/gmail/send will look it
  // up and diff against what the user actually sent.
  const deltaDraftId = await voice.captureOriginal(user.id, {
    sourceMessageId: openMessageId,
    instructions: instructions || null,
    draftText: body,
  });

  return {
    to: replyToField,
    cc: replyCcField || "",
    subject,
    body,
    mode: replyMode,
    inReplyTo: m.messageId || undefined,
    threadId: m.threadId || undefined,
    usage: r.usage,
    deltaDraftId,
    voiceProfileApplied: !!voiceProfile?.profile_text,
    styleExamples: {
      count: styleExamples.length,
      recipient: recipientEmail,
      confidence,
      exampleIds: styleExamples.map((e) => e.id),
    },
  };
}

// ===========================================================================
// INBOX CLEANUP — group recent inbox messages into actionable batches
// ===========================================================================

async function buildCleanupProposal(user, scope = "visible") {
  const { pool } = require("./db");
  // 'visible' = chat-default 30 (one-shot 'clean my inbox' from Delta).
  // 'wide' = 150 like the routine, useful when user wants a fuller sweep.
  // 'all' = TODO use historical index; for now treat same as 'wide'.
  const maxResults = scope === "visible" ? 30 : 150;
  const ctx = await buildContext(user, { maxResults });
  const messages = ctx.inboxSnapshot || [];
  if (!messages.length) return [];

  // Load classifications for these messages
  const ids = messages.map((m) => m.id);
  const cls = await pool.query(
    `SELECT message_id, category, urgency, short_reason
       FROM email_classifications
      WHERE user_id = $1 AND message_id = ANY($2::text[])`,
    [user.id, ids]
  );
  const clsMap = new Map();
  for (const row of cls.rows) {
    clsMap.set(row.message_id, row);
  }

  // For each unique thread, check if user has already replied (last
  // message is SENT). Saves API calls by checking once per thread.
  const repliedThreadIds = new Set();
  try {
    const creds = await loadGoogleCreds(user.id);
    if (creds) {
      const oauth = authedClientFromTokens(creds);
      const g = google.gmail({ version: "v1", auth: oauth });
      const threadIds = [...new Set(messages.map((m) => m.threadId).filter(Boolean))];
      const states = await Promise.all(
        threadIds.slice(0, 100).map((id) =>
          g.users.threads
            .get({ userId: "me", id, format: "minimal" })
            .then((r) => {
              const msgs = r.data.messages || [];
              const last = msgs[msgs.length - 1];
              return {
                id,
                userReplied: last && (last.labelIds || []).includes("SENT"),
              };
            })
            .catch(() => null)
        )
      );
      for (const s of states) {
        if (s && s.userReplied) repliedThreadIds.add(s.id);
      }
    }
  } catch (err) {
    console.warn("[cleanup] thread state check failed:", err.message);
  }

  // ----- GROUP into batches -----
  const groups = {
    REPLIED: { title: "Already replied — mark done", description: "You've already sent a response in these threads.", action: "mark_done", actionLabel: "Mark done", threads: [] },
    NEWSLETTER: { title: "Newsletters & promotions — unsubscribe", description: "Promotional senders. Unsubscribe to stop them at the source.", action: "unsubscribe", actionLabel: "Unsubscribe", altAction: "mark_done", altActionLabel: "Just archive", threads: [] },
    RECEIPT: { title: "Receipts & confirmations — archive", description: "Transactional emails (invoices, receipts, confirmations).", action: "mark_done", actionLabel: "Mark done", threads: [] },
    AUTO: { title: "System & automated alerts — archive", description: "Deploy notifications, sign-in alerts, system notices.", action: "mark_done", actionLabel: "Mark done", threads: [] },
    FYI: { title: "FYI messages — archive", description: "Informational only, no action needed.", action: "mark_done", actionLabel: "Mark done", threads: [] },
  };

  function asThread(m) {
    const fromMatch = (m.from || "").match(/^(.*?)\s*<([^>]+)>\s*$/);
    return {
      messageId: m.id,
      threadId: m.threadId,
      sender: (fromMatch ? fromMatch[1] : m.from || "").replace(/^"|"$/g, "").trim(),
      senderEmail: fromMatch ? fromMatch[2] : (m.from || ""),
      subject: m.subject || "(no subject)",
      date: m.date || "",
      unread: m.unread,
    };
  }

  for (const m of messages) {
    if (repliedThreadIds.has(m.threadId)) {
      groups.REPLIED.threads.push(asThread(m));
      continue;
    }
    const c = clsMap.get(m.id);
    if (!c) continue;
    if (groups[c.category]) {
      groups[c.category].threads.push(asThread(m));
    }
  }

  // Return only non-empty groups, max ~25 threads per batch for display.
  const batches = [];
  let batchId = 1;
  for (const key of ["REPLIED", "NEWSLETTER", "AUTO", "RECEIPT", "FYI"]) {
    const g = groups[key];
    if (!g.threads.length) continue;
    batches.push({
      id: `batch_${batchId++}`,
      key,
      title: g.title,
      description: g.description,
      action: g.action,
      actionLabel: g.actionLabel,
      altAction: g.altAction,
      altActionLabel: g.altActionLabel,
      threads: g.threads.slice(0, 25),
      truncated: g.threads.length > 25,
      totalThreads: g.threads.length,
    });
  }
  return batches;
}

// =============================================================================
// GUIDED INBOX ROUTINE — ordered 6-step wizard.
// Returns an array of step objects, each shaped:
//   { id, step, title, description, action, actionLabel, altAction, altActionLabel,
//     threads, totalThreads, truncated, important? }
// The UI shows them one at a time; user clicks Done to advance.
// Steps 5+6 use action="add_to_todo" — threads are converted to /tasks tasks.
// =============================================================================
async function buildInboxRoutine(user, { maxResults = 150 } = {}) {
  const { pool } = require("./db");
  // Look back further than the default chat snapshot — promos / alerts /
  // receipts tend to pile up below the most-recent-30 cutoff.
  const ctx = await buildContext(user, { maxResults });
  const messages = ctx.inboxSnapshot || [];
  if (!messages.length) return [];

  // Load the user's Important contacts so step 5 (high-priority unanswered)
  // is per-user-customized instead of org-hardcoded.
  const importantList = await loadImportantSenders(user.id);

  // Skip-set: emails that ALREADY have an active (non-completed) task tied
  // to them. The user already triaged these — re-suggesting them in steps
  // 5+6 every run is noise. Completed tasks correctly don't block, because
  // completing a task flips the email's classification to DONE via the
  // tasks.updateTask hook, so it falls out of HIGH/MED_UNANSWERED naturally.
  const activeTaskedIds = new Set();
  try {
    const t = await pool.query(
      `SELECT DISTINCT source_message_id
         FROM tasks
        WHERE user_id = $1
          AND completed_at IS NULL
          AND source_message_id IS NOT NULL`,
      [user.id]
    );
    for (const row of t.rows) activeTaskedIds.add(row.source_message_id);
  } catch (err) {
    console.warn("[routine] active-task lookup failed:", err.message);
  }

  // Pull classifier rows for these messages.
  const ids = messages.map((m) => m.id);
  const cls = await pool.query(
    `SELECT message_id, category, urgency, short_reason
       FROM email_classifications
      WHERE user_id = $1 AND message_id = ANY($2::text[])`,
    [user.id, ids]
  );
  const clsMap = new Map();
  for (const row of cls.rows) clsMap.set(row.message_id, row);

  // Check thread state — has user replied? (Last msg has SENT label.)
  const repliedThreadIds = new Set();
  try {
    const creds = await loadGoogleCreds(user.id);
    if (creds) {
      const oauth = authedClientFromTokens(creds);
      const g = google.gmail({ version: "v1", auth: oauth });
      const threadIds = [...new Set(messages.map((m) => m.threadId).filter(Boolean))];
      const states = await Promise.all(
        threadIds.slice(0, 100).map((id) =>
          g.users.threads
            .get({ userId: "me", id, format: "minimal" })
            .then((r) => {
              const msgs = r.data.messages || [];
              const last = msgs[msgs.length - 1];
              return { id, userReplied: last && (last.labelIds || []).includes("SENT") };
            })
            .catch(() => null)
        )
      );
      for (const s of states) if (s?.userReplied) repliedThreadIds.add(s.id);
    }
  } catch (err) {
    console.warn("[routine] thread state check failed:", err.message);
  }

  function asThread(m, extras = {}) {
    const fromMatch = (m.from || "").match(/^(.*?)\s*<([^>]+)>\s*$/);
    return {
      messageId: m.id,
      threadId: m.threadId,
      sender: (fromMatch ? fromMatch[1] : m.from || "").replace(/^"|"$/g, "").trim(),
      senderEmail: fromMatch ? fromMatch[2] : (m.from || ""),
      subject: m.subject || "(no subject)",
      date: m.date || "",
      unread: m.unread,
      ...extras,
    };
  }

  // Bucket every message into the most appropriate step.
  // A message belongs to exactly one step — replied beats unanswered, etc.
  const buckets = {
    NEWSLETTER: [],
    AUTO: [],
    RECEIPT: [],
    REPLIED: [],
    HIGH_UNANSWERED: [],
    MED_UNANSWERED: [],
  };

  for (const m of messages) {
    if (repliedThreadIds.has(m.threadId)) {
      buckets.REPLIED.push(asThread(m));
      continue;
    }
    const c = clsMap.get(m.id);
    if (!c) continue;
    const cat = c.category;
    const urg = c.urgency;

    if (cat === "NEWSLETTER") { buckets.NEWSLETTER.push(asThread(m, { reason: c.short_reason })); continue; }
    if (cat === "AUTO")       { buckets.AUTO.push(asThread(m, { reason: c.short_reason })); continue; }
    if (cat === "RECEIPT")    { buckets.RECEIPT.push(asThread(m, { reason: c.short_reason })); continue; }

    // Anything that needs a reply → either VIP/urgent (step 5) or normal (step 6).
    const needsReply = cat === "URGENT" || cat === "REPLY_NEEDED" || cat === "TASK";
    if (!needsReply) continue;  // skip FYI/INTERNAL — nothing to do

    // Skip emails the user already added to To Do (active task exists).
    // Re-surfacing acknowledged work is noise.
    if (activeTaskedIds.has(m.id)) continue;

    const vip = isVipSender(m.from, importantList);
    const highUrgency = urg === "urgent" || urg === "today";
    if (vip || (cat === "URGENT" && highUrgency)) {
      buckets.HIGH_UNANSWERED.push(asThread(m, { reason: c.short_reason, urgency: urg, vip }));
    } else {
      buckets.MED_UNANSWERED.push(asThread(m, { reason: c.short_reason, urgency: urg }));
    }
  }

  // Assemble the ordered routine. Steps with no threads are skipped.
  const STEP_DEFS = [
    {
      key: "NEWSLETTER",
      title: "Newsletters & promotions",
      description: "Marketing senders. Unsubscribe to stop them at the source — or just archive.",
      action: "unsubscribe",
      actionLabel: "Unsubscribe & archive",
      altAction: "mark_done",
      altActionLabel: "Just archive",
    },
    {
      key: "AUTO",
      title: "Notifications & automated alerts",
      description: "Deploy alerts, sign-in notices, GitHub digests — safe to archive in bulk.",
      action: "mark_done",
      actionLabel: "Archive all selected",
    },
    {
      key: "RECEIPT",
      title: "Receipts & confirmations",
      description: "Invoices, payment confirmations, transactional emails — Gmail search keeps them findable.",
      action: "mark_done",
      actionLabel: "Archive all selected",
    },
    {
      key: "REPLIED",
      title: "Already replied — close the loop",
      description: "You've already responded in these threads. Marking done removes them from inbox.",
      action: "mark_done",
      actionLabel: "Mark done",
    },
    {
      key: "HIGH_UNANSWERED",
      title: "Important unanswered — add to your To Do",
      description: "Top-priority emails you haven't replied to yet (VIPs or urgent items). I'll add each to your Reply to list as Important + My Day.",
      action: "add_to_todo",
      actionLabel: "Add to To Do (Important)",
      important: true,
      listName: "Reply to",
    },
    {
      key: "MED_UNANSWERED",
      title: "Medium priority unanswered",
      description: "Other emails awaiting your reply. I'll add each to your Reply to list — no flags, just queued.",
      action: "add_to_todo",
      actionLabel: "Add to To Do",
      important: false,
      listName: "Reply to",
    },
  ];

  const steps = [];
  let stepNum = 1;
  for (const def of STEP_DEFS) {
    const threads = buckets[def.key];
    if (!threads || !threads.length) continue;
    steps.push({
      id: `step_${stepNum}`,
      step: stepNum++,
      key: def.key,
      title: def.title,
      description: def.description,
      action: def.action,
      actionLabel: def.actionLabel,
      altAction: def.altAction || null,
      altActionLabel: def.altActionLabel || null,
      important: !!def.important,
      listName: def.listName || null,
      threads: threads.slice(0, 25),
      totalThreads: threads.length,
      truncated: threads.length > 25,
    });
  }
  return steps;
}

module.exports = { chat, draftReply, buildContext, buildSystemPrompt, buildCleanupProposal, buildInboxRoutine, logBridgeCall, CHAT_MODEL, MODELS, resolveModel };
