// Calendar page — month grid + sidebar agenda + create/edit/delete events.
// Talks to /api/calendar/* which wraps Google Calendar.

(() => {
  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  // Date helpers — first-day-of-week = Monday (matches Outlook screenshot).
  function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function endOfMonth(d)   { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function addMonths(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth() + n, 1);
    return x;
  }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  // Monday=0, Sunday=6 — matches our DOW labels above.
  function dowMon(d) { const w = d.getDay(); return (w + 6) % 7; }

  // ---------- state ----------
  const state = {
    cursor: startOfMonth(new Date()),     // first day of current displayed month
    selectedDate: startOfDay(new Date()), // highlighted day in mini-calendar
    calendars: [],                        // [{ id, summary, color, selected, primary, accessRole }]
    enabled: new Set(),                   // set of calendar ids currently visible
    events: [],                           // [shapeEvent...] for current cursor month + bleed
    selectedEvent: null,
  };

  // ---------- top toolbar wiring ----------
  $("calTodayBtn").addEventListener("click", () => {
    state.cursor = startOfMonth(new Date());
    state.selectedDate = startOfDay(new Date());
    renderAll();
  });
  $("calPrevBtn").addEventListener("click", () => { state.cursor = addMonths(state.cursor, -1); renderAll(); });
  $("calNextBtn").addEventListener("click", () => { state.cursor = addMonths(state.cursor, 1); renderAll(); });
  $("calMiniPrev").addEventListener("click", () => { state.cursor = addMonths(state.cursor, -1); renderAll(); });
  $("calMiniNext").addEventListener("click", () => { state.cursor = addMonths(state.cursor, 1); renderAll(); });

  // ---------- data loading ----------
  async function loadCalendars() {
    try {
      const r = await fetch("/api/calendar/calendars");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.calendars = data.calendars || [];
      // Honor Google's per-calendar 'selected' flag as the default visibility.
      state.enabled = new Set(state.calendars.filter((c) => c.selected !== false).map((c) => c.id));
      renderCalendarList();
      populateNewEventCalendarSelect();
    } catch (err) {
      console.warn("[calendar] loadCalendars failed:", err);
      $("calList").innerHTML = `<div class="cal-agenda-empty">Couldn't load calendars: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadEvents() {
    if (!state.calendars.length) return;
    const loading = $("calLoading");
    loading.classList.remove("hidden");

    // Fetch a window covering the visible month plus one week on each side
    // so multi-day events spanning grid edges render correctly.
    const first = startOfMonth(state.cursor);
    const last  = endOfMonth(state.cursor);
    const winStart = addDays(first, -7);
    const winEnd   = addDays(last, 7);
    const params = new URLSearchParams({
      start: winStart.toISOString(),
      end: winEnd.toISOString(),
      calendarIds: [...state.enabled].join(","),
    });

    try {
      const r = await fetch(`/api/calendar/events?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.events = data.events || [];
      renderGrid();
      renderAgenda();
    } catch (err) {
      console.warn("[calendar] loadEvents failed:", err);
      $("calGrid").innerHTML = `<div class="cal-agenda-empty" style="grid-column: span 7;padding: 20px;">
        Couldn't load events: ${escapeHtml(err.message)}
      </div>`;
    } finally {
      loading.classList.add("hidden");
    }
  }

  function colorFor(calendarId) {
    const c = state.calendars.find((x) => x.id === calendarId);
    return c?.color || "#5B7CA3";
  }

  // ---------- rendering ----------
  function renderAll() {
    $("calTitle").textContent = `${MONTHS[state.cursor.getMonth()]} ${state.cursor.getFullYear()}`;
    renderMini();
    renderGrid();
    loadEvents();          // refresh on month change
  }

  function renderMini() {
    $("calMiniLabel").textContent = `${MONTHS[state.cursor.getMonth()]} ${state.cursor.getFullYear()}`;
    const grid = $("calMiniGrid");
    grid.innerHTML = "";
    // DOW labels
    DOW.forEach((d) => {
      const el = document.createElement("div");
      el.className = "cal-mini-dow";
      el.textContent = d[0];
      grid.appendChild(el);
    });
    const first = startOfMonth(state.cursor);
    const startWeekday = dowMon(first);
    const cellStart = addDays(first, -startWeekday);
    const today = startOfDay(new Date());
    for (let i = 0; i < 42; i++) {
      const d = addDays(cellStart, i);
      const el = document.createElement("div");
      el.className = "cal-mini-day";
      if (d.getMonth() !== state.cursor.getMonth()) el.classList.add("muted");
      if (sameDay(d, today)) el.classList.add("today");
      if (sameDay(d, state.selectedDate)) el.classList.add("selected");
      el.textContent = d.getDate();
      el.addEventListener("click", () => {
        state.selectedDate = startOfDay(d);
        if (d.getMonth() !== state.cursor.getMonth()) {
          state.cursor = startOfMonth(d);
          renderAll();
        } else {
          renderMini();
          renderAgenda();
        }
      });
      grid.appendChild(el);
    }
  }

  function renderCalendarList() {
    const wrap = $("calList");
    if (!state.calendars.length) {
      wrap.innerHTML = `<div class="cal-agenda-empty">No calendars found</div>`;
      return;
    }
    wrap.innerHTML = state.calendars.map((c) => {
      const on = state.enabled.has(c.id);
      const primaryCls = c.primary ? " primary" : "";
      return `
        <div class="cal-list-row ${on ? "on" : "off"}${primaryCls}" data-id="${escapeHtml(c.id)}" style="color:${escapeHtml(c.color)}" title="${escapeHtml(c.summary)}">
          <span class="cal-list-dot"></span>
          <span class="cal-list-name">${escapeHtml(c.summary)}</span>
        </div>`;
    }).join("");
    wrap.querySelectorAll(".cal-list-row").forEach((row) => {
      row.addEventListener("click", () => {
        const id = row.dataset.id;
        if (state.enabled.has(id)) state.enabled.delete(id);
        else state.enabled.add(id);
        renderCalendarList();
        loadEvents();
      });
    });
  }

  function renderGrid() {
    const grid = $("calGrid");
    const first = startOfMonth(state.cursor);
    const last  = endOfMonth(state.cursor);
    const startWeekday = dowMon(first);
    const cellStart = addDays(first, -startWeekday);
    // 6 rows × 7 cols = 42 cells, covers any month layout cleanly.
    const today = startOfDay(new Date());

    // Precompute events bucketed by day (YYYY-MM-DD key).
    const buckets = new Map();
    for (const ev of state.events) {
      if (!state.enabled.has(ev.calendarId)) continue;
      const days = dayKeysForEvent(ev);
      for (const k of days) {
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(ev);
      }
    }
    // Sort each bucket: all-day first, then by start time.
    for (const arr of buckets.values()) {
      arr.sort((a, b) => {
        if (a.allDay && !b.allDay) return -1;
        if (!a.allDay && b.allDay) return 1;
        return new Date(a.start) - new Date(b.start);
      });
    }

    let html = "";
    for (let i = 0; i < 42; i++) {
      const d = addDays(cellStart, i);
      const inMonth = d.getMonth() === state.cursor.getMonth();
      const isToday = sameDay(d, today);
      const key = ymd(d);
      const evs = buckets.get(key) || [];
      const MAX_VISIBLE = 4;
      const visible = evs.slice(0, MAX_VISIBLE);
      const more = evs.length - visible.length;

      const eventsHtml = visible.map((ev) => {
        const color = colorFor(ev.calendarId);
        if (ev.allDay) {
          return `<div class="cal-event all-day" data-eid="${escapeHtml(ev.id)}" data-cid="${escapeHtml(ev.calendarId)}" style="color:${escapeHtml(color)}">
            <span class="cal-event-title">${escapeHtml(ev.summary)}</span>
          </div>`;
        }
        const startDt = new Date(ev.start);
        return `<div class="cal-event" data-eid="${escapeHtml(ev.id)}" data-cid="${escapeHtml(ev.calendarId)}" style="color:${escapeHtml(color)}; background: ${hexAlpha(color, .08)}">
          <span class="cal-event-time">${escapeHtml(fmtTime(startDt))}</span>
          <span class="cal-event-title">${escapeHtml(ev.summary)}</span>
        </div>`;
      }).join("");

      html += `
        <div class="cal-month-cell ${inMonth ? "" : "muted"} ${isToday ? "today" : ""}" data-date="${key}">
          <div class="cal-day-num">${d.getDate()}</div>
          <div class="cal-events">
            ${eventsHtml}
            ${more > 0 ? `<div class="cal-more" data-more="${key}">+ ${more} more</div>` : ""}
          </div>
        </div>`;
    }
    grid.innerHTML = html;

    // Wire event clicks
    grid.querySelectorAll(".cal-event").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        openEvent(el.dataset.eid, el.dataset.cid);
      });
    });
    // Clicking a cell selects that day in the mini-cal + agenda.
    // Double-clicking opens the Outlook-style quick-add popover.
    grid.querySelectorAll(".cal-month-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        const [y, m, day] = cell.dataset.date.split("-").map(Number);
        state.selectedDate = new Date(y, m - 1, day);
        renderMini();
        renderAgenda();
      });
      cell.addEventListener("dblclick", (e) => {
        // Don't trigger when double-clicking an event (the click bubbled).
        if (e.target.closest(".cal-event")) return;
        const [y, m, day] = cell.dataset.date.split("-").map(Number);
        openQuickAdd(new Date(y, m - 1, day), e.clientX, e.clientY);
      });
    });
    grid.querySelectorAll(".cal-more").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const [y, m, day] = el.dataset.more.split("-").map(Number);
        state.selectedDate = new Date(y, m - 1, day);
        renderMini();
        renderAgenda();
        // Scroll right rail into view (especially mobile)
        document.querySelector(".cal-agenda")?.scrollIntoView({ behavior: "smooth" });
      });
    });
  }

  // For multi-day events return all day-keys they touch within the visible
  // window. Google all-day events use exclusive end, so subtract a day.
  function dayKeysForEvent(ev) {
    const start = new Date(ev.start);
    let end = ev.end ? new Date(ev.end) : new Date(ev.start);
    if (ev.allDay) end = addDays(end, -1);
    if (end < start) end = start;
    const keys = [];
    let cur = startOfDay(start);
    const last = startOfDay(end);
    while (cur <= last) {
      keys.push(ymd(cur));
      cur = addDays(cur, 1);
      // Hard cap so a runaway event doesn't blow memory
      if (keys.length > 60) break;
    }
    return keys;
  }

  function renderAgenda() {
    const wrap = $("calAgenda");
    const today = startOfDay(new Date());
    // Show 7 days starting from selectedDate (or today, whichever is later).
    const startDay = state.selectedDate < today ? today : state.selectedDate;
    const days = [];
    for (let i = 0; i < 7; i++) days.push(addDays(startDay, i));

    let html = "";
    let totalShown = 0;
    for (const d of days) {
      const key = ymd(d);
      const dayEvents = state.events
        .filter((ev) => state.enabled.has(ev.calendarId) && dayKeysForEvent(ev).includes(key))
        .sort((a, b) => {
          if (a.allDay && !b.allDay) return -1;
          if (!a.allDay && b.allDay) return 1;
          return new Date(a.start) - new Date(b.start);
        });
      if (!dayEvents.length) continue;
      totalShown += dayEvents.length;
      const dateLabel = sameDay(d, today)
        ? `Today, ${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`
        : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      const dateCls = sameDay(d, today) ? "today" : "";
      html += `<div class="cal-agenda-day">
        <div class="cal-agenda-date ${dateCls}">${escapeHtml(dateLabel)}</div>
        ${dayEvents.map((ev) => {
          const color = colorFor(ev.calendarId);
          const startDt = new Date(ev.start);
          const time = ev.allDay ? "All day" : fmtTime(startDt);
          return `<div class="cal-agenda-event" data-eid="${escapeHtml(ev.id)}" data-cid="${escapeHtml(ev.calendarId)}">
            <div class="cal-agenda-bar" style="background:${escapeHtml(color)}"></div>
            <div class="cal-agenda-body">
              <div class="cal-agenda-title">${escapeHtml(ev.summary)}</div>
              <div class="cal-agenda-time">${escapeHtml(time)}${ev.location ? " · " + escapeHtml(ev.location) : ""}</div>
            </div>
          </div>`;
        }).join("")}
      </div>`;
    }
    if (!totalShown) {
      html = `<div class="cal-agenda-empty">Nothing in the next 7 days — enjoy the breathing room.</div>`;
    }
    wrap.innerHTML = html;
    wrap.querySelectorAll(".cal-agenda-event").forEach((el) => {
      el.addEventListener("click", () => openEvent(el.dataset.eid, el.dataset.cid));
    });
  }

  // ---------- event detail popover ----------
  function openEvent(eventId, calendarId) {
    const ev = state.events.find((e) => e.id === eventId && e.calendarId === calendarId);
    if (!ev) return;
    state.selectedEvent = ev;
    const color = colorFor(calendarId);

    $("calPopoverBar").style.background = color;
    $("calPopoverTitle").textContent = ev.summary || "(no title)";

    const body = $("calPopoverBody");
    const start = new Date(ev.start);
    const end = ev.end ? new Date(ev.end) : null;
    const timeStr = ev.allDay
      ? `All day · ${start.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`
      : `${start.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}\n  ${fmtTime(start)}${end ? " – " + fmtTime(end) : ""}`;

    const cal = state.calendars.find((c) => c.id === calendarId);

    const rows = [];
    rows.push(`<div class="cal-popover-row">
      <svg viewBox="0 0 24 24"><path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z"/></svg>
      <div style="white-space: pre-line">${escapeHtml(timeStr)}</div>
    </div>`);
    if (ev.location) {
      rows.push(`<div class="cal-popover-row">
        <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
        <div>${escapeHtml(ev.location)}</div>
      </div>`);
    }
    if (ev.hangoutLink || ev.conferenceUri) {
      const link = ev.hangoutLink || ev.conferenceUri;
      rows.push(`<div class="cal-popover-row">
        <svg viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>
        <a href="${escapeHtml(link)}" target="_blank" rel="noopener">Join video call</a>
      </div>`);
    }
    if (cal) {
      rows.push(`<div class="cal-popover-row">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="${escapeHtml(color)}"/></svg>
        <div>${escapeHtml(cal.summary)}</div>
      </div>`);
    }
    if (ev.attendees && ev.attendees.length) {
      const attendeeHtml = ev.attendees.map((a) => {
        const status = (a.response || "needsAction").replace(/^needsAction$/, "needsAction");
        return `<div class="cal-popover-attendee">
          <span class="cal-popover-attendee-status ${status}"></span>
          ${escapeHtml(a.name || a.email)}
        </div>`;
      }).join("");
      rows.push(`<div class="cal-popover-row">
        <svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
        <div class="cal-popover-attendees">${attendeeHtml}</div>
      </div>`);
    }
    if (ev.description) {
      rows.push(`<div class="cal-popover-row">
        <svg viewBox="0 0 24 24"><path d="M3 5h18v2H3zm0 6h18v2H3zm0 6h12v2H3z"/></svg>
        <div style="white-space: pre-line">${escapeHtml(ev.description)}</div>
      </div>`);
    }
    body.innerHTML = rows.join("");
    $("calPopoverOpen").href = ev.htmlLink || "#";
    $("calPopoverStatus").textContent = "";
    $("calPopoverStatus").className = "cal-status";
    showPopover("calPopover", "calPopoverBackdrop");
  }

  $("calPopoverClose").addEventListener("click", () => hidePopover("calPopover", "calPopoverBackdrop"));
  $("calPopoverBackdrop").addEventListener("click", () => hidePopover("calPopover", "calPopoverBackdrop"));
  $("calPopoverDelete").addEventListener("click", async () => {
    const ev = state.selectedEvent;
    if (!ev) return;
    if (!confirm(`Delete "${ev.summary}"?`)) return;
    const statusEl = $("calPopoverStatus");
    statusEl.textContent = "Deleting…";
    statusEl.className = "cal-status";
    try {
      const r = await fetch(`/api/calendar/events/${encodeURIComponent(ev.id)}?calendarId=${encodeURIComponent(ev.calendarId)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      statusEl.textContent = "Deleted";
      statusEl.className = "cal-status ok";
      setTimeout(() => {
        hidePopover("calPopover", "calPopoverBackdrop");
        loadEvents();
      }, 500);
    } catch (err) {
      statusEl.textContent = `Delete failed: ${err.message || err}`;
      statusEl.className = "cal-status error";
    }
  });

  function showPopover(popId, bdId) { $(popId).classList.add("open"); $(bdId).classList.add("open"); }
  function hidePopover(popId, bdId) { $(popId).classList.remove("open"); $(bdId).classList.remove("open"); }

  // ---------- create event modal ----------
  $("calNewBtn").addEventListener("click", openCreate);
  $("calCreateClose").addEventListener("click", () => hidePopover("calCreate", "calCreateBackdrop"));
  $("calCreateBackdrop").addEventListener("click", () => hidePopover("calCreate", "calCreateBackdrop"));
  $("calCreateCancel").addEventListener("click", () => hidePopover("calCreate", "calCreateBackdrop"));
  $("calCreateSave").addEventListener("click", saveNewEvent);

  function openCreate() {
    const now = state.selectedDate ? new Date(state.selectedDate) : new Date();
    now.setMinutes(0, 0, 0);
    const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
    $("newTitle").value = "";
    $("newAllDay").checked = false;
    $("newStart").value = toLocalDatetime(now);
    $("newEnd").value = toLocalDatetime(inOneHour);
    $("newLocation").value = "";
    $("newAttendees").value = "";
    $("newDescription").value = "";
    $("calCreateStatus").textContent = "";
    $("calCreateStatus").className = "cal-status";
    showPopover("calCreate", "calCreateBackdrop");
    setTimeout(() => $("newTitle").focus(), 40);
  }

  function populateNewEventCalendarSelect() {
    const sel = $("newCalendar");
    sel.innerHTML = state.calendars
      .filter((c) => c.accessRole === "owner" || c.accessRole === "writer")
      .map((c) => `<option value="${escapeHtml(c.id)}"${c.primary ? " selected" : ""}>${escapeHtml(c.summary)}</option>`)
      .join("");
  }

  $("newAllDay").addEventListener("change", (e) => {
    // Swap the date pickers between datetime-local and date when toggling all-day.
    const startInp = $("newStart");
    const endInp = $("newEnd");
    if (e.target.checked) {
      startInp.type = "date";
      endInp.type = "date";
      startInp.value = ymd(new Date());
      endInp.value = ymd(new Date());
    } else {
      startInp.type = "datetime-local";
      endInp.type = "datetime-local";
      const now = new Date(); now.setMinutes(0,0,0);
      const plus = new Date(now.getTime() + 60 * 60 * 1000);
      startInp.value = toLocalDatetime(now);
      endInp.value = toLocalDatetime(plus);
    }
  });

  async function saveNewEvent() {
    const title = $("newTitle").value.trim();
    const allDay = $("newAllDay").checked;
    const startRaw = $("newStart").value;
    const endRaw = $("newEnd").value;
    const calendarId = $("newCalendar").value || "primary";
    const location = $("newLocation").value.trim();
    const attendees = $("newAttendees").value.split(",").map((s) => s.trim()).filter(Boolean);
    const description = $("newDescription").value.trim();

    if (!title) {
      $("calCreateStatus").textContent = "Add a title first.";
      $("calCreateStatus").className = "cal-status error";
      return;
    }
    if (!startRaw || !endRaw) {
      $("calCreateStatus").textContent = "Pick start + end times.";
      $("calCreateStatus").className = "cal-status error";
      return;
    }
    const saveBtn = $("calCreateSave");
    saveBtn.disabled = true;
    $("calCreateStatus").textContent = "Saving…";
    $("calCreateStatus").className = "cal-status";

    try {
      const r = await fetch("/api/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calendarId,
          summary: title,
          description,
          location,
          allDay,
          start: startRaw,
          end: endRaw,
          attendees: attendees.length ? attendees : undefined,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message || body.error || `HTTP ${r.status}`);
      }
      $("calCreateStatus").textContent = "Created ✓";
      $("calCreateStatus").className = "cal-status ok";
      setTimeout(() => {
        hidePopover("calCreate", "calCreateBackdrop");
        loadEvents();
      }, 500);
    } catch (err) {
      $("calCreateStatus").textContent = `Create failed: ${err.message || err}`;
      $("calCreateStatus").className = "cal-status error";
    } finally {
      saveBtn.disabled = false;
    }
  }

  function toLocalDatetime(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Lighten a hex color by alpha for the soft event background tint.
  function hexAlpha(hex, alpha) {
    const h = String(hex).replace(/^#/, "");
    if (h.length !== 6) return `rgba(91, 124, 163, ${alpha})`;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // ---------- QUICK-ADD popover (Outlook-style double-click) ----------
  // State for the currently-open quick draft so 'More options' can hand
  // its values off to the full create modal cleanly.
  const quickState = { date: null };

  function openQuickAdd(date, anchorX, anchorY) {
    quickState.date = startOfDay(date);

    // Account header — primary calendar = user's main address
    const primary = state.calendars.find((c) => c.primary) || state.calendars[0];
    $("calQuickAccountPrimary").textContent = primary?.summary || "Calendar";
    $("calQuickAccountSecondary").textContent = primary?.id || "";

    // Reset fields. All-day defaults ON (matches Outlook's quick-add).
    $("calQuickTitle").value = "";
    $("calQuickAttendees").value = "";
    $("calQuickLocation").value = "";
    $("calQuickNotes").value = "";
    $("calQuickStatus").textContent = "";
    $("calQuickStatus").className = "cal-status";

    setQuickAllDay(true, date);

    showPopover("calQuick", "calQuickBackdrop");

    // Position near the click. Clamp to viewport.
    requestAnimationFrame(() => {
      const pop = $("calQuick");
      const rect = pop.getBoundingClientRect();
      let x = anchorX - rect.width / 2;
      let y = anchorY - 20;
      const margin = 12;
      x = Math.max(margin, Math.min(window.innerWidth - rect.width - margin, x));
      y = Math.max(margin, Math.min(window.innerHeight - rect.height - margin, y));
      pop.style.left = `${x}px`;
      pop.style.top  = `${y}px`;
      pop.style.right = "auto";
      pop.style.bottom = "auto";
      pop.style.transform = "none";
      setTimeout(() => $("calQuickTitle").focus(), 40);
    });
  }

  function setQuickAllDay(on, anchorDate) {
    const toggle = $("calQuickAllDay");
    const startInp = $("calQuickStart");
    const endInp   = $("calQuickEnd");
    const endWrap  = $("calQuickToWrap");
    if (on) {
      toggle.classList.add("on");
      toggle.setAttribute("aria-checked", "true");
      startInp.type = "date";
      endInp.type = "date";
      startInp.value = ymd(anchorDate || quickState.date || new Date());
      endInp.value   = startInp.value;
      // For Outlook-style quick add, end stays hidden — single-day default.
      endInp.style.display = "none";
      endWrap.style.display = "none";
    } else {
      toggle.classList.remove("on");
      toggle.setAttribute("aria-checked", "false");
      startInp.type = "datetime-local";
      endInp.type = "datetime-local";
      // Default start = clicked-date at 9am, end = +1 hour.
      const base = anchorDate || quickState.date || new Date();
      const start = new Date(base); start.setHours(9, 0, 0, 0);
      const end   = new Date(start.getTime() + 60 * 60 * 1000);
      startInp.value = toLocalDatetime(start);
      endInp.value   = toLocalDatetime(end);
      endInp.style.display = "";
      endWrap.style.display = "";
    }
  }

  $("calQuickAllDay").addEventListener("click", (e) => {
    const on = !e.currentTarget.classList.contains("on");
    setQuickAllDay(on);
  });

  $("calQuickDiscard").addEventListener("click", () => {
    hidePopover("calQuick", "calQuickBackdrop");
  });
  $("calQuickBackdrop").addEventListener("click", () => {
    hidePopover("calQuick", "calQuickBackdrop");
  });

  $("calQuickSave").addEventListener("click", async () => {
    const title = $("calQuickTitle").value.trim();
    if (!title) {
      $("calQuickStatus").textContent = "Add a title first.";
      $("calQuickStatus").className = "cal-status error";
      $("calQuickTitle").focus();
      return;
    }
    const allDay = $("calQuickAllDay").classList.contains("on");
    const startRaw = $("calQuickStart").value;
    const endRaw   = $("calQuickEnd").value || startRaw;
    const location = $("calQuickLocation").value.trim();
    const notes    = $("calQuickNotes").value.trim();
    const attendees = $("calQuickAttendees").value
      .split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s.includes("@"));

    const saveBtn = $("calQuickSave");
    saveBtn.disabled = true;
    $("calQuickStatus").textContent = "Saving…";
    $("calQuickStatus").className = "cal-status";

    try {
      const primary = state.calendars.find((c) => c.primary) || state.calendars[0];
      const r = await fetch("/api/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calendarId: primary?.id || "primary",
          summary: title,
          description: notes,
          location,
          allDay,
          start: startRaw,
          end: endRaw,
          attendees: attendees.length ? attendees : undefined,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.message || body.error || `HTTP ${r.status}`);
      }
      $("calQuickStatus").textContent = "Created ✓";
      $("calQuickStatus").className = "cal-status ok";
      setTimeout(() => {
        hidePopover("calQuick", "calQuickBackdrop");
        loadEvents();
      }, 450);
    } catch (err) {
      $("calQuickStatus").textContent = `Create failed: ${err.message || err}`;
      $("calQuickStatus").className = "cal-status error";
    } finally {
      saveBtn.disabled = false;
    }
  });

  // 'More options' — hand off whatever the user typed into the full modal.
  function promoteQuickToFull() {
    const allDay = $("calQuickAllDay").classList.contains("on");
    const startRaw = $("calQuickStart").value;
    const endRaw   = $("calQuickEnd").value || startRaw;

    hidePopover("calQuick", "calQuickBackdrop");
    openCreate();   // resets defaults — we override below

    $("newTitle").value       = $("calQuickTitle").value;
    $("newLocation").value    = $("calQuickLocation").value;
    $("newAttendees").value   = $("calQuickAttendees").value;
    $("newDescription").value = $("calQuickNotes").value;
    $("newAllDay").checked    = allDay;
    // Trigger the all-day input-type swap on the full modal.
    $("newAllDay").dispatchEvent(new Event("change"));
    if (startRaw) $("newStart").value = startRaw;
    if (endRaw)   $("newEnd").value   = endRaw || startRaw;
  }
  $("calQuickMore").addEventListener("click", promoteQuickToFull);
  $("calQuickExpand").addEventListener("click", promoteQuickToFull);

  // ---------- Esc closes any open popover ----------
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hidePopover("calPopover", "calPopoverBackdrop");
      hidePopover("calCreate", "calCreateBackdrop");
      hidePopover("calQuick", "calQuickBackdrop");
    }
  });

  // ---------- boot ----------
  (async function init() {
    await loadCalendars();
    renderAll();
  })();
})();
