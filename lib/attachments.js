// ============================================================================
// lib/attachments.js  —  Phase 5.AY
//
// Lets Delta READ attachments inside an email — PDFs, Word docs, Excel
// sheets, plain text. Without this, Delta could see "Pia attached
// clockify-april-2026.pdf" but couldn't tell you what was inside.
//
// File-type routing:
//   .pdf                   → pdf-parse        (text + tables flattened)
//   .docx                  → mammoth          (Word, text-only)
//   .xlsx / .xls / .csv    → xlsx (SheetJS)   (every sheet → CSV-ish text)
//   .txt / .md / .json     → utf-8 decode
//   .pages/.numbers/.key   → graceful "Apple iWork — export to PDF first"
//   anything else          → graceful "(unsupported file type — N bytes)"
//
// Hard caps to keep one over-eager request from melting the Claude
// context window: 5 MB per attachment fetched, 15 KB of extracted text
// per attachment, and we never parse more than 4 attachments in one
// call (Delta can re-invoke with specific filenames if it needs more).
// ============================================================================

const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const XLSX = require("xlsx");
const { google } = require("googleapis");

const { authedClientFromTokens } = require("./gmail");
const { loadGoogleCreds } = require("./auth");

const MAX_FETCH_BYTES = 5 * 1024 * 1024;      // 5 MB per file
const MAX_TEXT_CHARS = 15_000;                // 15 KB of extracted text per file
const MAX_ATTACHMENTS_PER_CALL = 4;
const MAX_XLSX_ROWS_PER_SHEET = 200;

function pickParser(filename = "", mime = "") {
  const lower = (filename || "").toLowerCase();
  const m = (mime || "").toLowerCase();
  // Order matters — check extension first (Gmail's mime types are
  // sometimes "application/octet-stream" for attachments).
  if (lower.endsWith(".pdf") || m.includes("pdf")) return "pdf";
  if (lower.endsWith(".docx") || m.includes("wordprocessingml")) return "docx";
  if (lower.endsWith(".doc") || m === "application/msword") return "doc-legacy";
  if (
    lower.endsWith(".xlsx") || lower.endsWith(".xls") ||
    lower.endsWith(".xlsm") || m.includes("spreadsheetml") ||
    m === "application/vnd.ms-excel"
  ) return "xlsx";
  if (lower.endsWith(".csv") || m === "text/csv") return "csv";
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".log") || m.startsWith("text/")) return "text";
  if (lower.endsWith(".json") || m.includes("/json")) return "text";
  if (lower.endsWith(".pages") || lower.endsWith(".numbers") || lower.endsWith(".key") || lower.endsWith(".keynote")) return "iwork";
  if (lower.endsWith(".pptx") || m.includes("presentationml")) return "pptx";
  return "unknown";
}

async function parsePdf(buf) {
  const result = await pdfParse(buf);
  const text = (result.text || "").trim();
  if (!text) return "(PDF appears empty or image-only — no extractable text. If it's a scanned image, ask Shahryar to OCR it first.)";
  return text;
}

async function parseDocx(buf) {
  const result = await mammoth.extractRawText({ buffer: buf });
  const text = (result.value || "").trim();
  if (!text) return "(Word doc appears empty.)";
  return text;
}

function parseXlsx(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const parts = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    // CSV-ish text with proper escaping. Trim to MAX rows per sheet.
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    const lines = csv.split("\n");
    const truncated = lines.length > MAX_XLSX_ROWS_PER_SHEET;
    const slice = lines.slice(0, MAX_XLSX_ROWS_PER_SHEET).join("\n");
    parts.push(
      `# Sheet: ${sheetName}` +
      (truncated ? ` (showing first ${MAX_XLSX_ROWS_PER_SHEET} of ${lines.length} rows)` : "") +
      `\n${slice}`
    );
  }
  if (!parts.length) return "(Workbook has no readable sheets.)";
  return parts.join("\n\n");
}

function parseCsv(buf) {
  const text = buf.toString("utf-8").trim();
  return text || "(CSV is empty.)";
}

function parseText(buf) {
  const text = buf.toString("utf-8").trim();
  return text || "(File is empty.)";
}

// Fetch one attachment's bytes from Gmail. Returns null on failure.
async function fetchAttachmentBytes(g, messageId, attachmentId, sizeBytes) {
  if (sizeBytes && sizeBytes > MAX_FETCH_BYTES) {
    return { skipped: true, reason: `file too large (${Math.round(sizeBytes / 1024 / 1024)}MB > ${MAX_FETCH_BYTES / 1024 / 1024}MB cap)` };
  }
  try {
    const r = await g.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });
    const b64 = (r.data.data || "").replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(b64, "base64");
    return { buf };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Main entry: read attachments on a given Gmail message.
//
//   userId         - id (so we can load their google creds)
//   messageId      - the gmail message id
//   attachments    - array from the message payload, shape:
//                    [{ filename, mime, attachmentId, sizeBytes }]
//   wanted         - optional array of filenames (case-insensitive
//                    substring match) the caller wants. If empty, read
//                    all up to MAX_ATTACHMENTS_PER_CALL.
//
// Returns:
//   { ok: true, attachments: [{
//       filename, mime, sizeBytes, kind,
//       textContent,            // up to MAX_TEXT_CHARS chars, or null
//       truncated,              // true if text was cut to MAX_TEXT_CHARS
//       error                   // string if parse failed
//   }] }
// ---------------------------------------------------------------------------
async function readAttachments({ userId, messageId, attachments, wanted = [] }) {
  if (!userId || !messageId || !Array.isArray(attachments)) {
    return { ok: false, error: "userId / messageId / attachments required" };
  }
  if (!attachments.length) {
    return { ok: true, attachments: [], note: "Message has no attachments." };
  }

  // Filter by filename if the caller specified some.
  let list = attachments;
  if (Array.isArray(wanted) && wanted.length) {
    const needles = wanted.map((w) => String(w).toLowerCase());
    list = attachments.filter((a) =>
      needles.some((n) => (a.filename || "").toLowerCase().includes(n))
    );
    if (!list.length) {
      return {
        ok: true,
        attachments: [],
        note: `No attachments matched ${JSON.stringify(wanted)}. Available: ${attachments.map((a) => a.filename).join(", ")}`,
      };
    }
  }
  list = list.slice(0, MAX_ATTACHMENTS_PER_CALL);

  const creds = await loadGoogleCreds(userId);
  if (!creds) return { ok: false, error: "no_google_creds" };
  const oauth = authedClientFromTokens(creds);
  const g = google.gmail({ version: "v1", auth: oauth });

  const out = [];
  for (const att of list) {
    const kind = pickParser(att.filename, att.mime);
    const base = {
      filename: att.filename || "(unnamed)",
      mime: att.mime || "application/octet-stream",
      sizeBytes: att.sizeBytes || 0,
      kind,
      textContent: null,
      truncated: false,
      error: null,
    };

    if (kind === "unknown") {
      base.error = `Unsupported file type (${att.mime || att.filename || "unknown"}).`;
      out.push(base);
      continue;
    }
    if (kind === "iwork") {
      base.error = "Apple iWork file (Pages/Numbers/Keynote) — please export to PDF or DOCX/XLSX first. iWork's internal format isn't text-readable.";
      out.push(base);
      continue;
    }
    if (kind === "doc-legacy") {
      base.error = "Legacy Word .doc format — please ask the sender to resend as .docx. Old .doc binary isn't text-readable here.";
      out.push(base);
      continue;
    }
    if (kind === "pptx") {
      base.error = "PowerPoint .pptx not yet supported — export to PDF for now.";
      out.push(base);
      continue;
    }

    const fetched = await fetchAttachmentBytes(g, messageId, att.attachmentId, att.sizeBytes);
    if (fetched.skipped) {
      base.error = fetched.reason;
      out.push(base);
      continue;
    }
    if (fetched.error || !fetched.buf) {
      base.error = `Fetch failed: ${fetched.error || "no bytes"}`;
      out.push(base);
      continue;
    }

    try {
      let text = "";
      if (kind === "pdf")   text = await parsePdf(fetched.buf);
      if (kind === "docx")  text = await parseDocx(fetched.buf);
      if (kind === "xlsx")  text = parseXlsx(fetched.buf);
      if (kind === "csv")   text = parseCsv(fetched.buf);
      if (kind === "text")  text = parseText(fetched.buf);

      if (text.length > MAX_TEXT_CHARS) {
        base.textContent = text.slice(0, MAX_TEXT_CHARS);
        base.truncated = true;
      } else {
        base.textContent = text;
      }
    } catch (err) {
      base.error = `Parse failed: ${err.message || String(err)}`;
    }
    out.push(base);
  }

  return { ok: true, attachments: out };
}

module.exports = {
  readAttachments,
  pickParser,
  MAX_TEXT_CHARS,
  MAX_ATTACHMENTS_PER_CALL,
};
