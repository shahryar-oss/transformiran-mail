// Right-side calendar panel on the inbox home page.
// Mini-month + today/upcoming agenda. Reuses /api/calendar/events.
// User can toggle the whole panel; preference persists in localStorage.
// Delta panel (right slide-in) overlays this when invoked — they share
// the right edge but only one is visible at a time visually.

(function() {
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const app = document.querySelector(".app");
  const panel = $("rightPanel");
  if (!app || !panel) return;

  // ---------- toggle persistence ----------
  const STORAGE_KEY = "deltaMail.rightPanelHidden";
  function isHidden() { return localStorage.getItem(STORAGE_KEY) === "1"; }
  function setHidden(hidden) {
    if (hidden) {
      localStorage.setItem(STORAGE_KEY, "1");
      app.classList.add("right-panel-hidden");
    } else {
      localStorage.removeItem(STORAGE_KEY);
      app.classList.remove("right-panel-hidden");
    }
  }
  // Apply persisted state on boot.
  setHidden(isHidden());

  // Inject a "Show calendar" floating button that appears on the very right
  // edge when the panel is hidden — so user can re-open without hunting.
  const showBtn = document.createElement("button");
  showBtn.id = "rpShowBtn";
  showBtn.type = "button";
  showBtn.title = "Show calendar panel";
  showBtn.className = "right-panel-toggle";
  showBtn.style.cssText = "position:fixed;top:18px;right:10px;z-index:50;background:var(--paper);";
  showBtn.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z"/></svg>
    <span>Calendar</span>
  `;
  showBtn.addEventListener("click", () => { setHidden(false); loadEvents(); });
  document.body.appendChild(showBtn);
  function syncShowBtn() {
    showBtn.style.display = app.classList.contains("right-panel-hidden") ? "" : "none";
  }
  syncShowBtn();
  $("rpCollapseBtn")?.addEventListener("click", () => { setHidden(true); syncShowBtn(); });
  const observer = new MutationObserver(syncShowBtn);
  observer.observe(app, { attributes: true, attributeFilter: ["class"] });

  // ---------- mini-month ----------
  const MONTHS = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December",
  ];
  const DOW = ["M","T","W","T","F","S","S"];

  function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth()+1, 0); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }
  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth()+n, 1); }
  function sameDay(a,b) { return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  function dowMon(d) { const w = d.getDay(); return (w + 6) % 7; }
  function fmtTime(d) { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }

  const state = {
    cursor: startOfMonth(new Date()),
    selected: startOfDay(new Date()),
    calendars: [],
    events: [],
    eventsByDay: new Map(),
  };

  $("rpMiniPrev").addEventListener("click", () => { state.cursor = addMonths(state.cursor, -1); render(); loadEvents(); });
  $("rpMiniNext").addEventListener("click", () => { state.cursor = addMonths(state.cursor, 1); render(); loadEvents(); });

  function renderMini() {
    $("rpMiniLabel").textContent = `${MONTHS[state.cursor.getMonth()]} ${state.cursor.getFullYear()}`;
    const grid = $("rpMiniGrid");
    grid.innerHTML = "";
    DOW.forEach((d) => {
      const el = document.createElement("div");
      el.className = "rp-mini-dow";
      el.textContent = d;
      grid.appendChild(el);
    });
    const first = startOfMonth(state.cursor);
    const startWk = dowMon(first);
    const startCell = addDays(first, -startWk);
    const today = startOfDay(new Date());
    for (let i = 0; i < 42; i++) {
      const d = addDays(startCell, i);
      const el = document.createElement("div");
      el.className = "rp-mini-day";
      if (d.getMonth() !== state.cursor.getMonth()) el.classList.add("muted");
      if (sameDay(d, today)) el.classList.add("today");
      if (state.eventsByDay.has(ymd(d))) el.classList.add("has-events");
      el.textContent = d.getDate();
      el.addEventListener("click", () => {
        state.selected = startOfDay(d);
        if (d.getMonth() !== state.cursor.getMonth()) {
          state.cursor = startOfMonth(d);
          render();
          loadEvents();
        } else {
          renderMini();
          renderAgenda();
        }
      });
      grid.appendChild(el);
    }
  }

  function colorFor(calendarId) {
    return state.calendars.find((c) => c.id === calendarId)?.color || "#5B7CA3";
  }

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
      if (keys.length > 60) break;
    }
    return keys;
  }

  function bucketEvents() {
    state.eventsByDay = new Map();
    for (const ev of state.events) {
      for (const k of dayKeysForEvent(ev)) {
        if (!state.eventsByDay.has(k)) state.eventsByDay.set(k, []);
        state.eventsByDay.get(k).push(ev);
      }
    }
    for (const arr of state.eventsByDay.values()) {
      arr.sort((a, b) => {
        if (a.allDay && !b.allDay) return -1;
        if (!a.allDay && b.allDay) return 1;
        return new Date(a.start) - new Date(b.start);
      });
    }
  }

  function renderAgenda() {
    const wrap = $("rpAgenda");
    const today = startOfDay(new Date());
    const startDay = state.selected < today ? today : state.selected;
    // Show 5 days from the selected/today date
    const days = [];
    for (let i = 0; i < 5; i++) days.push(addDays(startDay, i));

    let html = "";
    let totalEvents = 0;
    for (const d of days) {
      const key = ymd(d);
      const evs = state.eventsByDay.get(key) || [];
      if (!evs.length) continue;
      totalEvents += evs.length;
      const isToday = sameDay(d, today);
      const label = isToday
        ? `Today · ${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`
        : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      html += `<div class="rp-day">
        <div class="rp-day-label ${isToday ? "today" : ""}">${escapeHtml(label)}</div>
        ${evs.slice(0, 6).map((ev) => {
          const color = colorFor(ev.calendarId);
          const time = ev.allDay ? "All day" : fmtTime(new Date(ev.start));
          return `<div class="rp-event" data-eid="${escapeHtml(ev.id)}" data-cid="${escapeHtml(ev.calendarId)}">
            <div class="rp-event-bar" style="background:${escapeHtml(color)}"></div>
            <div class="rp-event-body">
              <div class="rp-event-title">${escapeHtml(ev.summary)}</div>
              <div class="rp-event-time">${escapeHtml(time)}${ev.location ? " · " + escapeHtml(ev.location) : ""}</div>
            </div>
          </div>`;
        }).join("")}
        ${evs.length > 6 ? `<div class="rp-agenda-loading" style="padding:2px 4px">+ ${evs.length - 6} more</div>` : ""}
      </div>`;
    }
    if (!totalEvents) {
      html = `<div class="rp-agenda-empty">Nothing in the next 5 days.</div>`;
    }
    wrap.innerHTML = html;
    wrap.querySelectorAll(".rp-event").forEach((el) => {
      el.addEventListener("click", () => {
        // Open full calendar on this event's day
        window.location.href = `/calendar`;
      });
    });
  }

  function render() {
    renderMini();
    renderAgenda();
  }

  // ---------- data ----------
  async function loadCalendars() {
    try {
      const r = await fetch("/api/calendar/calendars");
      if (!r.ok) return;
      const data = await r.json();
      state.calendars = data.calendars || [];
    } catch (_) {}
  }

  async function loadEvents() {
    if (app.classList.contains("right-panel-hidden")) return;   // skip if hidden
    const wrap = $("rpAgenda");
    if (!state.events.length) wrap.innerHTML = `<div class="rp-agenda-loading">Loading…</div>`;
    const first = startOfMonth(state.cursor);
    const last = endOfMonth(state.cursor);
    const winStart = addDays(first, -7);
    const winEnd = addDays(last, 7);
    const params = new URLSearchParams({
      start: winStart.toISOString(),
      end: winEnd.toISOString(),
    });
    try {
      const r = await fetch(`/api/calendar/events?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.events = data.events || [];
      bucketEvents();
      render();
    } catch (err) {
      wrap.innerHTML = `<div class="rp-agenda-empty">Couldn't load: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ---------- boot ----------
  (async function init() {
    await loadCalendars();
    render();
    if (!isHidden()) loadEvents();
  })();
})();
