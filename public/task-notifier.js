// Notifier — runs on every authenticated page. Four jobs:
//   1. Update the 'To Do' rail link with a red badge showing # of overdue tasks.
//   2. Fire browser notifications for tasks due / reminders triggered.
//   3. Fire browser notifications for new INBOX emails that pass the
//      user's notify_settings (mode/always/never contacts + quiet hours
//      + per-hour budget).
//   4. Fire browser notifications for upcoming meetings (~15 min before).
//
// Browser notifications require permission (user clicks 'Allow').
// We request permission silently on the first notifiable hit, and only
// pester once per browser session.
//
// Quiet hours + per-hour budget are enforced client-side because the
// server doesn't track per-tab firing counts. The 'always notify'
// override skips quiet-hours but still counts toward budget.

(function() {
  const todoLink = document.querySelector('.folder[href="/tasks"]');

  // =============================================================
  // BADGE on the To Do rail link
  // =============================================================
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

  // =============================================================
  // Notify-settings cache + quiet-hours + budget checks
  // =============================================================
  let _notifySettings = null;
  let _notifySettingsAt = 0;
  async function getNotifySettings() {
    // Refresh from server every 5 min — long enough to be cheap, short
    // enough that pref changes propagate without a page reload.
    if (_notifySettings && Date.now() - _notifySettingsAt < 5 * 60 * 1000) return _notifySettings;
    try {
      const r = await fetch("/api/me/notify-settings");
      if (!r.ok) return null;
      const d = await r.json();
      _notifySettings = d.notify_settings;
      _notifySettingsAt = Date.now();
      return _notifySettings;
    } catch (_) { return null; }
  }

  function nowInQuietHours(s) {
    if (!s || !s.quietHours || !s.quietHours.enabled) return false;
    const qh = s.quietHours;
    const now = new Date();
    // 0=Sun … 6=Sat (matches our server-side schema)
    const day = now.getDay();
    if (Array.isArray(qh.days) && qh.days.length && !qh.days.includes(day)) return false;
    const [sH, sM] = (qh.startHHMM || "18:00").split(":").map(Number);
    const [eH, eM] = (qh.endHHMM   || "09:00").split(":").map(Number);
    const minutesNow   = now.getHours() * 60 + now.getMinutes();
    const minutesStart = sH * 60 + sM;
    const minutesEnd   = eH * 60 + eM;
    if (minutesStart === minutesEnd) return false;
    if (minutesStart < minutesEnd) {
      return minutesNow >= minutesStart && minutesNow < minutesEnd;
    }
    // Wraps midnight (e.g. 18:00 → 09:00 next morning).
    return minutesNow >= minutesStart || minutesNow < minutesEnd;
  }

  // Hourly budget — track firings per current hour bucket in localStorage.
  const BUDGET_KEY = "deltaMail.notifBudget"; // { hourKey, count }
  function loadBudget() {
    try {
      const raw = localStorage.getItem(BUDGET_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      return o && typeof o === "object" ? o : null;
    } catch (_) { return null; }
  }
  function saveBudget(o) {
    try { localStorage.setItem(BUDGET_KEY, JSON.stringify(o)); } catch (_) {}
  }
  function hourKey() { return new Date().toISOString().slice(0, 13); } // YYYY-MM-DDTHH
  function budgetAllows(s) {
    if (!s) return true;
    if (!Number.isFinite(s.budgetPerHour) || s.budgetPerHour <= 0) return true;
    const cur = loadBudget();
    const key = hourKey();
    if (!cur || cur.hourKey !== key) return true; // fresh hour
    return cur.count < s.budgetPerHour;
  }
  function recordBudgetFire() {
    const key = hourKey();
    const cur = loadBudget();
    if (!cur || cur.hourKey !== key) { saveBudget({ hourKey: key, count: 1 }); return; }
    saveBudget({ hourKey: key, count: cur.count + 1 });
  }

  // =============================================================
  // Permission gate
  // =============================================================
  let permissionAsked = false;
  async function ensureNotificationPermission() {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    if (permissionAsked) return false;
    permissionAsked = true;
    try { return (await Notification.requestPermission()) === "granted"; }
    catch (_) { return false; }
  }

  // =============================================================
  // TASK notifications
  // =============================================================
  const TASK_FIRED_KEY = "deltaMail.firedTaskNotifications";
  function loadTaskFired() {
    try { return new Set(JSON.parse(localStorage.getItem(TASK_FIRED_KEY) || "[]")); }
    catch (_) { return new Set(); }
  }
  function saveTaskFired(set) {
    try { localStorage.setItem(TASK_FIRED_KEY, JSON.stringify([...set].slice(-500))); }
    catch (_) {}
  }

  function fireTaskNotification(task) {
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
        tag: `task-${task.id}`,
        renotify: false,
      });
      n.onclick = () => { window.focus(); window.location.href = `/tasks?focus=${task.id}`; n.close(); };
    } catch (_) {}
  }

  async function pollTasks() {
    try {
      const r = await fetch("/api/tasks/due-soon");
      if (!r.ok) return;
      const data = await r.json();
      const tasks = data.tasks || [];
      if (!tasks.length) return;

      const settings = await getNotifySettings();
      if (settings && settings.mode === "off") return;
      if (nowInQuietHours(settings)) return;
      const allowed = await ensureNotificationPermission();
      if (!allowed) return;

      const fired = loadTaskFired();
      for (const t of tasks) {
        if (!budgetAllows(settings)) break;
        const target = t.reminder_at || t.due_at;
        if (!target) continue;
        const key = `${t.id}@${target}`;
        if (fired.has(key)) continue;
        fireTaskNotification({
          id: Number(t.id),
          title: t.title,
          due_at: t.due_at,
          reminder_at: t.reminder_at,
        });
        fired.add(key);
        recordBudgetFire();
      }
      saveTaskFired(fired);
    } catch (_) {}
  }

  // =============================================================
  // EMAIL notifications — new INBOX mail that passes notify_settings
  // =============================================================
  const EMAIL_CURSOR_KEY = "deltaMail.emailNotifyCursorMs";
  const EMAIL_FIRED_KEY  = "deltaMail.firedEmailNotifications";
  function loadEmailCursor() {
    try { return Number(localStorage.getItem(EMAIL_CURSOR_KEY)) || (Date.now() - 5 * 60 * 1000); }
    catch (_) { return Date.now() - 5 * 60 * 1000; }
  }
  function saveEmailCursor(ms) {
    try { localStorage.setItem(EMAIL_CURSOR_KEY, String(ms)); } catch (_) {}
  }
  function loadEmailFired() {
    try { return new Set(JSON.parse(localStorage.getItem(EMAIL_FIRED_KEY) || "[]")); }
    catch (_) { return new Set(); }
  }
  function saveEmailFired(set) {
    try { localStorage.setItem(EMAIL_FIRED_KEY, JSON.stringify([...set].slice(-200))); }
    catch (_) {}
  }

  function fireEmailNotification(msg, preview) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const fromName = msg.from_name || (msg.from_email || "").split("@")[0] || "New email";
    const cat = (msg.category || "").toUpperCase();
    const prefix = cat === "URGENT" ? "🚨 " : cat === "REPLY_NEEDED" ? "↩️ " : "📧 ";
    const title = `${prefix}${fromName}`;
    const body = preview
      ? (msg.subject ? `${msg.subject} — ${msg.snippet || ""}` : (msg.snippet || ""))
      : (msg.subject || "(no subject)");
    try {
      const n = new Notification(title, {
        body: body.slice(0, 220),
        icon: "/delta-logo.png",
        tag: `email-${msg.message_id}`,
        renotify: false,
      });
      n.onclick = () => {
        window.focus();
        // Open the inbox + try to focus the thread.
        window.location.href = `/?thread=${encodeURIComponent(msg.thread_id || msg.message_id)}`;
        n.close();
      };
    } catch (_) {}
  }

  async function pollEmails() {
    try {
      const settings = await getNotifySettings();
      if (settings && settings.mode === "off") return;

      const cursor = loadEmailCursor();
      const r = await fetch(`/api/inbox/notifiable-new?since_ms=${cursor}`);
      if (!r.ok) return;
      const data = await r.json();
      const msgs = data.messages || [];
      const prefs = data.preferences || { sound: true, preview: true };

      // Advance cursor to the newest message we saw, even if we suppress
      // notifications for it (so we don't re-process forever).
      let maxSeen = cursor;
      for (const m of msgs) if (m.internal_date > maxSeen) maxSeen = m.internal_date;
      if (maxSeen > cursor) saveEmailCursor(maxSeen);

      if (!msgs.length) return;
      if (nowInQuietHours(settings)) return;
      const allowed = await ensureNotificationPermission();
      if (!allowed) return;

      const fired = loadEmailFired();
      for (const m of msgs) {
        if (!budgetAllows(settings)) break;
        if (fired.has(m.message_id)) continue;
        fireEmailNotification(m, prefs.preview !== false);
        fired.add(m.message_id);
        recordBudgetFire();
      }
      saveEmailFired(fired);
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

  // =============================================================
  // ACTIVITY HEARTBEAT — pings the server while the tab is visible so
  // the admin console can measure time-on-app. Only fires when the tab
  // is actually in the foreground (no time credited while hidden).
  // =============================================================
  function heartbeat() {
    if (document.hidden) return;
    fetch("/api/me/heartbeat", { method: "POST" }).catch(() => {});
  }

  // =============================================================
  // RUN
  // =============================================================
  refreshOverdueCount();
  pollTasks();
  pollEmails();
  pollMeetingPrep();
  heartbeat();
  setInterval(refreshOverdueCount, 60_000);     // badge refresh every 60s
  setInterval(pollTasks,           60_000);     // due-soon poll every 60s
  setInterval(pollEmails,          60_000);     // new-email poll every 60s
  setInterval(pollMeetingPrep,    120_000);     // meeting-prep poll every 2 min
  setInterval(heartbeat,           60_000);     // activity heartbeat every 60s

  // Also refresh when the tab regains focus.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshOverdueCount();
      pollTasks();
      pollEmails();
      pollMeetingPrep();
      heartbeat();
    }
  });
})();
