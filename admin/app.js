// Admin console client. All data via /api/admin/* (admin-cookie gated).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const usd = (n) => "$" + (Number(n) || 0).toFixed(2);
  const mins = (m) => {
    m = Math.round(Number(m) || 0);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  };
  const ago = (iso) => {
    if (!iso) return "never";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  };
  const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

  // ---- tabs ----
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      const tab = t.dataset.tab;
      $("tab-users").hidden = tab !== "users";
      $("tab-chats").hidden = tab !== "chats";
      if (tab === "chats") loadChats();
    });
  });

  $("logoutBtn").addEventListener("click", async () => {
    await fetch("/admin/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/admin/login";
  });

  // ---- overview + users ----
  async function loadOverview() {
    try {
      const r = await fetch("/api/admin/overview");
      if (!r.ok) throw new Error();
      const d = await r.json();
      $("kpis").innerHTML = [
        { v: d.users, l: "Total users", sub: d.activeToday + " active today" },
        { v: d.active7d, l: "Active (7 days)" },
        { v: usd(d.cost30d), l: "Delta cost (30d)", sub: d.calls30d + " calls" },
        { v: d.sends30d, l: "Emails sent (30d)" },
        { v: usd(d.costAllTime), l: "Delta cost (all-time)" },
      ].map((k) => `<div class="kpi"><div class="v">${esc(k.v)}</div><div class="l">${esc(k.l)}</div>${k.sub ? `<div class="sub2">${esc(k.sub)}</div>` : ""}</div>`).join("");
    } catch (_) { $("kpis").innerHTML = `<div class="loading">Couldn't load overview.</div>`; }
  }

  async function loadUsers() {
    try {
      const r = await fetch("/api/admin/users");
      if (!r.ok) throw new Error();
      const { users } = await r.json();
      if (!users.length) { $("usersBody").innerHTML = `<tr><td colspan="8" class="loading">No users yet.</td></tr>`; return; }
      $("usersBody").innerHTML = users.map((u) => `
        <tr class="clickable" data-id="${u.id}">
          <td><div class="row-name">${esc(u.display_name || u.email.split("@")[0])}</div><div class="row-email">${esc(u.email)}</div></td>
          <td>${esc(ago(u.last_active))}</td>
          <td class="num">${esc(mins(u.minutes30d))}</td>
          <td class="num">${esc(u.sends30d)}</td>
          <td class="num">${esc(u.calls30d)}</td>
          <td class="num">${esc(usd(u.cost30d))}</td>
          <td>${u.blocked_at ? `<span class="badge blocked">Blocked</span>` : `<span class="badge active">Active</span>`}</td>
          <td>${u.blocked_at
              ? `<button class="act-btn unblock" data-unblock="${u.id}">Unblock</button>`
              : `<button class="act-btn block" data-block="${u.id}">Block</button>`}</td>
        </tr>`).join("");
      // row → drawer
      $("usersBody").querySelectorAll("tr.clickable").forEach((tr) => {
        tr.addEventListener("click", (e) => {
          if (e.target.closest("[data-block]") || e.target.closest("[data-unblock]")) return;
          openDrawer(tr.dataset.id);
        });
      });
      $("usersBody").querySelectorAll("[data-block]").forEach((b) =>
        b.addEventListener("click", () => blockUser(b.dataset.block, true)));
      $("usersBody").querySelectorAll("[data-unblock]").forEach((b) =>
        b.addEventListener("click", () => blockUser(b.dataset.unblock, false)));
    } catch (_) { $("usersBody").innerHTML = `<tr><td colspan="8" class="loading">Couldn't load users.</td></tr>`; }
  }

  async function blockUser(id, block) {
    const verb = block ? "block" : "unblock";
    let reason = "";
    if (block) { reason = prompt("Reason for blocking (optional):") || ""; if (reason === null) return; }
    else if (!confirm("Unblock this user?")) return;
    try {
      const r = await fetch(`/api/admin/user/${id}/${verb}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!r.ok) throw new Error();
      loadUsers(); loadOverview();
    } catch (_) { alert(`Couldn't ${verb} user.`); }
  }

  // ---- per-user drawer ----
  $("drawerClose").addEventListener("click", closeDrawer);
  $("drawerBack").addEventListener("click", closeDrawer);
  function closeDrawer() { $("drawer").classList.remove("open"); $("drawerBack").classList.remove("open"); }
  async function openDrawer(id) {
    $("drawerBody").innerHTML = `<div class="loading">Loading…</div>`;
    $("drawer").classList.add("open"); $("drawerBack").classList.add("open");
    try {
      const r = await fetch(`/api/admin/user/${id}`);
      if (!r.ok) throw new Error();
      const d = await r.json();
      $("dUserName").textContent = d.user.display_name || d.user.email.split("@")[0];
      $("dUserEmail").textContent = d.user.email;
      const stat = [
        ["Joined", when(d.user.created_at)],
        ["Last active", ago(d.user.last_active)],
        ["Time on app (30d)", mins(d.minutes30d)],
        ["Emails sent (all-time)", d.sendsAll],
        ["Emails sent (30d)", d.sends30d],
        ["Delta calls (30d)", d.calls30d],
        ["Delta cost (30d)", usd(d.cost30d)],
        ["Delta cost (all-time)", usd(d.costAll)],
        ["Preferred model", d.user.preferred_model || "basic"],
        ["Status", d.user.blocked_at ? "BLOCKED" : "Active"],
      ];
      const chats = (d.recentChats || []).map((c) => `
        <div class="chat-turn ${c.role === "user" ? "user" : ""}">
          <div class="who">${c.role === "user" ? "User" : "Delta"}<span class="when">${esc(when(c.created_at))}${c.model ? " · " + esc(c.model) : ""}</span></div>
          <div class="txt">${esc(c.content || "")}</div>
        </div>`).join("") || `<div class="muted">No Delta chats recorded yet.</div>`;
      $("drawerBody").innerHTML = `
        <table style="margin-bottom:8px">${stat.map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td style="text-align:right;font-weight:600">${esc(v)}</td></tr>`).join("")}</table>
        <div class="sec-label">Recent Delta chat</div>
        ${chats}`;
    } catch (_) { $("drawerBody").innerHTML = `<div class="loading">Couldn't load user.</div>`; }
  }

  // ---- chat monitoring ----
  async function loadChats() {
    $("chatsList").className = "loading"; $("chatsList").textContent = "Loading…";
    try {
      const r = await fetch("/api/admin/chats/recent");
      if (!r.ok) throw new Error();
      const { turns } = await r.json();
      $("chatsList").className = "";
      if (!turns.length) { $("chatsList").innerHTML = `<div class="muted">No Delta chats recorded yet. They'll appear here as people use Delta.</div>`; return; }
      $("chatsList").innerHTML = turns.map((c) => `
        <div class="chat-turn ${c.role === "user" ? "user" : ""}">
          <div class="who">${c.role === "user" ? "User" : "Delta"} · ${esc(c.email || "?")}<span class="when">${esc(when(c.created_at))}${c.model ? " · " + esc(c.model) : ""}</span></div>
          <div class="txt">${esc(c.content || "")}</div>
        </div>`).join("");
    } catch (_) { $("chatsList").className = ""; $("chatsList").innerHTML = `<div class="muted">Couldn't load chats.</div>`; }
  }

  // init
  loadOverview();
  loadUsers();
})();
