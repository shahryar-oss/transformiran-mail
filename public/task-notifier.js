// Task notifier — runs on every page that has the rail. Two jobs:
//   1. Update the 'To Do' rail link with a red badge showing # of overdue tasks
//   2. Poll /api/tasks/due-soon every minute and fire browser notifications
//      when a task's due_at or reminder_at hits (within a -5 min .. +1 min window)
//
// Browser notifications require permission (the user has to click 'Allow').
// We request permission silently on the first notifiable hit, and only
// pester once per browser session.

(function() {
  // Badge updates only if a rail with a To Do link exists. Notifications
  // fire on any page that loads this script (so the user gets pinged even
  // while looking at /calendar or /contacts).
  const todoLink = document.querySelector('.folder[href="/tasks"]');

  // ---------- count badge ----------
  function ensureBadge() {
    if (!todoLink) return null;
    let badge = todoLink.querySelector(".todo-rail-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "todo-rail-badge";
      todoLink.appendChild(badge);
    }
    return badge;
  }

  async function refreshOverdueCount() {
    if (!todoLink) return;
    try {
      const r = await fetch("/api/tasks/overdue-count");
      if (!r.ok) return;
      const data = await r.json();
      const badge = ensureBadge();
      const n = Number(data.count) || 0;
      if (n > 0) {
        badge.textContent = String(n);
        badge.style.display = "";
        todoLink.title = `${n} overdue task${n === 1 ? "" : "s"}`;
      } else {
        badge.textContent = "";
        badge.style.display = "none";
        todoLink.removeAttribute("title");
      }
    } catch (_) {}
  }

  // ---------- due-soon notification poller ----------
  const FIRED_KEY = "deltaMail.firedTaskNotifications";  // localStorage
  function loadFired() {
    try {
      const raw = localStorage.getItem(FIRED_KEY);
      return new Set(JSON.parse(raw) || []);
    } catch (_) { return new Set(); }
  }
  function saveFired(set) {
    try {
      // Keep at most the last 500 IDs so localStorage doesn't grow forever.
      const arr = [...set].slice(-500);
      localStorage.setItem(FIRED_KEY, JSON.stringify(arr));
    } catch (_) {}
  }

  let permissionAsked = false;
  async function ensureNotificationPermission() {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    if (permissionAsked) return false;
    permissionAsked = true;
    try {
      const result = await Notification.requestPermission();
      return result === "granted";
    } catch (_) {
      return false;
    }
  }

  function fireNotification(task) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const dueDate = task.due_at ? new Date(task.due_at) : null;
    const reminderDate = task.reminder_at ? new Date(task.reminder_at) : null;
    const target = reminderDate || dueDate;
    const targetIsReminder = !!reminderDate &&
      (!dueDate || Math.abs(reminderDate - Date.now()) < Math.abs(dueDate - Date.now()));
    const verb = targetIsReminder ? "Reminder" : "Due now";
    const body = target
      ? `${verb} · ${target.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`
      : verb;
    try {
      const n = new Notification(`📋 ${task.title}`, {
        body,
        icon: "/delta-logo.png",
        tag: `task-${task.id}`,    // dedupes if browser fires repeatedly
        renotify: false,
      });
      n.onclick = () => {
        window.focus();
        window.location.href = `/tasks?focus=${task.id}`;
        n.close();
      };
    } catch (_) {}
  }

  async function pollDueSoon() {
    try {
      const r = await fetch("/api/tasks/due-soon");
      if (!r.ok) return;
      const data = await r.json();
      const tasks = data.tasks || [];
      if (!tasks.length) return;

      // Ask permission lazily — only when there's actually something to notify
      const allowed = await ensureNotificationPermission();
      if (!allowed) return;

      const fired = loadFired();
      for (const t of tasks) {
        // Key per (task, deadline) — re-firing after the user pushes the due
        // date should re-notify, so we include the due/reminder timestamp.
        const target = t.reminder_at || t.due_at;
        if (!target) continue;
        const key = `${t.id}@${target}`;
        if (fired.has(key)) continue;
        fireNotification({
          id: Number(t.id),
          title: t.title,
          due_at: t.due_at,
          reminder_at: t.reminder_at,
        });
        fired.add(key);
      }
      saveFired(fired);
    } catch (_) {}
  }

  // =============================================================
  // MEETING PREP notifications — fires ~15 min before each meeting
  // (or whatever the user set in Settings → Calendar). Pulls from
  // /api/meeting-prep/upcoming, dedups per event via localStorage.
  // =============================================================
  const MEETING_FIRED_KEY = "deltaMail.firedMeetingPrep";
  function loadMeetingFired() {
    try { return new Set(JSON.parse(localStorage.getItem(MEETING_FIRED_KEY) || "[]")); }
    catch (_) { return new Set(); }
  }
  function saveMeetingFired(set) {
    try { localStorage.setItem(MEETING_FIRED_KEY, JSON.stringify([...set].slice(-200))); }
    catch (_) {}
  }
  function relativeStart(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return "now";
    const m = Math.round(ms / 60000);
    return m < 1 ? "in <1 min" : `in ${m} min`;
  }
  function fireMeetingNotification(ev) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const peopleLine = ev.attendees && ev.attendees.length
      ? "With " + ev.attendees.map((a) => a.name).slice(0, 3).join(", ")
      : "";
    const recentLine = ev.attendees && ev.attendees.some((a) => a.recent && a.recent.length)
      ? " · Recent mail loaded — open to see."
      : "";
    try {
      const n = new Notification(`📅 ${ev.summary}`, {
        body: [relativeStart(ev.startISO), peopleLine + recentLine].filter(Boolean).join(" · "),
        icon: "/delta-logo.png",
        tag: `meeting-${ev.eventId}`,
        renotify: false,
      });
      n.onclick = () => {
        window.focus();
        if (ev.hangoutLink) window.open(ev.hangoutLink, "_blank");
        else if (ev.htmlLink) window.open(ev.htmlLink, "_blank");
        else window.location.href = "/calendar";
        n.close();
      };
    } catch (_) {}
  }
  async function pollMeetingPrep() {
    try {
      const r = await fetch("/api/meeting-prep/upcoming");
      if (!r.ok) return;
      const data = await r.json();
      const events = data.events || [];
      if (!events.length) return;
      if (!("Notification" in window)) return;
      if (Notification.permission !== "granted") {
        // Request permission silently on first hit; we won't fire if denied.
        try { await Notification.requestPermission(); } catch (_) {}
        if (Notification.permission !== "granted") return;
      }
      const fired = loadMeetingFired();
      for (const ev of events) {
        if (fired.has(ev.eventId)) continue;
        fireMeetingNotification(ev);
        fired.add(ev.eventId);
      }
      saveMeetingFired(fired);
    } catch (_) {}
  }

  // ---------- run ----------
  refreshOverdueCount();
  pollDueSoon();
  pollMeetingPrep();
  setInterval(refreshOverdueCount, 60_000);     // badge refresh every 60s
  setInterval(pollDueSoon, 60_000);             // due-soon poll every 60s
  setInterval(pollMeetingPrep, 120_000);        // meeting-prep poll every 2 min

  // Also refresh badge when the tab regains focus — catches new overdue
  // tasks that appeared while the tab was hidden.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshOverdueCount();
      pollMeetingPrep();
    }
  });
})();
