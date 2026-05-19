// Style examples — pull past sent emails to a specific recipient so Delta
// can match the user's actual voice with that person.
// This is the "Found N writing examples" feature.

const { google } = require("googleapis");
const mime = require("./mime");

// Extracts a normalized email from "Name <email>"
function extractEmail(raw) {
  if (!raw) return "";
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).toLowerCase().trim();
}

// Search Sent folder for messages TO the given recipient.
// Returns an array of {id, subject, date, bodyText} sorted newest first,
// capped at maxResults.
async function findExamplesTo(authClient, recipientRaw, maxResults = 10) {
  const email = extractEmail(recipientRaw);
  if (!email) return { examples: [], recipient: "", totalFound: 0 };

  const gmail = google.gmail({ version: "v1", auth: authClient });
  let listData;
  try {
    listData = await gmail.users.messages.list({
      userId: "me",
      q: `to:${email} in:sent`,
      maxResults,
    });
  } catch (err) {
    console.warn("[style] list failed:", err.message);
    return { examples: [], recipient: email, totalFound: 0 };
  }

  const ids = (listData.data.messages || []).map((m) => m.id);
  if (!ids.length) return { examples: [], recipient: email, totalFound: 0 };

  // Fetch in parallel (max 10 — Gmail handles this fine)
  const fetches = ids.map((id) =>
    gmail.users.messages
      .get({ userId: "me", id, format: "full" })
      .then((r) => r.data)
      .catch(() => null)
  );
  const fetched = (await Promise.all(fetches)).filter(Boolean);

  // Sort newest first (Gmail order is usually newest-first already but be safe)
  fetched.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0));

  const examples = fetched.map((m) => {
    const headers = mime.headersToMap(m.payload?.headers || []);
    const body = mime.pickBody(m.payload);
    const text = (body.text || mime.htmlToText(body.html || "")).trim();
    // Drop quoted reply chains (lines starting with > or after "On ... wrote:")
    const cleaned = stripQuoted(text);
    return {
      id: m.id,
      subject: headers.subject || "",
      date: headers.date || "",
      bodyText: cleaned.slice(0, 2200),
    };
  });

  return {
    examples,
    recipient: email,
    totalFound: examples.length,
  };
}

function stripQuoted(text) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    // Stop at typical quoted-reply markers
    if (/^On .* wrote:\s*$/.test(line)) break;
    if (/^-----Original Message-----/i.test(line)) break;
    if (/^From: .*$/.test(line) && out.length > 5) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

// Format the examples block for the system prompt.
function formatExamples(examples) {
  if (!examples.length) return "";
  return examples
    .slice(0, 8)
    .map((e, i) => {
      const dateLabel = e.date ? ` (${new Date(e.date).toLocaleDateString()})` : "";
      return `### EXAMPLE ${i + 1}${dateLabel}
Subject: ${e.subject || "(no subject)"}
${e.bodyText}`;
    })
    .join("\n\n────\n\n");
}

// "high" / "medium" / "low" — used to label confidence in the UI.
function confidenceLabel(n) {
  if (n >= 5) return "high";
  if (n >= 1) return "medium";
  return "low";
}

module.exports = { findExamplesTo, formatExamples, confidenceLabel, extractEmail };
