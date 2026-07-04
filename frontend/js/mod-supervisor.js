/* ============================================================
   CHHAPERIA ERP — SUPERVISOR PANEL (SUP)  ·  STAGE-AWARE
   Renders INSIDE the admin shell (#app) so it inherits the
   sidebar, topbar, dynamic accent + dark/light theme — but the
   nav is limited to production, and the content is big, tap-
   friendly job cards (no money, no sales, area-scoped).

   The job flows through a ROUTE of stages:
       Coating / Lamination → Slitting → Packing & Dispatch
   A card shows the whole route; the supervisor can only act on
   the stage that is currently in THEIR area. Completing a stage
   hands the job to the next area's panel automatically.
   ============================================================ */
(function (global) {
  "use strict";
  const H = UI.h, esc = UI.esc, toast = UI.toast;
  const { pageHead, kpi } = MW;

  const AREA_LABEL = { coating: "Coating / Lamination", slitting: "Slitting & Dispatch", fiberglass: "Fibre-Glass + Slitting & Dispatch", all: "All Production" };
  const AREA_ICON = { coating: "🎨", slitting: "✂️", fiberglass: "🧵", all: "🏭" };
  const STAGE_META = {
    coating:    { ic: "🎨", label: "Coating" },
    production: { ic: "🧵", label: "Production" },
    weaving:    { ic: "🧶", label: "Weaving" },
    wbcoat:     { ic: "🎨", label: "WB Coating" },
    slitting:   { ic: "✂️", label: "Slitting" },
    packing:    { ic: "📦", label: "Packing" },
  };
  const STATUS_COLOR = { "Completed": "var(--ok)", "In Production": "var(--info)", "Pending": "var(--text-mut)" };

  const SUP = {
    user: null, area: "all", data: null, filter: "active",

    async boot(user) {
      this.user = user;
      this.area = user.area || "all";

      const theme = (function () { try { return localStorage.getItem("chh_theme"); } catch { return null; } })() || "dark";
      document.documentElement.setAttribute("data-theme", theme);
      document.documentElement.setAttribute("data-accent", "orange");

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

    /* bucket a WO from THIS area's perspective */
    buckets() {
      const g = { active: [], incoming: [], done: [] };
      (this.data.workorders || []).forEach((w) => {
        if (w.dispatched || w.myDone) g.done.push(w);
        else if (w.mine) g.active.push(w);
        else g.incoming.push(w);   // upstream — coming to this area later
      });
      return g;
    },

    buildNav() {
      const g = this.buckets();
      const items = [
        { sec: "Production" },
        { id: "active", ic: "⚙️", label: "My Jobs", pill: g.active.length },
      ];
      if (g.incoming.length) items.push({ id: "incoming", ic: "⏳", label: "Coming Up", pill: g.incoming.length });
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

      const g = this.buckets();
      const hasIncoming = g.incoming.length > 0;
      const titleMap = { active: "My Jobs", incoming: "Coming Up", done: "Completed Jobs", all: "All Jobs" };

      UI.$("#crumbs").innerHTML = `<span>Chhaperia</span><span class="sep">/</span><span class="cur">${esc(titleMap[this.filter] || "My Jobs")}</span>`;

      view.appendChild(pageHead(
        AREA_ICON[this.area] + " " + (AREA_LABEL[this.area] || this.area),
        "Tap a job to move it to the next stage. Once you complete a stage it hands off to the next team automatically.",
        [H("button", { class: "btn", onclick: () => this.refresh(), html: "↻ Refresh" })]
      ));

      view.appendChild(H("div", { class: "grid kpi-grid", style: "margin-bottom:18px" }, [
        kpi({ icon: "⚙️", label: "My Active Jobs", value: g.active.length, deltaType: "flat", delta: "in your area now", onClick: () => { this.filter = "active"; this.buildNav(); this.render(); } }),
        kpi({ icon: "⏳", label: "Coming Up", value: g.incoming.length, deltaType: "flat", delta: "upstream, heading to you" }),
        kpi({ icon: "✅", label: "Completed", value: g.done.length, deltaType: "up", delta: "handed off / dispatched" }),
        kpi({ icon: "🏭", label: "Total Jobs", value: (this.data.workorders || []).length, deltaType: "flat", delta: "you're involved in" }),
      ]));

      const tabs = [["active", "My Jobs (" + g.active.length + ")"]];
      if (hasIncoming) tabs.push(["incoming", "Coming Up (" + g.incoming.length + ")"]);
      tabs.push(["done", "Completed"]); tabs.push(["all", "All"]);
      view.appendChild(H("div", { class: "sup-tabs" }, tabs.map(([k, lbl]) =>
        H("button", { class: "sup-tab" + (this.filter === k ? " on" : ""), onclick: () => { this.filter = k; this.buildNav(); this.render(); }, text: lbl })
      )));

      let show = this.filter === "all" ? (this.data.workorders || []).slice() : (g[this.filter] || []);
      const prio = { Urgent: 0, High: 1, Normal: 2, Low: 3 };
      show = show.slice().sort((a, b) => (prio[a.priority] ?? 2) - (prio[b.priority] ?? 2) || String(a.due).localeCompare(String(b.due)));

      const list = H("div", { class: "sup-list" });
      if (!show.length) {
        list.appendChild(H("div", { class: "sup-empty" }, [
          H("div", { class: "big", text: "🎉" }),
          H("div", { text: this.filter === "active" ? "No jobs in your area right now. You're all caught up!" : "Nothing here." }),
        ]));
      } else {
        show.forEach((w) => list.appendChild(this.card(w)));
      }
      view.appendChild(list);
      view.scrollTop = 0;
    },

    /* the route timeline: three connected stage pills */
    timeline(w) {
      const row = H("div", { class: "sup-timeline", style: "display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:10px 0 4px" });
      (w.route || []).forEach((s, i) => {
        if (i > 0) row.appendChild(H("span", { style: "color:var(--text-mut);font-size:13px", text: "→" }));
        const meta = STAGE_META[s.key] || { ic: "•", label: s.key };
        const isCur = i === w.stageIdx && !w.dispatched;
        const col = STATUS_COLOR[s.status] || "var(--text-mut)";
        const mark = s.status === "Completed" ? "✓" : (s.status === "In Production" ? "▶" : "•");
        row.appendChild(H("span", {
          title: s.name + " — " + s.status + (s.doneBy ? " (by " + s.doneBy + ")" : ""),
          style: "display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;"
            + "border:1.5px solid " + col + ";color:" + col + ";"
            + (isCur ? "box-shadow:0 0 0 3px color-mix(in srgb," + col + " 22%, transparent);background:color-mix(in srgb," + col + " 12%, transparent)" : "background:transparent"),
        }, [H("span", { text: meta.ic }), H("span", { text: meta.label }), H("span", { style: "opacity:.8", text: mark })]));
      });
      if (w.dispatched) row.appendChild(H("span", { style: "margin-left:4px;font-size:12px;font-weight:700;color:var(--ok)", text: "🚚 Dispatched" }));
      return row;
    },

    card(w) {
      const p = w.product || {};
      const cur = w.stage || {};
      const due = w.due ? new Date(w.due) : null;
      const overdue = due && !w.dispatched && !w.myDone && DB.helpers.iso(due) < DB.helpers.iso(DB.helpers.today());

      const chipCol = STATUS_COLOR[cur.status] || "var(--text-mut)";
      const chipTxt = w.dispatched ? "Dispatched"
        : (w.mine ? (STAGE_META[cur.key] || {}).label + " · " + (cur.status === "In Production" ? "in progress" : "to start")
          : (w.myDone ? "Your part done" : "At " + ((STAGE_META[cur.key] || {}).label || cur.name)));

      const head = H("div", { class: "sup-card-head" }, [
        H("div", {}, [
          H("div", { class: "sup-card-prod", text: p.name || w.itemId || "Product" }),
          H("div", { class: "sup-card-meta", text: [p.typeCode, w.id].filter(Boolean).join(" · ") }),
        ]),
        H("div", { class: "sup-status", style: "color:" + chipCol + ";border-color:" + chipCol }, chipTxt),
      ]);

      const facts = H("div", { class: "sup-facts" }, [
        fact("Make", H("b", { text: fmtQty(w.qty) + " " + (p.uom || "") })),
        w.spec ? fact(w.spec.label, H("b", { style: w.spec.value == null ? "color:var(--danger)" : "", text: w.spec.value == null ? "— not set" : String(w.spec.value) })) : null,
        w.customer ? fact("Customer", w.customer) : null,
        p.widthMM ? fact("Width", (Array.isArray(p.widthMM) ? p.widthMM.join("/") : p.widthMM) + " mm") : null,
        w.due ? fact("Due", H("span", { style: overdue ? "color:var(--danger);font-weight:700" : "", text: w.due + (overdue ? " ⏰" : "") })) : null,
        w.priority && w.priority !== "Normal" ? fact("Priority", H("span", { style: "font-weight:700;color:var(--danger)", text: w.priority })) : null,
      ].filter(Boolean));

      // materials for THIS area's stage (only meaningful while it's their turn)
      let mat = null;
      if (w.mine && w.materials && w.materials.length) {
        mat = H("details", { class: "sup-mat" }, [
          H("summary", { text: "🧱 Materials for " + ((STAGE_META[cur.key] || {}).label || "this stage") + " (" + w.materials.length + ")" }),
          H("div", { class: "sup-mat-list" }, w.materials.map((m) =>
            H("div", { class: "sup-mat-row" }, [
              H("span", { text: m.name || m.id }),
              H("b", { text: fmtQty(m.required) + " " + (m.uom || "") }),
            ]))),
        ]);
      }

      const actions = H("div", { class: "sup-actions" });
      if (w.dispatched) {
        actions.appendChild(H("div", { class: "sup-done-tag", text: "✓ Dispatched" }));
      } else if (w.mine) {
        const label = (STAGE_META[cur.key] || {}).label || cur.name;
        if (cur.status === "Pending") {
          actions.appendChild(H("button", { class: "sup-act primary", onclick: (e) => this.act(w, "start", e.currentTarget), text: "▶ Start " + label }));
        } else if (cur.status === "In Production") {
          actions.appendChild(H("button", { class: "sup-act primary", onclick: (e) => this.act(w, "complete", e.currentTarget), text: "✓ Finish " + label }));
          actions.appendChild(H("button", { class: "sup-act ghost", onclick: (e) => this.act(w, "pause", e.currentTarget), text: "↩ Pause" }));
        }
      } else if (w.myDone && !w.dispatched && (w.route || []).every((s) => s.status === "Completed") && (this.area === "slitting" || this.area === "all")) {
        // fully made & packed, waiting to ship
        actions.appendChild(H("button", { class: "sup-act primary", onclick: (e) => this.act(w, "dispatch", e.currentTarget), text: "🚚 Mark Dispatched" }));
      } else if (!w.mine && !w.myDone) {
        actions.appendChild(H("div", { class: "sup-done-tag", style: "color:var(--text-mut)", text: "⏳ Waiting on " + ((STAGE_META[cur.key] || {}).label || cur.name) }));
      }

      return H("div", { class: "sup-card" + (overdue ? " overdue" : "") }, [head, this.timeline(w), facts, mat, actions].filter(Boolean));
    },

    async act(w, action, btn) {
      if (btn) { btn.disabled = true; btn.textContent = "…"; }
      try {
        await DB.production.advance(w.id, action);
        const verb = { start: "started", complete: "completed", pause: "paused", dispatch: "dispatched" }[action] || action;
        toast((w.product ? w.product.name : w.id) + " — stage " + verb, { type: "ok" });
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
