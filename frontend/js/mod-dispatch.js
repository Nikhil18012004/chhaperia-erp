/* ============================================================
   CHHAPERIA ERP — DISPATCH · Transport Providers directory
   A CRM-style master of transport agencies / carriers used to
   move goods out: contacts, GST, vehicle types, service routes,
   rate basis, on-time performance and the internal owner.
   Full create / edit / delete via the granular /transporters API.
   ============================================================ */
(function () {
  "use strict";
  const { h, esc, table, badge, meter, toast, modal, confirm } = UI;
  const { pageHead, kpi } = MW;
  const U = window._erpUtil;

  const VEHICLE_TYPES = ["LCV", "Tempo", "Truck (20ft)", "Truck (32ft)", "Trailer", "Container (20ft)", "Container (40ft)", "Reefer"];
  const RATE_BASES = ["Per trip", "Per km", "Per ton", "Per kg", "Contract"];
  const RATINGS = ["A", "B", "C"];
  const trs = () => ENG.data.transporters || [];

  M.dispatch = { title: "Dispatch", sub: "Transport providers & carriers", render(root, params) {
    let filter = { q: "", rating: "all", vehicle: "all", status: "active" };
    root.appendChild(pageHead("Dispatch — Transport Providers",
      "Your transport agencies / carriers for outbound goods: contacts, vehicles, routes, rates and on-time performance.",
      [h("button", { class: "btn primary", onclick: () => transporterForm(), html: "＋ New Transporter" })]));

    // KPI strip
    const active = trs().filter((t) => t.active !== false);
    const avgOT = active.length ? Math.round(active.reduce((s, t) => s + (+t.onTime || 0), 0) / active.length) : 0;
    root.appendChild(h("div", { class: "grid kpi-grid", style: "margin-bottom:16px" }, [
      kpi({ icon: "🚚", label: "Transport Providers", value: ENG.num(trs().length) }),
      kpi({ icon: "✅", label: "Active Carriers", value: ENG.num(active.length) }),
      kpi({ icon: "⏱", label: "Avg On-Time", value: avgOT + "%", delta: avgOT >= 90 ? "reliable fleet" : "watch delays", deltaType: avgOT >= 90 ? "up" : "down" }),
      kpi({ icon: "🏅", label: "A-Rated", value: ENG.num(active.filter((t) => t.rating === "A").length) }),
    ]));

    // toolbar
    root.appendChild(h("div", { class: "toolbar" }, [
      MW.searchInput("Search name, city, contact, route…", (v) => { filter.q = v.toLowerCase(); draw(); }),
      MW.select([{ value: "active", label: "Active" }, { value: "all", label: "All Statuses" }, { value: "inactive", label: "Inactive" }], (v) => { filter.status = v; draw(); }),
      MW.select([{ value: "all", label: "All Ratings" }, ...RATINGS.map((r) => ({ value: r, label: "Grade " + r }))], (v) => { filter.rating = v; draw(); }),
      MW.select([{ value: "all", label: "All Vehicles" }, ...VEHICLE_TYPES.map((v) => ({ value: v, label: v }))], (v) => { filter.vehicle = v; draw(); }),
      h("div", { style: "margin-left:auto" }, h("span", { class: "chip", id: "trCount" })),
    ]));
    const host = h("div"); root.appendChild(host);

    function rows() {
      return trs().filter((t) => {
        if (filter.status === "active" && t.active === false) return false;
        if (filter.status === "inactive" && t.active !== false) return false;
        if (filter.rating !== "all" && t.rating !== filter.rating) return false;
        if (filter.vehicle !== "all" && !(t.vehicleTypes || []).includes(filter.vehicle)) return false;
        if (filter.q) { const s = (t.name + " " + (t.city || "") + " " + (t.contact || "") + " " + (t.routes || "") + " " + (t.id || "")).toLowerCase(); if (!s.includes(filter.q)) return false; }
        return true;
      });
    }
    function draw() {
      const data = rows(); const c = UI.$("#trCount"); if (c) c.textContent = data.length + " providers";
      host.innerHTML = "";
      if (!data.length) { host.appendChild(h("div", { class: "empty", style: "margin-top:24px" }, [h("div", { class: "big", text: "🚚" }), h("div", { style: "font-weight:700", text: "No transport providers" }), h("div", { class: "muted", style: "margin-top:6px", text: "Add your first carrier with ＋ New Transporter." })])); return; }
      const grid = h("div", { class: "grid cols-2" });
      data.forEach((t) => grid.appendChild(card(t)));
      host.appendChild(grid);
    }
    draw();

    function card(t) {
      const ot = +t.onTime || 0;
      const chips = (t.vehicleTypes || []).slice(0, 4).map((v) => `<span class="chip">${esc(v)}</span>`).join("");
      return h("div", { class: "card hover", style: "cursor:pointer", onclick: () => detail(t) }, [
        h("div", { class: "flex between aic" }, [
          h("div", {}, [h("h3", { style: "font-size:15px", text: t.name }),
            h("div", { class: "muted", style: "font-size:12px", text: (t.city || "—") + (t.state ? ", " + t.state : "") + " · " + t.id })]),
          h("span", { html: badge(t.rating === "A" ? "ok" : t.rating === "B" ? "warn" : "mut", "Grade " + (t.rating || "—")) }),
        ]),
        chips ? h("div", { class: "flex gap wrap", style: "margin-top:10px", html: chips }) : null,
        h("div", { class: "grid cols-3", style: "margin:14px 0;gap:8px" }, [
          stat("On-Time", ot + "%"), stat("Rate", t.baseRate ? "₹" + ENG.num(t.baseRate) : "—"), stat("Basis", t.rateBasis || "—"),
        ]),
        h("div", { style: "margin-bottom:10px" }, [
          h("div", { class: "flex between", style: "font-size:11px;margin-bottom:4px" }, [h("span", { class: "muted", text: "On-time delivery" }), h("span", { class: "muted", text: ot + "%" })]),
          h("div", { html: meter(ot, ot > 92 ? "ok" : ot > 82 ? "warn" : "danger") }),
        ]),
        t.routes ? h("div", { class: "muted", style: "font-size:11.5px;margin-bottom:6px", html: "🛣 " + esc(t.routes) }) : null,
        h("div", { class: "flex between", style: "font-size:12.5px;padding-top:10px;border-top:1px solid var(--line)" }, [
          h("span", { class: "muted", html: "👤 " + esc(t.contact || "—") }),
          h("span", { class: t.active === false ? "muted" : "strong", html: t.active === false ? badge("mut", "Inactive") : (t.phone ? esc(t.phone) : "") }),
        ]),
        h("div", { class: "muted", style: "font-size:11.5px;margin-top:6px", html: (t.email ? "✉ " + esc(t.email) : "") + (t.owner ? " · owner " + esc(t.owner) : "") }),
      ]);
    }

    function detail(t) {
      const body = h("div", {}, [
        MW.dl([
          ["Contact Person", t.contact || "—"], ["Phone", t.phone || "—"], ["Email", t.email || "—"],
          ["City", t.city || "—"], ["State", t.state || "—"],
          ["GSTIN", t.gstin || "—"], ["PAN", t.pan || "—"],
          ["Vehicle Types", (t.vehicleTypes || []).join(", ") || "—"],
          ["Service Routes", t.routes || "—"],
          ["Rate Basis", t.rateBasis || "—"], ["Base Rate", t.baseRate ? "₹" + ENG.num(t.baseRate) + " / " + (t.rateBasis || "unit") : "—"],
          ["On-Time %", (t.onTime || 0) + "%"], ["Rating", "Grade " + (t.rating || "—")],
          ["Owner (internal)", t.owner || "—"], ["Payment Terms", t.terms || "—"],
          ["Status", t.active === false ? "Inactive" : "Active"],
        ]),
        t.notes ? h("div", { class: "card", style: "margin-top:14px;box-shadow:none;background:var(--panel-2)" },
          [h("div", { class: "muted", style: "font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:4px", text: "Notes" }),
           h("div", { style: "font-size:13px;line-height:1.5", text: t.notes })]) : null,
      ]);
      modal({ title: t.name, sub: t.id + " · " + (t.city || ""), wide: true, body,
        foot: [h("button", { class: "btn danger", onclick: () => del(t), text: "🗑 Delete" }),
          h("button", { class: "btn ghost", onclick: () => { UI.$("#modalHost").hidden = true; transporterForm(t); }, text: "✎ Edit" })] });
    }

    async function del(t) {
      if (!await confirm(`Delete transporter ${t.name} (${t.id})?`, { title: "Delete Transporter", danger: true })) return;
      ENG.data.transporters = trs().filter((x) => x.id !== t.id);
      UI.$("#modalHost").hidden = true;
      toast(`${t.name} deleted`, { type: "ok", title: "Removed" });
      App.saveDelta(() => DB.transporters.remove(t.id));
    }

    function transporterForm(t) {
      const edit = !!t; t = t || { active: true, rating: "B", rateBasis: "Per trip", vehicleTypes: [] };
      const f = (k, d) => (t[k] != null ? t[k] : (d == null ? "" : d));
      const body = h("div", {}, [
        h("div", { class: "form-grid" }, [
          U.field("Agency / Carrier Name", `<input class="input" id="t_name" value="${esc(f("name"))}" placeholder="e.g. Sri Balaji Roadways">`),
          U.field("Contact Person", `<input class="input" id="t_contact" value="${esc(f("contact"))}">`),
          U.field("Phone", `<input class="input" id="t_phone" value="${esc(f("phone"))}">`),
          U.field("Email", `<input class="input" id="t_email" value="${esc(f("email"))}">`),
          U.field("City", `<input class="input" id="t_city" value="${esc(f("city"))}">`),
          U.field("State", `<input class="input" id="t_state" value="${esc(f("state"))}">`),
          U.field("GSTIN", `<input class="input" id="t_gstin" value="${esc(f("gstin"))}">`),
          U.field("PAN", `<input class="input" id="t_pan" value="${esc(f("pan"))}">`),
          U.field("Service Routes / Lanes", `<input class="input" id="t_routes" value="${esc(f("routes"))}" placeholder="e.g. Bengaluru · Chennai · Hyderabad">`, "full"),
          U.field("Rate Basis", U.selectHTML("t_basis", RATE_BASES.map((r) => ({ v: r, l: r })), f("rateBasis", "Per trip"))),
          U.field("Base Rate (₹)", `<input class="input" id="t_rate" type="number" value="${f("baseRate", 0)}">`),
          U.field("On-Time %", `<input class="input" id="t_ot" type="number" min="0" max="100" value="${f("onTime", 0)}">`),
          U.field("Rating", U.selectHTML("t_rating", RATINGS.map((r) => ({ v: r, l: "Grade " + r })), f("rating", "B"))),
          U.field("Owner (internal)", `<input class="input" id="t_owner" value="${esc(f("owner", "Dispatch Desk"))}">`),
          U.field("Payment Terms", `<input class="input" id="t_terms" value="${esc(f("terms", "30 days"))}">`),
          U.field("Status", U.selectHTML("t_active", [{ v: "1", l: "Active" }, { v: "0", l: "Inactive" }], t.active === false ? "0" : "1")),
        ]),
        h("h3", { style: "margin:14px 0 8px;font-size:13px", text: "Vehicle Types" }),
        h("div", { class: "flex gap wrap", id: "t_vehicles" }, VEHICLE_TYPES.map((v) => h("label", { class: "chip", style: "cursor:pointer" }, [
          h("input", { type: "checkbox", value: v, checked: (t.vehicleTypes || []).includes(v) ? "checked" : null }), " " + v]))),
        h("h3", { style: "margin:14px 0 8px;font-size:13px", text: "Notes" }),
        h("textarea", { class: "input", id: "t_notes", placeholder: "Coverage, reliability, special handling…" }, f("notes")),
      ]);
      const mo = modal({ title: edit ? "Edit Transporter" : "New Transporter", sub: edit ? t.id : "Add a transport provider", wide: true, body,
        foot: [h("button", { class: "btn ghost", onclick: () => mo.close(), text: "Cancel" }),
          h("button", { class: "btn primary", onclick: doSave, text: edit ? "Save Changes" : "Create Transporter" })] });
      // textarea value (h() puts text child, but ensure it's set)
      const ta = UI.$("#t_notes"); if (ta && t.notes) ta.value = t.notes;
      function doSave() {
        const g = (id) => { const el = UI.$("#" + id); return el ? el.value : ""; };
        const name = g("t_name").trim(); if (!name) { toast("Agency name is required", { type: "warn" }); return; }
        const vehicleTypes = [...UI.$("#t_vehicles").querySelectorAll("input:checked")].map((el) => el.value);
        const data = { name, contact: g("t_contact").trim(), phone: g("t_phone").trim(), email: g("t_email").trim(),
          city: g("t_city").trim(), state: g("t_state").trim(), gstin: g("t_gstin").trim().toUpperCase(), pan: g("t_pan").trim().toUpperCase(),
          routes: g("t_routes").trim(), rateBasis: g("t_basis"), baseRate: +g("t_rate") || 0, onTime: +g("t_ot") || 0,
          rating: g("t_rating"), owner: g("t_owner").trim(), terms: g("t_terms").trim(),
          active: g("t_active") === "1", vehicleTypes, notes: g("t_notes").trim() };
        mo.close();
        if (edit) { Object.assign(t, data); toast(t.name + " updated", { type: "ok" }); App.saveDelta(() => DB.transporters.update(t.id, data)); }
        else { const obj = Object.assign({ id: U.nextSeqId(trs(), "TR-") }, data); ENG.data.transporters.push(obj); toast(obj.name + " added", { type: "ok" }); App.saveDelta(() => DB.transporters.create(obj)); }
      }
    }
    // consumed by the ⌘K "New Transporter" action
    if (params && params.openNew) { params.openNew = false; transporterForm(); }
  }};

  function stat(label, val) { return h("div", {}, [h("div", { class: "muted", style: "font-size:10.5px;font-weight:700;text-transform:uppercase", text: label }), h("div", { style: "font-weight:700;font-size:15px;margin-top:2px", text: val })]); }

  // ⌘K quick action
  window.ERPActions = Object.assign(window.ERPActions || {}, {
    newTransporter: { ic: "🚚", label: "New Transporter", run: () => App.go("dispatch", { openNew: true }) },
  });
})();
