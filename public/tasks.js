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
  };

  // ----- STATE -----
  let _view = "my-day";
  let _viewTitle = "My Day";
  let _lists = [];
  let _tasks = [];
  let _selected = null; // selected task id

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

  function renderTasks() {
    const target = $("taskList");
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

  function taskRowHtml(t) {
    const isSelected = _selected === t.id;
    const isCompleted = !!t.completed_at;
    const dueText = formatDue(t.due_at);
    const isOverdue = t.due_at && !isCompleted && new Date(t.due_at) < new Date();
    return `
      <div class="task-row ${isCompleted ? "completed" : ""} ${isSelected ? "selected" : ""}" data-id="${t.id}">
        <div class="task-checkbox"></div>
        <div class="task-body">
          <div class="task-title">${escapeHtml(t.title)}</div>
          <div class="task-meta">
            ${t.list_id ? `<span>${escapeHtml(listName(t.list_id))}</span>` : ""}
            ${dueText ? `<span class="due ${isOverdue ? "overdue" : ""}"><span class="meta-i">${ICONS.calendar}</span>${escapeHtml(dueText)}</span>` : ""}
            ${t.in_my_day && _view !== "my-day" ? `<span class="my-day-tag"><span class="meta-i">${ICONS.sun}</span>My Day</span>` : ""}
            ${t.source_message_id ? `<a class="src-link" href="/#${escapeHtml(t.source_message_id)}" onclick="event.stopPropagation()"><span class="meta-i">${ICONS.envelope}</span>from email</a>` : ""}
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

  async function toggleComplete(id) {
    const t = _tasks.find((x) => x.id === id);
    if (!t) return;
    const completed = !t.completed_at;
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
        <div class="detail-row ${t.reminder_at ? "" : "empty"}">
          <span class="icon">${ICONS.clock}</span>
          <input type="datetime-local" id="reminderInput" value="${reminderForInput}" placeholder="Add reminder">
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

      <div class="detail-foot">
        <span>Created ${new Date(t.created_at).toLocaleString()}</span>
        <div class="detail-foot-spacer"></div>
        ${t.source_message_id ? `<a class="src-link" href="/" style="color:var(--gold-dark);text-decoration:none;font-weight:600;font-size:11.5px;display:inline-flex;align-items:center;gap:4px"><span class="meta-i" style="display:inline-grid;place-items:center"><svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:currentColor"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg></span> from email →</a>` : ""}
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
    $("reminderInput").addEventListener("change", (e) => {
      patchTask(t.id, { reminder_at: e.target.value ? new Date(e.target.value).toISOString() : null });
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

  // ----- INIT -----
  loadLists();
  loadTasks();
})();
