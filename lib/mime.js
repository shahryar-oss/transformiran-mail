// Gmail MIME helpers — extract the readable body from a Gmail message payload.
// Gmail's API returns a nested `payload` tree. We walk it and pull the best
// renderable part: text/html if present, otherwise text/plain.

function base64UrlDecode(b64url) {
  if (!b64url) return "";
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf-8");
}

// Walk payload tree depth-first. For each leaf part, group by mimeType.
function collectParts(payload) {
  const out = [];
  function visit(p) {
    if (!p) return;
    if (Array.isArray(p.parts) && p.parts.length) {
      p.parts.forEach(visit);
      return;
    }
    // Leaf node — has a body or empty body
    if (p.mimeType && p.body && p.body.data) {
      out.push({
        mimeType: p.mimeType,
        filename: p.filename || "",
        size: p.body.size || 0,
        partId: p.partId,
        data: base64UrlDecode(p.body.data),
        headers: p.headers || [],
        contentId: getContentId(p.headers),
        contentDisposition: getHeader(p.headers, "content-disposition"),
      });
    } else if (p.mimeType && p.body && p.body.attachmentId) {
      // Attachment — no inline data, would need a separate fetch.
      out.push({
        mimeType: p.mimeType,
        filename: p.filename || "",
        size: p.body.size || 0,
        partId: p.partId,
        attachmentId: p.body.attachmentId,
        headers: p.headers || [],
        contentId: getContentId(p.headers),
        contentDisposition: getHeader(p.headers, "content-disposition"),
      });
    }
  }
  visit(payload);
  return out;
}

function getHeader(headers, name) {
  if (!Array.isArray(headers)) return "";
  const n = name.toLowerCase();
  for (const h of headers) {
    if (h && h.name && h.name.toLowerCase() === n) return h.value || "";
  }
  return "";
}

function getContentId(headers) {
  const raw = getHeader(headers, "content-id");
  if (!raw) return "";
  // Content-ID is typically '<abc@example.com>' — strip the angle brackets.
  return raw.replace(/^[<\s]+|[>\s]+$/g, "");
}

function pickBody(payload) {
  if (!payload) return { html: "", text: "", attachments: [], inlineImages: [] };

  // Single-part message (no nested parts) — body is right on the payload.
  if (payload.body && payload.body.data && !payload.parts) {
    const decoded = base64UrlDecode(payload.body.data);
    if (payload.mimeType === "text/html") {
      return { html: decoded, text: "", attachments: [], inlineImages: [] };
    }
    return { html: "", text: decoded, attachments: [], inlineImages: [] };
  }

  const parts = collectParts(payload);
  let html = "";
  let text = "";
  const attachments = [];
  const inlineImages = [];

  for (const part of parts) {
    const isImage = /^image\//i.test(part.mimeType || "");
    const isInline = part.contentId ||
      /^inline\b/i.test(part.contentDisposition || "");

    if (part.attachmentId) {
      if (isImage && isInline) {
        // Inline image (often a signature logo) — needs a separate fetch
        // but we should NOT show it in the attachments tray.
        inlineImages.push({
          mimeType: part.mimeType,
          filename: part.filename,
          attachmentId: part.attachmentId,
          contentId: part.contentId,
          partId: part.partId,
        });
      } else {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType,
          size: part.size,
          attachmentId: part.attachmentId,
          partId: part.partId,
        });
      }
      continue;
    }
    // Inline data parts (small images embedded directly with base64 data).
    if (isImage && isInline && part.data) {
      inlineImages.push({
        mimeType: part.mimeType,
        filename: part.filename,
        contentId: part.contentId,
        inlineData: part.data,   // already base64-decoded raw bytes
        partId: part.partId,
      });
      continue;
    }
    // Text variants
    if (part.mimeType === "text/html" && !html) html = part.data;
    else if (part.mimeType === "text/plain" && !text) text = part.data;
  }

  return { html, text, attachments, inlineImages };
}

// Headers come as [{ name, value }, ...] — turn into a lowercase-keyed object.
function headersToMap(headers) {
  const out = {};
  for (const h of headers || []) {
    if (!h || !h.name) continue;
    out[h.name.toLowerCase()] = h.value;
  }
  return out;
}

// Strip the most obvious script/iframe/object elements and inline event
// handlers. Not perfect — the rendering iframe also has sandbox="" so
// scripts cannot execute even if a few sneak through.
function sanitizeHtml(html) {
  if (!html) return "";
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, (m) => m) // keep style for layout
    .replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "")
    .replace(/<object\b[\s\S]*?<\/object\s*>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "blocked:");
}

// Plain-text version of an HTML body — used as Delta context (HTML in a
// system prompt wastes tokens and confuses the model).
function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { pickBody, headersToMap, sanitizeHtml, htmlToText, base64UrlDecode };
