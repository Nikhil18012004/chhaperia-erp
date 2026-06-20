/* ============================================================
   CHHAPERIA ERP — SUPERVISOR PANEL (SUP)  ·  HYBRID
   Renders INSIDE the admin shell (#app) so it inherits the
   sidebar, topbar, dynamic accent + dark/light theme — but the
   nav is limited to production, and the content is big, tap-
   friendly job cards (no money, no sales, area-scoped).

   Status flow:
     Pending → In Production → Completed → [Packed → Dispatched]
   (Packed/Dispatched only for the slitting area, which packs.)
   ============================================================ */
(function (global) {
  "use strict";
  const H = UI.h, esc = UI.esc, toast = UI.toast;
  const { pageHead, kpi } = MW;

  const AREA_LABEL = { coating: "Coating / Lamination", slitting: "Slitting & Dispatch", fiberglass: "Fiber-Glass & Slitting", all: "All Production" };
  const AREA_ICON = { coating: "🎨", slitting: "✂️", fiberglass: "🧵", all: "🏭" };

  const STATUS = {
    "Pending":       { label: "To Do",        color: "var(--text-mut)", next: "In Production", nextLabel: "▶ Start" },
    "Released":      { label: "To Do",        color: "var(--text-mut)", next: "In Production", nextLabel: "▶ Start" },
    "In Progress":   { label: "In Production", color: "var(--info)",     next: "Completed",     nextLabel: "✓ Mark Done" },
    "In Production": { label: "In Production", color: "var(--info)",     next: "Completed",     nextLabel: "✓ Mark Done" },
    "Completed":     { label: "Done",          color: "var(--ok)",       next: "Packed",        nextLabel: "📦 Mark Packed", slitOnly: true },
    "Packed":        { label: "Packed",        color: "var(--accent)",   next: "Dispatched",    nextLabel: "🚚 Mark Dispatched", slitOnly: true },
    "Dispatched":    { label: "Dispatched",    color: "var(--ok)",       next: null },
  };
  function bucket(s) {
    if (["Pending", "Released"].includes(s)) return "todo";
    if (["In Progress", "In Production"].includes(s)) return "doing";
    if (s === "Completed") return "done";
    if (s === "Packed") return "packed";
    if (s === "Dispatched") return "dispatched";
    return "todo";
  }

  const SUP = {
    user: null, area: "all", data: null, filter: "active",

    async boot(user) {
      this.user = user;
      this.area = user.area || "all";

      // theme is supervisor-local (they can't write server settings)
      const theme = (function(){ try { return localStorage.getItem("chh_theme"); } catch { return null; } })() || "dark";
      document.documentElement.setAttribute("data-theme", theme);
      document.documentElement.setAttribute("data-accent", "orange");

      // reveal the admin shell in supervisor mode
      const sp = UI.$("#splash"); if (sp) { sp.classList.add("hide"); setTimeout(() => sp.remove(), 600); }
      UI.$("#login").hidden = true;
      const app = UI.$("#app"); app.hidden = false; app.classList.add("sup-mode");

      this.bindChrome();
      this.setUserChip();
      await this.refresh();
    },

    bindChrome() {
      const tt = UI.$("#themeToggle");
      if (tt) tt.onclick = () => {
        const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", cur);
        try { localStorage.setItem("chh_theme", cur); } catch {}
      };
      const mt = UI.$("#menuToggle"); if (mt) mt.onclick = () => UI.$("#app").classList.toggle("collapsed");
      const lo = UI.$("#logoutBtn"); if (lo) lo.onclick = () => App.logout();
      const on = UI.$("#orgName"), os = UI.$("#orgSub");
      if (on) on.textContent = (this.data && this.data.org ? this.data.org.short : "Chhaperia");
      if (os) os.textContent = "Production Floor";
    },

    setUserChip() {
      const u = this.user;
      const nm = UI.$("#userName"), rl = UI.$("#userRole"), av = UI.$("#userAvatar");
      if (nm) nm.textContent = u.name || u.username;
      if (rl) rl.textContent = "Supervisor · " + (AREA_LABEL[this.area] || this.area);
      if (av) av.textContent = (u.name || u.username).split(" ").map(x => x[0]).slice(0, 2).join("").toUpperCase();
    },

    async refresh() {
      const view = UI.$("#view");
      view.innerHTML = '<div class="sup-loading">Loading your jobs…</div>';
      try {
        this.data = await DB.loadAsync(); // role-scoped supervisor view
        if (this.data && this.data.org) { const on = UI.$("#orgName"); if (on) on.textContent = this.data.org.short; }
        this.buildNav();
        this.render();
      } catch (err) {
        view.innerHTML = '<div class="sup-loading">⚠ ' + esc(err.message) + '</div>';
      }
    },

    groups() {
      const g = { todo: [], doing: [], done: [], packed: [], dispatched: [] };
      (this.data.workorders || []).forEach((w) => g[bucket(w.status)].push(w));
      return g;
    },

    buildNav() {
      const isSlit = this.area === "slitting" || this.area === "all";
      const g = this.groups();
      const items = [
        { sec: "Production" },
        { id: "active", ic: "⚙️", label: "Active Jobs", pill: g.todo.length + g.doing.length },
      ];
      if (isSlit) items.push({ id: "packing", ic: "📦", label: "To Pack / Ship", pill: g.done.length + g.packed.length });
      items.push({ id: "done", ic: "✅", label: "Completed" });
      items.push({ id: "all", ic: "📋", label: "All Jobs" });

      const nav = UI.$("#nav"); nav.innerHTML = "";
      items.forEach((n) => {
        if (n.sec) { nav.appendChild(H("div", { class: "nav-section", text: n.sec })); return; }
        const item = H("div", { class: "nav-item" + (n.id === this.filter ? " active" : ""), onclick: () => { this.filter = n.id; this.buildNav(); this.render(); } }, [
          H("span", { class: "ic", text: n.ic }),
          H("span", { class: "lbl", text: n.label }),
        ]);
        if (n.pill) item.appendChild(H("span", { class: "pill", text: n.pill }));
        nav.appendChild(item);
      });
    },

    render() {
      const view = UI.$("#view"); view.innerHTML = "";
      view.classList.remove("fade-in"); void view.offsetWidth; view.classList.add("fade-in");

      const g = this.groups();
      const isSlit = this.area === "slitting" || this.area === "all";
      const titleMap = { active: "Active Jobs", packing: "To Pack / Ship", done: "Completed Jobs", all: "All Jobs" };

      // crumbs
      UI.$("#crumbs").innerHTML = `<span>Chhaperia</span><span class="sep">/</span><span class="cur">${esc(titleMap[this.filter] || "My Jobs")}</span>`;

      // header
      view.appendChild(pageHead(
        AREA_ICON[this.area] + " " + (AREA_LABEL[this.area] || this.area),
        "Your production jobs — tap to update status. Packing & dispatch happen here for slitting.",
        [ H("button", { class: "btn", onclick: () => this.refresh(), html: "↻ Refresh" }) ]
      ));

      // KPI summary cards (admin look)
      view.appendChild(H("div", { class: "grid kpi-grid", style: "margin-bottom:18px" }, [
        kpi({ icon: "📋", label: "To Do", value: g.todo.length, deltaType: "flat", delta: "waiting to start", onClick: () => { this.filter = "active"; this.buildNav(); this.render(); } }),
        kpi({ icon: "⚙️", label: "In Production", value: g.doing.length, deltaType: "flat", delta: "being made now" }),
        kpi({ icon: "✅", label: isSlit ? "Done · to pack" : "Completed", value: g.done.length, deltaType: "up", delta: isSlit ? "ready for packing" : "finished" }),
        isSlit ? kpi({ icon: "🚚", label: "Dispatched", value: g.dispatched.length, deltaType: "up", delta: "shipped out" })
               : kpi({ icon: "🧱", label: "Materials", value: (this.data.stockItems || []).length, deltaType: "flat", delta: "items tracked" }),
      ]));

      // filter tabs (mirror nav, handy on mobile)
      const tabs = [["active", "Active (" + (g.todo.length + g.doing.length) + ")"]];
      if (isSlit) tabs.push(["packing", "To Pack/Ship"]);
      tabs.push(["done", "Completed"]); tabs.push(["all", "All"]);
      view.appendChild(H("div", { class: "sup-tabs" }, tabs.map(([k, lbl]) =>
        H("button", { class: "sup-tab" + (this.filter === k ? " on" : ""), onclick: () => { this.filter = k; this.buildNav(); this.render(); }, text: lbl })
      )));

      // pick the list for the current filter
      let show = [];
      if (this.filter === "active") show = [...g.todo, ...g.doing];
      else if (this.filter === "packing") show = [...g.done, ...g.packed];
      else if (this.filter === "done") show = [...g.done, ...g.packed, ...g.dispatched];
      else show = (this.data.workorders || []).slice();

      const prio = { Urgent: 0, High: 1, Normal: 2, Low: 3 };
      show.sort((a, b) => (prio[a.priority] ?? 2) - (prio[b.priority] ?? 2) || String(a.due).localeCompare(String(b.due)));

      const list = H("div", { class: "sup-list" });
      if (!show.length) {
        list.appendChild(H("div", { class: "sup-empty" }, [
          H("div", { class: "big", text: "🎉" }),
          H("div", { text: this.filter === "active" ? "No pending jobs. You're all caught up!" : "Nothing here." }),
        ]));
      } else {
        show.forEach((w) => list.appendChild(this.card(w, isSlit)));
      }
      view.appendChild(list);
      view.scrollTop = 0;
    },

    card(w, isSlit) {
      const st = STATUS[w.status] || STATUS["Pending"];
      const p = w.product || {};
      const due = w.due ? new Date(w.due) : null;
      const overdue = due && w.status !== "Dispatched" && w.status !== "Completed" && DB.helpers.iso(due) < DB.helpers.iso(DB.helpers.today());

      const head = H("div", { class: "sup-card-head" }, [
        H("div", {}, [
          H("div", { class: "sup-card-prod", text: p.name || w.itemId || "Product" }),
          H("div", { class: "sup-card-meta", text: [p.typeCode, w.id].filter(Boolean).join(" · ") }),
        ]),
        H("div", { class: "sup-status", style: "color:" + st.color + ";border-color:" + st.color }, st.label),
      ]);

      const facts = H("div", { class: "sup-facts" }, [
        fact("Make", H("b", { text: fmtQty(w.qty) + " " + (p.uom || "") })),
        w.customer ? fact("Customer", w.customer) : null, // slitting label info (no money)
        p.widthMM ? fact("Width", (Array.isArray(p.widthMM) ? p.widthMM.join("/") : p.widthMM) + " mm") : null,
        w.due ? fact("Due", H("span", { style: overdue ? "color:var(--danger);font-weight:700" : "", text: w.due + (overdue ? " ⏰" : "") })) : null,
        w.priority && w.priority !== "Normal" ? fact("Priority", H("span", { style: "font-weight:700;color:var(--danger)", text: w.priority })) : null,
      ].filter(Boolean));

      let mat = null;
      if (w.materials && w.materials.length) {
        mat = H("details", { class: "sup-mat" }, [
          H("summary", { text: "🧱 Materials needed (" + w.materials.length + ")" }),
          H("div", { class: "sup-mat-list" }, w.materials.map((m) =>
            H("div", { class: "sup-mat-row" }, [
              H("span", { text: m.name || m.id }),
              H("b", { text: fmtQty(m.required) + " " + (m.uom || "") }),
            ]))),
        ]);
      }

      const actions = H("div", { class: "sup-actions" });
      if (st.next && (!st.slitOnly || isSlit)) {
        actions.appendChild(H("button", { class: "sup-act primary", onclick: (e) => this.advance(w, st.next, e.currentTarget), text: st.nextLabel }));
      }
      if (["In Production", "In Progress"].includes(w.status)) {
        actions.appendChild(H("button", { class: "sup-act ghost", onclick: (e) => this.advance(w, "Pending", e.currentTarget), text: "↩ Pause" }));
      }
      if (w.status === "Dispatched") {
        actions.appendChild(H("div", { class: "sup-done-tag", text: "✓ Dispatched" }));
      }

      return H("div", { class: "sup-card" + (overdue ? " overdue" : "") }, [head, facts, mat, actions].filter(Boolean));
    },

    async advance(w, status, btn) {
      if (btn) { btn.disabled = true; btn.textContent = "…"; }
      try {
        await DB.production.setStatus(w.id, status);
        toast("Updated: " + (w.product ? w.product.name : w.id) + " → " + status, { type: "ok" });
        await this.refresh();
      } catch (err) {
        toast(err.message, { type: "danger" });
        if (btn) btn.disabled = false;
        this.render();
      }
    },
  };

  function fact(label, val) {
    return UI.h("div", { class: "sup-fact" }, [
      UI.h("div", { class: "sup-fact-l", text: label }),
      UI.h("div", { class: "sup-fact-v" }, val instanceof Node ? val : UI.h("span", { html: String(val) })),
    ]);
  }
  function fmtQty(n) { n = +n || 0; return n % 1 === 0 ? n.toLocaleString("en-IN") : n.toLocaleString("en-IN", { maximumFractionDigits: 1 }); }

  global.SUP = SUP;
})(window);
