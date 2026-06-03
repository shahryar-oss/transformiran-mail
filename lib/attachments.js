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
  // pdf-parse v2 dropped the old default-function API in favour of a
  // `PDFParse` class — calling pdfParse(buf) throws "pdfParse is not a
  // function". Support BOTH shapes so a version bump can't silently break
  // PDF reading again (this also powers read_attachments for emails).
  let text = "";
  if (pdfParse && typeof pdfParse.PDFParse === "function") {
    // v2: new PDFParse({ data: buf }).getText() → { text }
    const parser = new pdfParse.PDFParse({ data: buf });
    try {
      const result = await parser.getText();
      text = (result && result.text ? result.text : "").trim();
    } finally {
      try { if (parser && parser.destroy) await parser.destroy(); } catch (_) {}
    }
  } else if (typeof pdfParse === "function") {
    // v1: default async function
    const result = await pdfParse(buf);
    text = (result && result.text ? result.text : "").trim();
  } else {
    throw new Error("pdf-parse module shape unrecognized");
  }
  // pdf-parse v2 emits "-- 1 of 2 --" page separators even when a page has
  // NO real text (scanned / image-only PDF). Strip those + whitespace to
  // judge whether there's ACTUAL content; if essentially nothing remains,
  // report empty so callers fall back to reading the PDF as page images.
  const stripped = text.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, " ").replace(/\s+/g, " ").trim();
  if (stripped.length < 8) {
    return "(PDF appears empty or image-only — no extractable text. If it's a scanned image, ask Shahryar to OCR it first.)";
  }
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

// Phase 5.BU — parse an already-fetched buffer (e.g. from Slack files.info)
// using the same per-mime routing the email path uses. Returns the same
// shape as readAttachments() entries.
async function parseBuffer(buf, { filename = "", mime = "" } = {}) {
  const base = {
    filename: filename || "(unnamed)",
    mime: mime || "application/octet-stream",
    sizeBytes: buf?.length || 0,
    kind: pickParser(filename, mime),
    textContent: null,
    truncated: false,
    error: null,
  };
  if (!buf || !buf.length) {
    base.error = "Empty buffer";
    return base;
  }
  if (base.kind === "unknown") { base.error = `Unsupported file type (${mime || filename}).`;        return base; }
  if (base.kind === "iwork")   { base.error = "Apple iWork — please export to PDF/DOCX/XLSX first."; return base; }
  if (base.kind === "doc-legacy") { base.error = "Legacy .doc binary — ask sender to resend as .docx."; return base; }
  if (base.kind === "pptx")    { base.error = "PowerPoint .pptx not yet supported — export to PDF."; return base; }
  try {
    let text = "";
    if (base.kind === "pdf")  text = await parsePdf(buf);
    if (base.kind === "docx") text = await parseDocx(buf);
    if (base.kind === "xlsx") text = parseXlsx(buf);
    if (base.kind === "csv")  text = parseCsv(buf);
    if (base.kind === "text") text = parseText(buf);
    if (text.length > MAX_TEXT_CHARS) {
      base.textContent = text.slice(0, MAX_TEXT_CHARS);
      base.truncated = true;
    } else {
      base.textContent = text;
    }
  } catch (err) {
    base.error = `Parse failed: ${err.message || String(err)}`;
  }
  return base;
}

// Render a PDF's pages to PNG images (base64) so a SCANNED / image-only
// PDF (no extractable text) can be read by Claude's vision instead. Uses
// pdf-parse v2's getScreenshot() (bundled rasteriser — no extra deps).
// Capped at `maxPages` to bound vision tokens + payload. Returns
// [{ mediaType, dataB64 }]; empty array on any failure (caller degrades).
async function renderPdfPages(buf, { maxPages = 5, scale = 2 } = {}) {
  try {
    if (!pdfParse || typeof pdfParse.PDFParse !== "function") return [];
    const parser = new pdfParse.PDFParse({ data: buf });
    try {
      let r;
      try { r = await parser.getScreenshot({ scale }); }
      catch (_) { r = await parser.getScreenshot(); } // ignore unknown opts
      const pages = (r && Array.isArray(r.pages)) ? r.pages.slice(0, maxPages) : [];
      return pages.map((p) => {
        let b64 = "";
        if (p.dataUrl && p.dataUrl.includes(",")) b64 = p.dataUrl.split(",")[1];
        else if (p.data) b64 = Buffer.from(p.data).toString("base64");
        return { mediaType: "image/png", dataB64: b64 };
      }).filter((x) => x.dataB64);
    } finally {
      try { if (parser && parser.destroy) await parser.destroy(); } catch (_) {}
    }
  } catch (_) {
    return [];
  }
}

module.exports = {
  readAttachments,
  parseBuffer,
  renderPdfPages,
  pickParser,
  MAX_TEXT_CHARS,
  MAX_ATTACHMENTS_PER_CALL,
};
