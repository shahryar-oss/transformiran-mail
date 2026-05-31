// Admin console client. Data via /api/admin/* (admin-cookie gated).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const usd = (n) => "$" + (Number(n) || 0).toFixed(2);
  const usd4 = (n) => { n = Number(n) || 0; return n < 1 ? "$" + n.toFixed(3) : "$" + n.toFixed(2); };
  const mins = (m) => { m = Math.round(Number(m) || 0); if (m < 60) return m + "m"; return Math.floor(m / 60) + "h " + (m % 60) + "m"; };
  const ago = (iso) => {
    if (!iso) return "never";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  };
  const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

  let WIN = 30; // selected window in days

  // ---- window selector + tabs ----
  $("winSel").addEventListener("change", () => { WIN = Number($("winSel").value) || 30; loadOverviewTab(); });
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      const tab = t.dataset.tab;
      $("tab-overview").hidden = tab !== "overview";
      $("tab-chats").hidden = tab !== "chats";
      if (tab === "chats") loadChats();
    });
  });
  $("logoutBtn").addEventListener("click", async () => {
    await fetch("/admin/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/admin/login";
  });

  // ===== inline SVG charts (no library) =====
  function areaChart(points, { w = 560, h = 180, fmt = (v) => v } = {}) {
    if (!points.length) return `<div class="muted" style="padding:24px 0">No data in this window yet.</div>`;
    const m = { top: 12, right: 12, bottom: 22, left: 44 };
    const iw = w - m.left - m.right, ih = h - m.top - m.bottom;
    const max = Math.max(...points.map((p) => p.v), 0) * 1.1 || 1;
    const x = (i) => m.left + (points.length === 1 ? iw / 2 : iw * i / (points.length - 1));
    const y = (v) => m.top + ih * (1 - v / max);
    let body = "";
    for (let i = 0; i <= 4; i++) {
      const yy = m.top + ih * (1 - i / 4);
      body += `<line class="grid" x1="${m.left}" y1="${yy}" x2="${m.left + iw}" y2="${yy}"/>`;
      body += `<text class="axis-text" x="${m.left - 6}" y="${yy + 3}" text-anchor="end">${fmt(max * i / 4)}</text>`;
    }
    const skip = Math.max(1, Math.ceil(points.length / 8));
    points.forEach((p, i) => { if (i % skip === 0 || i === points.length - 1)
      body += `<text class="axis-text" x="${x(i)}" y="${m.top + ih + 15}" text-anchor="middle">${esc((p.label || "").slice(5))}</text>`; });
    const line = points.map((p, i) => `${x(i)},${y(p.v)}`).join(" ");
    body += `<polygon class="area" points="${m.left},${m.top + ih} ${line} ${m.left + iw},${m.top + ih}"/>`;
    body += `<polyline class="line" points="${line}"/>`;
    points.forEach((p, i) => { body += `<circle class="pt" cx="${x(i)}" cy="${y(p.v)}" r="2.5"><title>${esc(p.label)}: ${fmt(p.v)}</title></circle>`; });
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" height="${h}">${body}</svg>`;
  }

  // ---- overview tab (KPIs + charts + users) ----
  async function loadOverviewTab() { await Promise.all([loadOverview(), loadCharts(), loadUsers()]); }

  async function loadOverview() {
    try {
      const d = await (await fetch("/api/admin/overview")).json();
      $("kpis").innerHTML = [
        { v: d.users, l: "Total users", sub: d.activeToday + " active today" },
        { v: d.active7d, l: "Active (7 days)" },
        { v: usd(d.cost30d), l: "Delta cost (30d)", sub: d.calls30d + " calls" },
        { v: d.sends30d, l: "Emails sent (30d)" },
        { v: usd(d.costAllTime), l: "Delta cost (all-time)" },
      ].map((k) => `<div class="kpi"><div class="v">${esc(k.v)}</div><div class="l">${esc(k.l)}</div>${k.sub ? `<div class="sub2">${esc(k.sub)}</div>` : ""}</div>`).join("");
    } catch (_) { $("kpis").innerHTML = `<div class="loading">Couldn't load overview.</div>`; }
  }

  async function loadCharts() {
    try {
      const d = await (await fetch(`/api/admin/timeseries?days=${WIN}`)).json();
      $("costChartSub").textContent = `Daily Anthropic spend — last ${WIN} days.`;
      $("costChart").className = "";
      $("costChart").innerHTML = areaChart((d.byDay || []).map((r) => ({ label: r.day, v: r.cost })), { fmt: (v) => "$" + (v >= 1 ? v.toFixed(0) : v.toFixed(2)) });
      // by-model bars
      const bm = d.byModel || [];
      const maxCost = Math.max(...bm.map((m) => m.cost), 0) || 1;
      $("modelChart").className = "";
      $("modelChart").innerHTML = bm.length
        ? bm.map((m) => `<div class="model-row"><span class="mname" title="${esc(m.model)}">${esc(m.model)}</span><span class="mbar"><i style="width:${Math.max(3, (m.cost / maxCost) * 100)}%"></i></span><span class="mval">${usd4(m.cost)}</span></div>`).join("")
            + `<div class="muted" style="font-size:11.5px;margin-top:4px">${bm.reduce((a, m) => a + m.calls, 0)} calls total</div>`
        : `<div class="muted" style="padding:24px 0">No Delta usage in this window yet.</div>`;
    } catch (_) {
      $("costChart").innerHTML = `<div class="muted">Couldn't load chart.</div>`;
      $("modelChart").innerHTML = `<div class="muted">Couldn't load chart.</div>`;
    }
  }

  async function loadUsers() {
    try {
      const { users } = await (await fetch(`/api/admin/users?days=${WIN}`)).json();
      if (!users.length) { $("usersBody").innerHTML = `<tr><td colspan="8" class="loading">No users yet.</td></tr>`; return; }
      $("usersBody").innerHTML = users.map((u) => `
        <tr class="clickable" data-id="${u.id}">
          <td><div class="row-name">${esc(u.display_name || u.email.split("@")[0])}</div><div class="row-email">${esc(u.email)}</div></td>
          <td>${esc(ago(u.last_active))}</td>
          <td class="num">${esc(mins(u.minutes30d))}</td>
          <td class="num">${esc(u.sends30d)}</td>
          <td class="num">${esc(u.calls30d)}</td>
          <td class="num">${esc(usd4(u.cost30d))}</td>
          <td>${u.blocked_at ? `<span class="badge blocked">Blocked</span>` : `<span class="badge active">Active</span>`}</td>
          <td>${u.blocked_at ? `<button class="act-btn unblock" data-unblock="${u.id}">Unblock</button>` : `<button class="act-btn block" data-block="${u.id}">Block</button>`}</td>
        </tr>`).join("");
      $("usersBody").querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", (e) => {
        if (e.target.closest("[data-block]") || e.target.closest("[data-unblock]")) return;
        openDrawer(tr.dataset.id);
      }));
      $("usersBody").querySelectorAll("[data-block]").forEach((b) => b.addEventListener("click", () => blockUser(b.dataset.block, true)));
      $("usersBody").querySelectorAll("[data-unblock]").forEach((b) => b.addEventListener("click", () => blockUser(b.dataset.unblock, false)));
    } catch (_) { $("usersBody").innerHTML = `<tr><td colspan="8" class="loading">Couldn't load users.</td></tr>`; }
  }

  async function blockUser(id, block) {
    let reason = "";
    if (block) { reason = prompt("Reason for blocking (optional):"); if (reason === null) return; }
    else if (!confirm("Unblock this user?")) return;
    try {
      const r = await fetch(`/api/admin/user/${id}/${block ? "block" : "unblock"}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason || "" }),
      });
      if (!r.ok) throw new Error();
      loadUsers(); loadOverview();
    } catch (_) { alert(`Couldn't ${block ? "block" : "unblock"} user.`); }
  }

  // ---- per-user drawer ----
  $("drawerClose").addEventListener("click", closeDrawer);
  $("drawerBack").addEventListener("click", closeDrawer);
  function closeDrawer() { $("drawer").classList.remove("open"); $("drawerBack").classList.remove("open"); }
  async function openDrawer(id) {
    $("drawerBody").innerHTML = `<div class="loading">Loading…</div>`;
    $("drawer").classList.add("open"); $("drawerBack").classList.add("open");
    try {
      const d = await (await fetch(`/api/admin/user/${id}`)).json();
      $("dUserName").textContent = d.user.display_name || d.user.email.split("@")[0];
      $("dUserEmail").textContent = d.user.email;
      const stat = [
        ["Joined", when(d.user.created_at)], ["Last active", ago(d.user.last_active)],
        ["Time on app (30d)", mins(d.minutes30d)],
        ["Emails sent (all-time)", d.sendsAll], ["Emails sent (30d)", d.sends30d],
        ["Delta calls (30d)", d.calls30d], ["Delta cost (30d)", usd4(d.cost30d)],
        ["Delta cost (all-time)", usd4(d.costAll)], ["Preferred model", d.user.preferred_model || "basic"],
        ["Status", d.user.blocked_at ? "BLOCKED" + (d.user.blocked_reason ? " — " + d.user.blocked_reason : "") : "Active"],
      ];
      const chats = (d.recentChats || []).length
        ? (d.recentChats || []).map((c) => `
          <div class="turn"><div class="thead">${c.role === "user" ? '<span class="who-u">User</span>' : '<span class="pill">Delta</span>'}<span>${esc(when(c.created_at))}</span>${c.model ? `<span class="pill">${esc(c.model)}</span>` : ""}</div>
            <div class="${c.role === "user" ? "msg" : "reply"}">${esc(c.content || "")}</div></div>`).join("")
        : `<div class="muted">No Delta chats recorded yet.</div>`;
      $("drawerBody").innerHTML =
        `<table>${stat.map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td style="text-align:right;font-weight:600">${esc(v)}</td></tr>`).join("")}</table>
         <div class="sec-label">Recent Delta chat</div>${chats}`;
    } catch (_) { $("drawerBody").innerHTML = `<div class="loading">Couldn't load user.</div>`; }
  }

  // ---- chat monitoring (turn-based) ----
  async function loadChats() {
    $("chatsList").className = "loading"; $("chatsList").textContent = "Loading…";
    try {
      const { turns } = await (await fetch("/api/admin/chats/recent")).json();
      $("chatsList").className = "";
      if (!turns.length) { $("chatsList").innerHTML = `<div class="card muted">No Delta chats recorded yet. They'll appear here as people use Delta.</div>`; return; }
      $("chatsList").innerHTML = turns.map((c) => `
        <div class="turn">
          <div class="thead">
            ${c.role === "user" ? '<span class="who-u">User</span>' : '<span class="pill">Delta</span>'}
            <span>${esc(c.email || "?")}</span><span>${esc(when(c.created_at))}</span>${c.model ? `<span class="pill">${esc(c.model)}</span>` : ""}
          </div>
          <div class="${c.role === "user" ? "msg" : "reply"}">${esc(c.content || "")}</div>
        </div>`).join("");
    } catch (_) { $("chatsList").className = ""; $("chatsList").innerHTML = `<div class="card muted">Couldn't load chats.</div>`; }
  }

  // init
  loadOverviewTab();
})();
