// Delta Research — Phase 5.AO.
//
// Before draftReply generates a reply, we run a RESEARCH pass:
//   1. Normalize the subject (strip Re:/Fw:/Fwd:/[ext]/…)
//   2. Search the user's entire mailbox for threads on the same
//      subject (Gmail q= search with subject:"…")
//   3. Search for threads with the same participants discussing
//      related topics
//   4. Pull full bodies of the top N matches — these are the
//      authoritative source for any factual claims in the draft.
//   5. Extract text from PDF attachments on the open message
//      and on the most-recent related threads.
//   6. Bundle everything into a GROUNDING CONTEXT object that
//      draftReply injects into the system prompt with strict
//      anti-hallucination rules.
//
// The cost story: research adds ~$0.02-0.05 per draft (extra
// Gmail API calls + tokens). Worth it — the alternative is the
// model inventing facts to fill gaps it can't see.

const { google } = require("googleapis");
const { authedClientFromTokens } = require("./gmail");
const { loadGoogleCreds } = require("./auth");
const mime = require("./mime");
const backfill = require("./backfill");
const pdfParse = require("pdf-parse");

// How many related threads to pull (with full bodies) into the
// grounding context. 5 is a reasonable balance — covers ~the last
// few months of discussion on the topic without exploding the prompt.
const MAX_RELATED_THREADS = 5;
// Per-body cap so an unusually long thread doesn't crowd out others.
const PER_BODY_CHARS = 6000;
// Per-attachment cap. PDFs can be huge.
const PER_ATTACHMENT_CHARS = 8000;
// How many attachments to extract per call. Don't blindly parse all
// PDFs — some users get 20MB attachment chains.
const MAX_ATTACHMENTS = 5;
const MAX_PDF_BYTES = 8 * 1024 * 1024; // 8MB per file

// Strip Re:/Fw:/Fwd:/Aw:/Wg:/Rv: prefixes and external-marker tags.
// Returns the canonical subject for matching across thread variants.
function normalizeSubject(subject) {
  if (!subject) return "";
  let s = String(subject);
  // Loop because subjects like "Re: Fwd: Re: foo" need multiple passes.
  let prev;
  do {
    prev = s;
    s = s.replace(/^\s*(re|fw|fwd|aw|wg|rv|tr)[:：][\s]*/i, "");
    s = s.replace(/^\s*[\[\(]\s*ext(ernal)?\s*[\]\)][\s]*/i, "");
    s = s.replace(/^\s*\[[^\]]{1,40}\][\s]*/, ""); // arbitrary [TAG] prefixes
  } while (s !== prev);
  return s.trim();
}

// Cheap topic extractor — pull the longest content-word from the
// subject + the first sentence of the body. Used as a fallback search
// when subject-only returns nothing.
function extractTopicKeywords(message) {
  const subj = normalizeSubject(message.subject || "");
  const firstSentence = (message.bodyText || message.snippet || "")
    .split(/[.!?\n]/)[0]
    .slice(0, 200);
  const haystack = `${subj} ${firstSentence}`;
  const stopwords = new Set([
    "the", "and", "for", "with", "this", "that", "from", "have", "has",
    "will", "would", "could", "should", "about", "into", "your", "you",
    "are", "was", "were", "been", "their", "them", "they", "what", "when",
    "where", "which", "while", "after", "before", "more", "most", "some",
    "any", "all", "but", "not", "yes", "regarding", "thanks", "please",
    "hi", "hello", "dear",
  ]);
  const tokens = haystack
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stopwords.has(w));
  // Dedupe by frequency, keep top 4.
  const counts = {};
  for (const t of tokens) counts[t] = (counts[t] || 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([w]) => w);
}

// Search for messages with the same normalized subject. Uses Gmail's
// q= operator subject: which is forgiving about Re:/Fw: variants.
async function findBySubject(userId, normalizedSubject, { limit = 20, excludeMessageId = null } = {}) {
  if (!normalizedSubject || normalizedSubject.length < 3) return [];
  // Quote the subject so Gmail treats it as a phrase rather than
  // individual tokens. Wraps in inner double-quotes; Gmail handles
  // escaping inside subject: cleanly.
  const q = `subject:"${normalizedSubject.replace(/"/g, "")}"`;
  const rows = await backfill.searchInboxWithFallback(userId, q, { limit });
  return rows.filter((r) => r.message_id !== excludeMessageId);
}

// Fallback search by topic keywords (used when subject-search returns
// nothing — e.g. someone forwarded under a totally different subject).
async function findByTopicKeywords(userId, keywords, { limit = 10, excludeMessageId = null } = {}) {
  if (!keywords || !keywords.length) return [];
  // Build a Gmail q= with the top 2 keywords AND-joined. More than that
  // tends to over-constrain.
  const q = keywords.slice(0, 2).map((k) => `"${k}"`).join(" ");
  const rows = await backfill.searchInboxWithFallback(userId, q, { limit });
  return rows.filter((r) => r.message_id !== excludeMessageId);
}

// Fetch the full body of a message (text only, with quoted-original
// tail stripped). Caches nothing — caller is expected to batch.
async function fetchFullBody(g, messageId) {
  try {
    const r = await g.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const body = mime.pickBody(r.data.payload);
    let text = body.text || mime.htmlToText(body.html || "") || "";
    // Strip quoted-original-message tail.
    const cut = text.search(/\n(On .+ wrote:|-{3,} ?Original Message ?-{3,}|From: .+ Sent: )/);
    if (cut > 0) text = text.slice(0, cut).trim();
    return {
      message_id: messageId,
      thread_id: r.data.threadId || null,
      headers: mime.headersToMap(r.data.payload?.headers || []),
      bodyText: text.slice(0, PER_BODY_CHARS),
      attachments: body.attachments || [],
      internalDate: r.data.internalDate ? Number(r.data.internalDate) : null,
    };
  } catch (err) {
    console.warn(`[research.fetchFullBody] ${messageId} failed:`, err.message);
    return null;
  }
}

// Pull text from a PDF attachment. Returns "" on failure.
async function extractPdfText(g, messageId, attachmentId, sizeBytes) {
  if (sizeBytes > MAX_PDF_BYTES) {
    return `(PDF too large to parse: ${Math.round(sizeBytes / 1024 / 1024)}MB)`;
  }
  try {
    const r = await g.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });
    const b64 = (r.data.data || "").replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(b64, "base64");
    const result = await pdfParse(buf);
    const text = (result.text || "").trim();
    if (!text) return "(PDF appears empty or image-based — no extractable text)";
    return text.slice(0, PER_ATTACHMENT_CHARS);
  } catch (err) {
    console.warn(`[research.extractPdfText] ${messageId}/${attachmentId} failed:`, err.message);
    return "";
  }
}

// In-process cache for grounding contexts. Keyed by (userId, openMessageId).
// Each entry is { context, expiresAt }. Cleared after 10 min so a stale
// thread doesn't linger forever, and we cap at 50 entries (LRU-ish) so
// memory stays bounded.
const _groundingCache = new Map();
const GROUNDING_TTL_MS = 10 * 60 * 1000;
const GROUNDING_MAX_ENTRIES = 50;

function cacheKey(userId, openMessageId) {
  return `${userId}|${openMessageId}`;
}

function cacheGet(userId, openMessageId) {
  const k = cacheKey(userId, openMessageId);
  const entry = _groundingCache.get(k);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _groundingCache.delete(k);
    return null;
  }
  // LRU touch — re-insert so it moves to the end.
  _groundingCache.delete(k);
  _groundingCache.set(k, entry);
  return entry.context;
}

function cacheSet(userId, openMessageId, context) {
  const k = cacheKey(userId, openMessageId);
  _groundingCache.set(k, { context, expiresAt: Date.now() + GROUNDING_TTL_MS });
  // Evict oldest if over cap.
  if (_groundingCache.size > GROUNDING_MAX_ENTRIES) {
    const first = _groundingCache.keys().next().value;
    _groundingCache.delete(first);
  }
}

// Main entry-point. Gathers everything draftReply needs to make a
// well-grounded reply.
//
//   user: { id, email, display_name, ... }
//   openMessage: the message the user is replying to (with id, subject,
//                from, to, bodyText, threadId)
//
// Returns:
//   {
//     normalizedSubject,
//     relatedThreads: [{ message_id, thread_id, from, subject, date,
//                        bodyText, snippet }],
//     attachments:    [{ message_id, filename, mime, sizeBytes,
//                        textContent }],
//     keywords:       [...],
//     stats: { relatedSearched, relatedKept, attachmentsParsed }
//   }
//
// Best-effort: never throws. Returns empty arrays on any sub-failure.
async function gatherGroundingContext(user, openMessage) {
  const out = {
    normalizedSubject: "",
    relatedThreads: [],
    attachments: [],
    keywords: [],
    stats: { relatedSearched: 0, relatedKept: 0, attachmentsParsed: 0 },
  };
  if (!user?.id || !openMessage) return out;

  // Cache hit? Re-drafts of the same email shouldn't re-run a 2-5s
  // research pass. Cache for 10 min.
  if (openMessage.id) {
    const cached = cacheGet(user.id, openMessage.id);
    if (cached) {
      cached.stats = { ...(cached.stats || {}), fromCache: true };
      return cached;
    }
  }

  const normSubj = normalizeSubject(openMessage.subject);
  out.normalizedSubject = normSubj;
  const keywords = extractTopicKeywords(openMessage);
  out.keywords = keywords;

  // 1. Find related threads by subject; fall back to topic keywords.
  let candidates = [];
  if (normSubj.length >= 3) {
    candidates = await findBySubject(user.id, normSubj, {
      limit: 20,
      excludeMessageId: openMessage.id,
    });
  }
  if (candidates.length < 3 && keywords.length) {
    const topicHits = await findByTopicKeywords(user.id, keywords, {
      limit: 10,
      excludeMessageId: openMessage.id,
    });
    // Dedupe by message_id.
    const seen = new Set(candidates.map((c) => c.message_id));
    for (const t of topicHits) {
      if (!seen.has(t.message_id)) {
        candidates.push(t);
        seen.add(t.message_id);
      }
    }
  }
  out.stats.relatedSearched = candidates.length;

  // 2. Sort by recency (most recent first) and keep top N.
  candidates.sort((a, b) => {
    const aD = Number(a.internal_date || 0);
    const bD = Number(b.internal_date || 0);
    return bD - aD;
  });
  const top = candidates.slice(0, MAX_RELATED_THREADS);

  // 3. Fetch full bodies of the top N + collect attachments on each.
  const creds = await loadGoogleCreds(user.id);
  if (!creds) return out;
  const oauth = authedClientFromTokens(creds);
  const g = google.gmail({ version: "v1", auth: oauth });

  const fetched = await Promise.all(top.map((c) => fetchFullBody(g, c.message_id)));

  for (let i = 0; i < fetched.length; i++) {
    const f = fetched[i];
    if (!f) continue;
    const headers = f.headers;
    out.relatedThreads.push({
      message_id: f.message_id,
      thread_id: f.thread_id,
      from: headers.from || top[i].from_email || "",
      subject: headers.subject || top[i].subject || "",
      date: headers.date || (f.internalDate ? new Date(f.internalDate).toUTCString() : ""),
      bodyText: f.bodyText,
      snippet: top[i].snippet || "",
    });
  }
  out.stats.relatedKept = out.relatedThreads.length;

  // 4. Attachments — fetch from open message + related threads.
  const attachmentSources = [];
  // Open message attachments first.
  if (Array.isArray(openMessage.attachments) && openMessage.attachments.length) {
    for (const att of openMessage.attachments) {
      attachmentSources.push({ source: "open", message_id: openMessage.id, ...att });
    }
  } else {
    // If the openMessage we got didn't carry attachments, fetch its
    // attachment list directly.
    const fullOpen = await fetchFullBody(g, openMessage.id);
    if (fullOpen?.attachments?.length) {
      for (const att of fullOpen.attachments) {
        attachmentSources.push({ source: "open", message_id: openMessage.id, ...att });
      }
    }
  }
  for (const f of fetched) {
    if (!f?.attachments) continue;
    for (const att of f.attachments) {
      attachmentSources.push({ source: "related", message_id: f.message_id, ...att });
    }
  }

  // 5. Extract PDF text. Other types: just list metadata so Delta knows
  // they exist (image / DOCX / XLSX without inline parsers).
  const pdfsToParse = attachmentSources
    .filter((a) => a.mimeType && a.mimeType.includes("pdf") && a.attachmentId)
    .slice(0, MAX_ATTACHMENTS);
  const pdfTexts = await Promise.all(
    pdfsToParse.map((a) => extractPdfText(g, a.message_id, a.attachmentId, a.size || 0))
  );

  for (let i = 0; i < pdfsToParse.length; i++) {
    const a = pdfsToParse[i];
    out.attachments.push({
      message_id: a.message_id,
      source: a.source,
      filename: a.filename || "(unnamed.pdf)",
      mime: a.mimeType,
      sizeBytes: a.size || 0,
      textContent: pdfTexts[i] || "",
      parsed: !!pdfTexts[i],
    });
    if (pdfTexts[i]) out.stats.attachmentsParsed++;
  }

  // Non-PDF attachments — list metadata only.
  for (const a of attachmentSources) {
    if (a.mimeType && a.mimeType.includes("pdf")) continue;
    out.attachments.push({
      message_id: a.message_id,
      source: a.source,
      filename: a.filename || "(unnamed)",
      mime: a.mimeType || "(unknown)",
      sizeBytes: a.size || 0,
      textContent: "",
      parsed: false,
      note: `Attachment not parsed (type: ${a.mimeType || "unknown"}) — Delta cannot read its content.`,
    });
  }

  // Cache for subsequent re-drafts of the same email.
  if (openMessage.id) {
    cacheSet(user.id, openMessage.id, out);
  }
  return out;
}

// Format the grounding context block for injection into the system
// prompt. Strict structure so the model can refer to specific sources
// when grounding individual claims.
function formatGroundingForPrompt(ctx) {
  const lines = [];
  lines.push("═══════════════════════════════════════════════════════════════════════");
  lines.push("RESEARCH / GROUNDING CONTEXT");
  lines.push("═══════════════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push("Before drafting, Delta searched the user's full mailbox for related");
  lines.push("discussions and extracted text from attachments. Use these — and ONLY");
  lines.push("these (plus the OPEN EMAIL and KNOWN MEMORIES sections) — as the");
  lines.push("authoritative source for ALL factual claims in the draft.");
  lines.push("");
  lines.push(`Normalized subject: "${ctx.normalizedSubject || "(none)"}"`);
  lines.push(`Topic keywords:     ${ctx.keywords?.join(", ") || "(none)"}`);
  lines.push(`Related threads:    ${ctx.stats?.relatedKept || 0} of ${ctx.stats?.relatedSearched || 0} candidates kept`);
  lines.push(`Attachments parsed: ${ctx.stats?.attachmentsParsed || 0}`);
  lines.push("");

  if (ctx.relatedThreads?.length) {
    lines.push("--- RELATED-THREAD EXCERPTS (most recent first) ---");
    lines.push("");
    ctx.relatedThreads.forEach((t, i) => {
      lines.push(`[RT-${i + 1}] id=${t.message_id}`);
      lines.push(`        from: ${t.from}`);
      lines.push(`     subject: ${t.subject}`);
      lines.push(`        date: ${t.date}`);
      lines.push(`        body:`);
      const indented = (t.bodyText || "").split("\n").map((l) => `          | ${l}`).join("\n");
      lines.push(indented);
      lines.push("");
    });
  } else {
    lines.push("(no related-thread matches found)");
    lines.push("");
  }

  if (ctx.attachments?.length) {
    lines.push("--- ATTACHMENT CONTENT ---");
    lines.push("");
    ctx.attachments.forEach((a, i) => {
      lines.push(`[ATT-${i + 1}] ${a.filename} (${a.mime}, ${Math.round(a.sizeBytes / 1024) || "?"} KB, from ${a.source} message)`);
      if (a.parsed && a.textContent) {
        const indented = a.textContent.split("\n").map((l) => `        | ${l}`).join("\n");
        lines.push(indented);
      } else if (a.note) {
        lines.push(`        | ${a.note}`);
      } else {
        lines.push("        | (no extractable content)");
      }
      lines.push("");
    });
  }

  return lines.join("\n");
}

module.exports = {
  normalizeSubject,
  extractTopicKeywords,
  findBySubject,
  findByTopicKeywords,
  fetchFullBody,
  extractPdfText,
  gatherGroundingContext,
  formatGroundingForPrompt,
};
