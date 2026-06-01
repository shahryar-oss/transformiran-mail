// Tasks page — Microsoft To Do-style task manager.

(() => {
  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Inline SVG icons — monochrome, currentColor, no emoji per brand rules.
  const ICONS = {
    sun:      `<svg viewBox="0 0 24 24"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13l2 .14V11l-2 .14V13zm18 0l2-.14V11l-2 .14V13zM11 2v2.14h2V2h-2zm0 18v2h2v-2h-2zM5.99 4.58l-1.41 1.41 1.42 1.42 1.41-1.41-1.42-1.42zm12.02 12.02l-1.41 1.41 1.42 1.42 1.41-1.41-1.42-1.42zm1.42-13.43l-1.41-1.42-1.42 1.42 1.41 1.42 1.42-1.42zM4.57 18l-1.41-1.42-1.42 1.42 1.42 1.41 1.41-1.41z"/></svg>`,
    calendar: `<svg viewBox="0 0 24 24"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z"/></svg>`,
    clock:    `<svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
    envelope: `<svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>`,
    chevron:  `<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>`,
    dot:      `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/></svg>`,
    trash:    `<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`,
    bell:     `<svg viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>`,
  };

  // ----- STATE -----
  let _view = "my-day";
  let _viewTitle = "My Day";
  let _lists = [];
  let _tasks = [];
  let _selected = null; // selected task id
  let _plannedBucket = "all"; // Planned view time filter: all/overdue/today/tomorrow/this-week/later

  // ----- LISTS + COUNTS -----
  // Postgres BIGINT comes back as strings — normalize to numbers so
  // === comparisons (find(l => l.id === view)) work everywhere.
  function normalizeList(l) {
    return { ...l, id: Number(l.id), open_count: Number(l.open_count || 0) };
  }
  function normalizeTask(t) {
    return {
      ...t,
      id: Number(t.id),
      list_id: t.list_id != null ? Number(t.list_id) : null,
    };
  }

  async function loadLists() {
    const r = await fetch("/api/tasks/lists");
    if (!r.ok) return;
    const data = await r.json();
    _lists = (data.lists || []).map(normalizeList);
    renderLists();
    renderCounts(data.counts || {});
  }

  function renderCounts(c) {
    $("count-my-day").textContent  = c.my_day || "";
    $("count-important").textContent = c.important || "";
    $("count-planned").textContent = c.planned || "";
    $("count-all").textContent     = c.all_count || "";
    $("count-tasks").textContent   = c.tasks || "";
  }

  function renderLists() {
    const target = $("customLists");
    if (!_lists.length) {
      target.innerHTML = "";
      return;
    }
    // Group by group_name
    const groups = new Map();
    for (const list of _lists) {
      const g = list.group_name || "My lists";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(list);
    }
    let html = "";
    for (const [g, items] of groups.entries()) {
      html += `<div class="rail-section-label">${escapeHtml(g)}</div>`;
      for (const list of items) {
        const isActive = _view === list.id;
        html += `
          <div class="rail-item ${isActive ? "active" : ""}" data-view="${list.id}">
            <span class="icon" style="color:${list.color || "#B28E44"}">${ICONS.dot}</span>
            <span>${escapeHtml(list.name)}</span>
            <span class="count">${list.open_count > 0 ? list.open_count : ""}</span>
          </div>`;
      }
    }
    target.innerHTML = html;
    target.querySelectorAll(".rail-item").forEach((el) => {
      el.addEventListener("click", () => switchView(Number(el.dataset.view)));
    });
  }

  // ----- VIEW SWITCHING -----
  async function switchView(view) {
    _view = view;
    if (view === "planned") _plannedBucket = "all"; // reset filter on entry
    if (typeof view === "number") {
      const list = _lists.find((l) => l.id === view);
      _viewTitle = list ? list.name : "List";
    } else {
      _viewTitle = {
        "my-day":    "My Day",
        important:   "Important",
        planned:     "Planned",
        completed:   "Completed",
        all:         "All",
        tasks:       "Tasks",
      }[view] || "Tasks";
    }
    $("viewTitle").innerHTML = escapeHtml(_viewTitle) + `<span class="sub" id="viewSub"></span>`;
    document.querySelectorAll(".rail-item.active").forEach((el) => el.classList.remove("active"));
    document.querySelector(`.rail-item[data-view="${view}"]`)?.classList.add("active");
    _selected = null;
    renderDetail();
    await loadTasks();
  }

  // ----- TASKS -----
  async function loadTasks() {
    const view = _view === "completed" ? "completed" : _view;
    const include = _view === "completed" ? "true" : "false";
    const r = await fetch(`/api/tasks?view=${encodeURIComponent(view)}&includeCompleted=${include}`);
    if (!r.ok) return;
    const data = await r.json();
    _tasks = (data.tasks || []).map(normalizeTask);
    renderTasks();
  }

  // Attach click/checkbox/star handlers to every .task-row inside a
  // container. Shared by the flat list and the Planned calendar view.
  function wireTaskRows(target) {
    target.querySelectorAll(".task-row").forEach((row) => {
      const id = Number(row.dataset.id);
      row.addEventListener("click", (e) => {
        if (e.target.closest(".task-checkbox") || e.target.closest(".task-star")) return;
        selectTask(id);
      });
      row.querySelector(".task-checkbox")?.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleComplete(id);
      });
      row.querySelector(".task-star")?.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleImportant(id);
      });
    });
  }

  // ----- PLANNED (calendar-style) -----
  // Microsoft-To-Do-style Planned view: time-bucket tabs across the top
  // (All Planned / Overdue / Today / Tomorrow / This Week / Later) and
  // tasks grouped under date headers so you can see what's coming.
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function endOfWeekStart(today) {
    // Start-of-day of the upcoming Sunday (end of the current week).
    const daysToSun = (7 - today.getDay()) % 7;
    const e = new Date(today);
    e.setDate(e.getDate() + daysToSun);
    return e;
  }
  function diffDaysFromToday(due) {
    return Math.round((startOfDay(new Date(due)) - startOfDay(new Date())) / 86400000);
  }
  function matchesBucket(due, bucket) {
    const diff = diffDaysFromToday(due);
    switch (bucket) {
      case "all":       return true;
      case "overdue":   return diff < 0;
      case "today":     return diff === 0;
      case "tomorrow":  return diff === 1;
      case "this-week": return diff >= 0 && startOfDay(new Date(due)) <= endOfWeekStart(startOfDay(new Date()));
      case "later":     return startOfDay(new Date(due)) > endOfWeekStart(startOfDay(new Date()));
      default:          return true;
    }
  }
  function dayHeader(due) {
    const diff = diffDaysFromToday(due);
    const d = startOfDay(new Date(due));
    if (diff === 0)  return "Today";
    if (diff === 1)  return "Tomorrow";
    if (diff === -1) return "Yesterday";
    const label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    return diff < 0 ? `Overdue · ${label}` : label;
  }

  const PLANNED_BUCKETS = [
    { k: "all",       label: "All Planned" },
    { k: "overdue",   label: "Overdue" },
    { k: "today",     label: "Today" },
    { k: "tomorrow",  label: "Tomorrow" },
    { k: "this-week", label: "This Week" },
    { k: "later",     label: "Later" },
  ];

  function renderPlanned() {
    const target = $("taskList");
    const withDue = _tasks.filter((t) => t.due_at);

    const tabsHtml = `<div class="planned-tabs">` + PLANNED_BUCKETS.map((b) => {
      const count = withDue.filter((t) => matchesBucket(t.due_at, b.k)).length;
      return `<button class="planned-tab ${_plannedBucket === b.k ? "active" : ""} ${b.k === "overdue" && count ? "has-overdue" : ""}" data-bucket="${b.k}">${b.label}${count ? `<span class="pt-count">${count}</span>` : ""}</button>`;
    }).join("") + `</div>`;

    const filtered = withDue.filter((t) => matchesBucket(t.due_at, _plannedBucket));
    let body;
    if (!filtered.length) {
      const labelText = (PLANNED_BUCKETS.find((b) => b.k === _plannedBucket) || {}).label || "this view";
      body = `<div class="planned-empty">Nothing in <strong>${escapeHtml(labelText)}</strong>.</div>`;
    } else {
      // Group consecutive tasks (already sorted due_at ASC by the server)
      // by calendar day.
      const groups = [];
      let cur = null;
      for (const t of filtered) {
        const key = startOfDay(new Date(t.due_at)).getTime();
        if (!cur || cur.key !== key) { cur = { key, header: dayHeader(t.due_at), tasks: [] }; groups.push(cur); }
        cur.tasks.push(t);
      }
      body = groups.map((g) => `
        <div class="planned-group">
          <div class="planned-group-head ${g.header.startsWith("Overdue") || g.header === "Yesterday" ? "overdue" : ""}">${escapeHtml(g.header)}</div>
          ${g.tasks.map(taskRowHtml).join("")}
        </div>`).join("");
    }

    target.innerHTML = tabsHtml + body;
    target.querySelectorAll(".planned-tab").forEach((tab) => {
      tab.addEventListener("click", () => { _plannedBucket = tab.dataset.bucket; renderPlanned(); });
    });
    wireTaskRows(target);
  }

  function renderTasks() {
    const target = $("taskList");
    // Planned view → calendar-style grouped layout (only when there's
    // something with a due date; otherwise fall through to empty state).
    if (_view === "planned" && _tasks.some((t) => t.due_at)) {
      renderPlanned();
      return;
    }
    if (!_tasks.length) {
      const emptyIcon = _view === "my-day" ? ICONS.sun
                      : _view === "important" ? `<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
                      : _view === "planned" ? ICONS.calendar
                      : `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`;
      target.innerHTML = `
        <div class="list-empty-state">
          <div class="empty-svg">${emptyIcon}</div>
          <div class="title">${_view === "my-day" ? "Focus on your day" : "Nothing here yet"}</div>
          <div class="sub">${
            _view === "my-day" ? "Add tasks from this list to focus on today." :
            _view === "completed" ? "Completed tasks will appear here." :
            _view === "important" ? "Tasks you star will appear here." :
            _view === "planned" ? "Tasks with a due date will appear here." :
            "Add a task above to get started."
          }</div>
        </div>`;
      return;
    }
    target.innerHTML = _tasks.map(taskRowHtml).join("");
    wireTaskRows(target);
  }

  function taskRowHtml(t) {
    const isSelected = _selected === t.id;
    const isCompleted = !!t.completed_at;
    const dueText = formatDue(t.due_at);
    const isOverdue = t.due_at && !isCompleted && new Date(t.due_at) < new Date();
    return `
      <div class="task-row ${isCompleted ? "completed" : ""} ${isSelected ? "selected" : ""} ${isOverdue ? "overdue" : ""}" data-id="${t.id}">
        <div class="task-checkbox"></div>
        <div class="task-body">
          <div class="task-title">${escapeHtml(t.title)}</div>
          <div class="task-meta">
            ${t.list_id ? `<span>${escapeHtml(listName(t.list_id))}</span>` : ""}
            ${dueText ? `<span class="due ${isOverdue ? "overdue" : ""}"><span class="meta-i">${ICONS.calendar}</span>${escapeHtml(dueText)}</span>` : ""}
            ${t.in_my_day && _view !== "my-day" ? `<span class="my-day-tag"><span class="meta-i">${ICONS.sun}</span>My Day</span>` : ""}
            ${t.source_message_id ? `<a class="src-link" href="/?msg=${encodeURIComponent(t.source_message_id)}" title="Open source email" onclick="event.stopPropagation()"><span class="meta-i">${ICONS.envelope}</span>from email</a>` : ""}
          </div>
        </div>
        <button class="task-star ${t.important ? "starred" : ""}" title="${t.important ? "Unstar" : "Star"}">
          <svg viewBox="0 0 24 24" ${t.important ? "" : 'fill="none" stroke="currentColor" stroke-width="2"'}>
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </button>
      </div>`;
  }

  function listName(listId) {
    return _lists.find((l) => l.id === listId)?.name || "";
  }

  function formatDue(due) {
    if (!due) return "";
    const d = new Date(due);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((target - today) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    if (diffDays === -1) return "Yesterday";
    if (diffDays > 0 && diffDays < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // Reminders always carry a time, so format day + clock. Used in the
  // detail "Remind me" row value.
  function formatReminder(when) {
    if (!when) return "";
    const d = new Date(when);
    const dayPart = formatDue(when) || d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const timePart = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${dayPart} at ${timePart}`;
  }

  // ----- BROWSER NOTIFICATIONS -----
  // Reminders fire as browser notifications via task-notifier.js, but
  // only if the user has granted permission. We surface a header chip
  // to enable it, and we proactively ask the moment a user sets their
  // first reminder (the natural opt-in point).
  function notifPermission() {
    return ("Notification" in window) ? Notification.permission : "denied";
  }
  function refreshNotifChip() {
    const chip = $("notifEnableChip");
    if (!chip) return;
    const p = notifPermission();
    if (p === "granted") { chip.hidden = true; return; }
    chip.hidden = false;
    if (p === "denied") {
      chip.textContent = "🔕 Reminders blocked — enable in browser settings";
      chip.classList.add("blocked");
      chip.disabled = true;
    } else {
      chip.textContent = "🔔 Turn on reminders";
      chip.classList.remove("blocked");
      chip.disabled = false;
    }
  }
  async function ensureNotifPermission() {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    try { await Notification.requestPermission(); } catch (_) {}
    refreshNotifChip();
    return Notification.permission === "granted";
  }

  // ----- ADD TASK -----
  const addInput = $("addTaskInput");
  const addBtn = $("addTaskBtn");
  addInput.addEventListener("input", () => { addBtn.disabled = !addInput.value.trim(); });
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && addInput.value.trim()) addTask();
  });
  addBtn.addEventListener("click", addTask);

  async function addTask() {
    const title = addInput.value.trim();
    if (!title) return;
    addInput.value = ""; addBtn.disabled = true;
    const payload = { title };
    // Default list context
    if (typeof _view === "number") payload.list_id = _view;
    if (_view === "my-day") payload.in_my_day = true;
    if (_view === "important") payload.important = true;
    if (_view === "planned") {
      payload.due_at = new Date(new Date().setHours(17, 0, 0, 0)).toISOString();
    }
    const r = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return;
    addInput.focus();
    loadTasks();
    loadLists();
  }

  // A soft single "ding" when a task is completed — synthesized with the
  // Web Audio API so there's no audio file to ship. A completing click is a
  // user gesture, so playback is allowed. Set localStorage ti_task_sound=off
  // to silence it.
  let _chimeCtx = null;
  function playCompleteChime() {
    try {
      if (localStorage.getItem("ti_task_sound") === "off") return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      _chimeCtx = _chimeCtx || new AC();
      const ctx = _chimeCtx;
      if (ctx.state === "suspended") ctx.resume();
      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.connect(ctx.destination);
      // Soft bell = fundamental (A5) + octave shimmer + a gentle fifth.
      [{ f: 880, g: 1.0 }, { f: 1760, g: 0.35 }, { f: 1318.5, g: 0.18 }].forEach((p) => {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = p.f;
        const g = ctx.createGain();
        g.gain.value = p.g;
        o.connect(g); g.connect(master);
        o.start(now);
        o.stop(now + 0.6);
      });
      // Quick attack, smooth exponential decay — bell-like, not harsh.
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(0.22, now + 0.006);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    } catch (_) { /* audio not available — ignore */ }
  }

  async function toggleComplete(id) {
    const t = _tasks.find((x) => x.id === id);
    if (!t) return;
    const completed = !t.completed_at;
    if (completed) playCompleteChime();   // only on completing, not un-checking
    t.completed_at = completed ? new Date().toISOString() : null;
    renderTasks();
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed }),
    });
    // If hidden after completion, refresh after a delay
    if (completed && _view !== "completed" && _view !== "all") {
      setTimeout(() => { loadTasks(); loadLists(); }, 500);
    } else {
      loadLists();
    }
  }

  async function toggleImportant(id) {
    const t = _tasks.find((x) => x.id === id);
    if (!t) return;
    t.important = !t.important;
    renderTasks();
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ important: t.important }),
    });
    loadLists();
  }

  // ----- DETAIL PANE -----
  function selectTask(id) {
    _selected = id;
    document.querySelectorAll(".task-row.selected").forEach((el) => el.classList.remove("selected"));
    document.querySelector(`.task-row[data-id="${id}"]`)?.classList.add("selected");
    renderDetail();
  }

  async function renderDetail() {
    const app = $("app");
    const target = $("taskDetail");
    if (!_selected) {
      app.classList.add("no-selection");
      target.innerHTML = "";
      return;
    }
    app.classList.remove("no-selection");
    const t = _tasks.find((x) => x.id === _selected);
    if (!t) { app.classList.add("no-selection"); return; }

    const stepsR = await fetch(`/api/tasks/${t.id}/steps`);
    const stepsData = stepsR.ok ? (await stepsR.json()).steps || [] : [];

    const dueForInput = t.due_at
      ? new Date(t.due_at).toISOString().slice(0, 16)
      : "";
    const reminderForInput = t.reminder_at
      ? new Date(t.reminder_at).toISOString().slice(0, 16)
      : "";

    target.innerHTML = `
      <div class="detail-head">
        <div class="detail-checkbox ${t.completed_at ? "checked" : ""}" id="detailCheck"></div>
        <input class="detail-title-input ${t.completed_at ? "completed" : ""}" id="detailTitle" value="${escapeHtml(t.title)}">
        <button class="detail-star ${t.important ? "starred" : ""}" id="detailStar" title="${t.important ? "Unstar" : "Star"}">
          <svg viewBox="0 0 24 24" ${t.important ? "" : 'fill="none" stroke="currentColor" stroke-width="2"'}>
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </button>
      </div>

      <div class="detail-section">
        <div class="detail-row ${t.in_my_day ? "" : "empty"}" id="row-myday">
          <span class="icon">${ICONS.sun}</span>
          <span class="value">${t.in_my_day ? "Added to My Day" : "Add to My Day"}</span>
        </div>
        <div class="detail-row ${t.due_at ? "" : "empty"}">
          <span class="icon">${ICONS.calendar}</span>
          <input type="datetime-local" id="dueInput" value="${dueForInput}" placeholder="Add due date">
        </div>
        <div class="detail-row reminder-row ${t.reminder_at ? "" : "empty"}" id="reminderRow">
          <span class="icon">${ICONS.bell}</span>
          <span class="value" id="reminderValue">${t.reminder_at ? "Remind me · " + escapeHtml(formatReminder(t.reminder_at)) : "Remind me"}</span>
          ${t.reminder_at ? `<button class="detail-row-clear" id="reminderClear" title="Remove reminder">×</button>` : ""}
        </div>
        <!-- Reminder quick-pick popover -->
        <div class="reminder-popover" id="reminderPopover" hidden>
          <button class="rp-opt" data-rp="later">Later today</button>
          <button class="rp-opt" data-rp="evening">This evening</button>
          <button class="rp-opt" data-rp="tomorrow">Tomorrow morning</button>
          <button class="rp-opt" data-rp="nextweek">Next week</button>
          <div class="rp-divider"></div>
          <label class="rp-custom">Pick date &amp; time
            <input type="datetime-local" id="reminderInput" value="${reminderForInput}">
          </label>
        </div>
      </div>

      <div class="section-label">Steps</div>
      <div class="detail-steps" id="stepsList">
        ${stepsData.map((s) => `
          <div class="step-row" data-step-id="${s.id}">
            <div class="step-check ${s.completed_at ? "checked" : ""}"></div>
            <input class="step-title ${s.completed_at ? "completed" : ""}" value="${escapeHtml(s.title)}">
            <button class="step-delete" title="Delete">×</button>
          </div>`).join("")}
        <div class="step-add">
          <input id="newStepInput" placeholder="+ Add step">
        </div>
      </div>

      <div class="section-label">Notes</div>
      <div class="detail-notes">
        <textarea id="notesInput" placeholder="Add notes…">${escapeHtml(t.notes || "")}</textarea>
      </div>

      ${t.source_message_id ? `
      <div class="section-label">From email</div>
      <div class="detail-email" id="detailEmail" data-msg-id="${escapeHtml(t.source_message_id)}">
        <div class="detail-email-loading">Loading email…</div>
      </div>` : ""}

      <div class="detail-foot">
        <span>Created ${new Date(t.created_at).toLocaleString()}</span>
        <div class="detail-foot-spacer"></div>
        ${t.source_message_id ? `<a class="src-link" href="/?msg=${encodeURIComponent(t.source_message_id)}" title="Open source email" style="color:var(--gold-dark);text-decoration:none;font-weight:600;font-size:11.5px;display:inline-flex;align-items:center;gap:4px"><span class="meta-i" style="display:inline-grid;place-items:center"><svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:currentColor"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg></span> from email →</a>` : ""}
        <button class="detail-delete" id="detailDelete" title="Delete task">
          <svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
    `;

    // Wire up detail handlers
    $("detailCheck").addEventListener("click", () => toggleComplete(t.id));
    $("detailStar").addEventListener("click", () => toggleImportant(t.id));
    $("row-myday").addEventListener("click", async () => {
      await patchTask(t.id, { in_my_day: !t.in_my_day });
      loadTasks(); loadLists();
    });
    $("detailTitle").addEventListener("blur", (e) => {
      if (e.target.value.trim() && e.target.value !== t.title) {
        patchTask(t.id, { title: e.target.value.trim() }).then(loadTasks);
      }
    });
    $("dueInput").addEventListener("change", (e) => {
      patchTask(t.id, { due_at: e.target.value ? new Date(e.target.value).toISOString() : null }).then(() => { loadTasks(); loadLists(); });
    });
    // ----- REMINDER quick-pick -----
    // Compute a preset reminder time. Mirrors the inbox snooze presets.
    function presetReminder(kind) {
      const now = new Date();
      const d = new Date(now);
      if (kind === "later") {           // +3h, seconds zeroed
        d.setHours(d.getHours() + 3, 0, 0, 0);
      } else if (kind === "evening") {  // today 18:00 (or tomorrow if past)
        d.setHours(18, 0, 0, 0);
        if (d <= now) d.setDate(d.getDate() + 1);
      } else if (kind === "tomorrow") { // tomorrow 09:00
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
      } else if (kind === "nextweek") { // next Monday 09:00
        const daysUntilMon = (1 + 7 - d.getDay()) % 7 || 7;
        d.setDate(d.getDate() + daysUntilMon);
        d.setHours(9, 0, 0, 0);
      }
      return d;
    }
    async function setReminder(when) {
      const iso = when ? when.toISOString() : null;
      await patchTask(t.id, { reminder_at: iso });
      // Keep the in-memory task in sync so renderDetail (which reads
      // from _tasks) shows the new value immediately. `t` is a
      // reference into _tasks, so this updates the array too.
      t.reminder_at = iso;
      // The moment a user sets their first reminder is the natural
      // point to ask for notification permission.
      if (iso) await ensureNotifPermission();
      const pop = $("reminderPopover");
      if (pop) pop.hidden = true;
      renderDetail();   // refresh the value + clear button
      loadTasks();      // refresh the list (Planned view counts, etc.)
    }

    const reminderRow = $("reminderRow");
    const reminderPopover = $("reminderPopover");
    reminderRow?.addEventListener("click", (e) => {
      if (e.target.closest("#reminderClear")) return; // handled below
      reminderPopover.hidden = !reminderPopover.hidden;
    });
    $("reminderClear")?.addEventListener("click", (e) => {
      e.stopPropagation();
      setReminder(null);
    });
    reminderPopover?.querySelectorAll(".rp-opt").forEach((btn) => {
      btn.addEventListener("click", () => setReminder(presetReminder(btn.dataset.rp)));
    });
    $("reminderInput")?.addEventListener("change", (e) => {
      setReminder(e.target.value ? new Date(e.target.value) : null);
    });
    // Close the popover on outside click.
    document.addEventListener("click", function closeRP(ev) {
      if (!reminderPopover || reminderPopover.hidden) return;
      if (!reminderPopover.contains(ev.target) && !reminderRow.contains(ev.target)) {
        reminderPopover.hidden = true;
      }
    });
    $("notesInput").addEventListener("blur", (e) => {
      patchTask(t.id, { notes: e.target.value });
    });
    $("detailDelete").addEventListener("click", async () => {
      if (!confirm("Delete this task?")) return;
      await fetch(`/api/tasks/${t.id}`, { method: "DELETE" });
      _selected = null;
      loadTasks(); loadLists();
    });

    // Steps
    target.querySelectorAll(".step-row").forEach((row) => {
      const stepId = Number(row.dataset.stepId);
      row.querySelector(".step-check").addEventListener("click", async () => {
        const isDone = row.querySelector(".step-check").classList.contains("checked");
        await fetch(`/api/tasks/${t.id}/steps/${stepId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ completed: !isDone }),
        });
        renderDetail();
      });
      row.querySelector(".step-title").addEventListener("blur", async (e) => {
        await fetch(`/api/tasks/${t.id}/steps/${stepId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: e.target.value }),
        });
      });
      row.querySelector(".step-delete").addEventListener("click", async () => {
        await fetch(`/api/tasks/${t.id}/steps/${stepId}`, { method: "DELETE" });
        renderDetail();
      });
    });
    $("newStepInput").addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && e.target.value.trim()) {
        await fetch(`/api/tasks/${t.id}/steps`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: e.target.value.trim() }),
        });
        e.target.value = "";
        renderDetail();
      }
    });

    // Lazy-load the source email context — sender, subject, date, body
    // preview, attachments. Avoids the user having to jump back to /inbox
    // to recall what the task is about.
    if (t.source_message_id) {
      loadEmailContext(t.source_message_id);
    }
  }

  // 60-second per-id cache so re-selecting the same task doesn't re-fetch.
  const _emailCtxCache = new Map();

  async function loadEmailContext(messageId) {
    const target = document.getElementById("detailEmail");
    if (!target) return;

    const cached = _emailCtxCache.get(messageId);
    if (cached && (Date.now() - cached.at) < 60_000) {
      renderEmailContext(target, cached.data);
      return;
    }

    try {
      const r = await fetch(`/api/gmail/message/${encodeURIComponent(messageId)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      _emailCtxCache.set(messageId, { at: Date.now(), data });
      renderEmailContext(target, data);
    } catch (err) {
      target.innerHTML = `<div class="detail-email-error">Couldn't load email (${escapeHtml(err.message || String(err))})</div>`;
    }
  }

  function renderEmailContext(target, data) {
    const h = data.headers || {};
    const fromName = (h.from || "").replace(/<[^>]*>/g, "").trim().replace(/^"|"$/g, "") || h.from || "(unknown)";
    const dateLabel = h.date ? new Date(h.date).toLocaleString() : "";
    const bodyText = (data.body?.text || "").trim();
    const preview = bodyText.length > 800 ? bodyText.slice(0, 800) + "…" : bodyText;
    const attachments = Array.isArray(data.attachments) ? data.attachments : [];

    const attBlock = attachments.length
      ? `<div class="detail-email-attachments">
           ${attachments.map((a) => `
             <span class="detail-email-att" title="${escapeHtml(a.filename || "attachment")} (${fmtBytes(a.size || 0)})">
               <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 6.5L9 14a2.5 2.5 0 0 0 3.5 3.5l8-8a4 4 0 0 0-5.7-5.7l-8.8 8.9a5.5 5.5 0 0 0 7.8 7.8l7.3-7.3 1.4 1.4-7.3 7.3a7.5 7.5 0 1 1-10.6-10.6l8.8-8.9a6 6 0 1 1 8.5 8.5l-8 8a4.5 4.5 0 0 1-6.4-6.4L15 5l1.5 1.5z"/></svg>
               <span class="att-name">${escapeHtml(a.filename || "attachment")}</span>
               <span class="att-size">${fmtBytes(a.size || 0)}</span>
             </span>
           `).join("")}
         </div>`
      : "";

    target.innerHTML = `
      <div class="detail-email-head">
        <div class="detail-email-from">${escapeHtml(fromName)}</div>
        <div class="detail-email-date">${escapeHtml(dateLabel)}</div>
      </div>
      <div class="detail-email-subject">${escapeHtml(h.subject || "(no subject)")}</div>
      ${attBlock}
      <div class="detail-email-body">${escapeHtml(preview) || "<em>(empty body)</em>"}</div>
    `;
  }

  function fmtBytes(n) {
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  async function patchTask(id, patch) {
    return fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  // ----- SMART-LIST RAIL CLICKS -----
  document.querySelectorAll(".rail-item.smart[data-view]").forEach((el) => {
    el.addEventListener("click", () => switchView(el.dataset.view));
  });

  // ----- NEW LIST -----
  $("newListBtn").addEventListener("click", async () => {
    const name = prompt("New list name?");
    if (!name || !name.trim()) return;
    const r = await fetch("/api/tasks/lists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (r.ok) {
      const data = await r.json();
      await loadLists();
      switchView(Number(data.id));  // Postgres BIGINT → string; coerce.
    }
  });

  // ----- NOTIFICATION ENABLE CHIP -----
  $("notifEnableChip")?.addEventListener("click", async () => {
    await ensureNotifPermission();
  });
  refreshNotifChip();

  // ----- INIT -----
  loadLists();
  loadTasks();
})();
