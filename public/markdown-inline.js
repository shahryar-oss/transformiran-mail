// =============================================================
// MARKDOWN SHORTCUTS — lightweight, intentionally small parser.
//
// Used in two places:
//   • Composer "send" path: if the user has Compose →
//     "Markdown shortcuts" enabled, we walk the draft body
//     before sending and convert inline patterns to HTML.
//   • Plain-text helpers / preview tools.
//
// Scope is intentionally conservative — we only support
// patterns we've validated render correctly in Gmail / Outlook
// / Apple Mail web previews:
//   **bold**   __bold__       → <strong>
//   *italic*   _italic_       → <em>
//   `inline code`              → <code>
//   ~~strike~~                 → <del>
//   [label](https://url)       → <a href>
//   bare https://… URL         → <a href>
//   # / ## / ### at line start → <h1/2/3>     (block)
//   - / * line                 → <ul><li>     (block)
//   1. line                    → <ol><li>     (block)
//
// We deliberately DO NOT support: tables, blockquotes (clashes
// with reply quoting), images, fenced code blocks. If any of
// those becomes a customer ask we'll ship it explicitly, not
// promise it here.
//
// Cross-page: the same function powers any future preview
// (e.g. snippets). Always returns valid sanitized HTML — no
// raw < > injection — see escapeHtml() below.
// =============================================================
(function () {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  // Escapes special markdown chars inside an already-extracted token
  // so we don't double-process them.
  function safeUrl(href) {
    const h = String(href || "").trim();
    // Allow http(s), mailto, tel. Reject javascript:, data:, vbscript:.
    if (/^(https?:|mailto:|tel:)/i.test(h)) return h;
    return null;
  }

  // ----- INLINE PASS ---------------------------------------
  // Takes plain text (already HTML-escaped) and returns HTML
  // with inline markdown converted. Run after escapeHtml().
  function inline(html) {
    let s = html;

    // [label](url) — only http(s)/mailto.
    s = s.replace(
      /\[([^\]\n]+?)\]\(([^)\s]+?)\)/g,
      (_m, label, href) => {
        const safe = safeUrl(href);
        if (!safe) return _m;
        return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener">${label}</a>`;
      }
    );

    // Bare URLs (only if not already inside an anchor tag).
    s = s.replace(
      /(^|[\s(>])(https?:\/\/[^\s<)]+)/g,
      (_m, lead, url) => {
        const safe = safeUrl(url);
        if (!safe) return _m;
        return `${lead}<a href="${escapeHtml(safe)}" target="_blank" rel="noopener">${escapeHtml(safe)}</a>`;
      }
    );

    // Inline code `…` — process before bold/italic so backticks win.
    s = s.replace(/`([^`\n]+?)`/g, (_m, body) => `<code>${body}</code>`);

    // Strikethrough ~~…~~
    s = s.replace(/~~([^~\n]+?)~~/g, (_m, body) => `<del>${body}</del>`);

    // Bold **…** and __…__ — non-greedy, must not span line breaks.
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, (_m, body) => `<strong>${body}</strong>`);
    s = s.replace(/__([^_\n]+?)__/g, (_m, body) => `<strong>${body}</strong>`);

    // Italic *…* and _…_ — require non-space adjacent chars to avoid
    // matching bullet lines ("- *foo") or random asterisks.
    s = s.replace(/(^|[\s(])\*(\S(?:[^*\n]*?\S)?)\*(?=$|[\s.,;:!?)])/g,
      (_m, lead, body) => `${lead}<em>${body}</em>`);
    s = s.replace(/(^|[\s(])_(\S(?:[^_\n]*?\S)?)_(?=$|[\s.,;:!?)])/g,
      (_m, lead, body) => `${lead}<em>${body}</em>`);

    return s;
  }

  // ----- BLOCK PASS ----------------------------------------
  // Operates on text lines, groups consecutive list items, and
  // wraps headings.
  function block(text) {
    const lines = String(text || "").split(/\n/);
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const trimmed = raw.replace(/\s+$/, "");

      // Heading
      const h = /^(#{1,3})\s+(.*)$/.exec(trimmed);
      if (h) {
        const level = h[1].length;
        out.push(`<h${level}>${inline(escapeHtml(h[2]))}</h${level}>`);
        i++;
        continue;
      }

      // Unordered list
      if (/^\s*[-*]\s+\S/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+\S/.test(lines[i])) {
          const item = lines[i].replace(/^\s*[-*]\s+/, "");
          items.push(`<li>${inline(escapeHtml(item))}</li>`);
          i++;
        }
        out.push(`<ul>${items.join("")}</ul>`);
        continue;
      }

      // Ordered list (1. 2. 3.)
      if (/^\s*\d+\.\s+\S/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+\S/.test(lines[i])) {
          const item = lines[i].replace(/^\s*\d+\.\s+/, "");
          items.push(`<li>${inline(escapeHtml(item))}</li>`);
          i++;
        }
        out.push(`<ol>${items.join("")}</ol>`);
        continue;
      }

      // Plain line — emit as text (no extra wrapping; the composer
      // already has <div> per line in contenteditable). Use <br> on
      // empty lines for visual spacing.
      if (trimmed === "") {
        out.push("<br>");
      } else {
        out.push(inline(escapeHtml(trimmed)));
      }
      i++;
    }
    return out.join("\n");
  }

  // ----- PUBLIC: full text → HTML --------------------------
  // For previews / snippets where you have a plain string and
  // want sanitized HTML.
  function toHtml(text) {
    return block(text);
  }

  // ----- PUBLIC: in-place composer conversion --------------
  // Walks the composer body, converts markdown patterns in the
  // user-typed prose, leaves quoted history (gmail_quote /
  // <blockquote>) untouched. Returns true if it changed anything.
  function applyInPlace(rootEl) {
    if (!rootEl) return false;
    let changed = false;

    // Find the boundary: the first quote container, if any.
    // Everything BEFORE this node is treated as the user's draft.
    const quoteEl = rootEl.querySelector(".gmail_quote, blockquote");
    const userZone = document.createDocumentFragment();
    const quotedZone = [];

    // Snapshot children — splitting at the quoteEl boundary.
    const children = Array.from(rootEl.childNodes);
    let pastQuote = false;
    for (const node of children) {
      if (!pastQuote && node === quoteEl) pastQuote = true;
      if (pastQuote) quotedZone.push(node);
      else userZone.appendChild(node.cloneNode(true));
    }
    if (!userZone.childNodes.length) return false;

    // Extract plain-text of user zone with line breaks per child.
    const buf = [];
    function walk(node) {
      if (node.nodeType === 3) { buf.push(node.nodeValue); return; }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (tag === "br") { buf.push("\n"); return; }
      // Block-ish elements add a line break boundary.
      const isBlock = /^(div|p|ul|ol|li|h[1-6])$/.test(tag);
      if (isBlock && buf.length && !buf[buf.length - 1].endsWith("\n")) buf.push("\n");
      for (const child of node.childNodes) walk(child);
      if (isBlock && !buf[buf.length - 1]?.endsWith("\n")) buf.push("\n");
    }
    userZone.childNodes.forEach(walk);
    const sourceText = buf.join("").replace(/\n{3,}/g, "\n\n").trim();

    if (!sourceText) return false;
    // Only apply if there's at least one markdown pattern to convert.
    if (!/(\*\*|__|`|~~|\[[^\]]+\]\(https?:|^#{1,3}\s|^\s*[-*]\s|^\s*\d+\.\s|(?:^|\s)\*\S|(?:^|\s)_\S)/m.test(sourceText)) {
      return false;
    }

    const html = toHtml(sourceText);

    // Replace user zone in place: remove originals, insert HTML before quotedZone.
    const replacement = document.createElement("div");
    replacement.innerHTML = html;
    // Wipe old user nodes (everything before quoteEl).
    let cursor = rootEl.firstChild;
    while (cursor && cursor !== quoteEl) {
      const next = cursor.nextSibling;
      rootEl.removeChild(cursor);
      cursor = next;
    }
    // Insert new nodes before quote (or at start if no quote).
    const newNodes = Array.from(replacement.childNodes);
    if (quoteEl) {
      for (const n of newNodes) rootEl.insertBefore(n, quoteEl);
    } else {
      for (const n of newNodes) rootEl.appendChild(n);
    }
    changed = newNodes.length > 0;
    return changed;
  }

  window.NexaMarkdown = { toHtml, applyInPlace, _inline: inline };
})();
