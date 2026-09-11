/* ============================================================
   CHHAPERIA ERP — AUDIT 1: every route, every role, every door

   1. The route inventory is read out of the routers themselves and
      compared with the access policy written down below, so a route
      added without a stated policy fails here.
   2. Every protected route answers 401 with no credential.
   3. Every role a route does NOT admit is refused with 403 — checked
      for all ~125 routes, for admin, office, lab and a supervisor.
   4. The routes no other suite calls get a functional test of their
      own (customers, suppliers, transporters, org, lab-product and
      GRN-test deletes, the BOM one-shot, approvals, user edits, the
      punch device, leave types, payslips, fx).
   5. Sessions and the HTTP surface: lockout, logout, password
      change, deactivation, headers, body limits, unknown paths.
   6. Hostile input: every write route is sent malformed bodies and
      odd ids — nothing may answer 500.

     node backend/test/http-audit-routes.js
   ============================================================ */
"use strict";
const H = require("./_harness")("audit_routes");
const { call, login, ok, note, section, J } = H;

/* THE ACCESS POLICY, as the route files state it. "any" = any signed-in
   role; "public" = no credential needed; "device" = the punch device key
   or an admin/office session. */
const ALL = ["admin", "office", "lab", "supervisor"];
const AO = ["admin", "office"], SAO = ["supervisor", "admin", "office"], AOL = ["admin", "office", "lab"];
const POLICY = {
  "GET /api/health": "public",
  "GET /api/state": "any",
  "GET /api/store": "any",
  "POST /api/production/wo/:id/advance": ["supervisor", "admin"],
  "GET /api/production/wo/:id/lab": SAO,
  "POST /api/production/wo/:id/lab": SAO,
  "POST /api/production/wo/:id/status": ["supervisor", "admin"],
  "POST /api/production/wo/preview": AO,
  "POST /api/production/wo": AO,
  "POST /api/production/wo/:id/resume": AO,
  "GET /api/production/finished/:itemId/lab": SAO,
  "POST /api/production/finished": SAO,
  "POST /api/production/wo/:id/wip-store": SAO,
  "POST /api/production/return": SAO,
  "POST /api/production/adhoc": SAO,
  "POST /api/production/excess-material": SAO,
  "POST /api/items": AO,
  "PATCH /api/items/:id": AO,
  "POST /api/movements": AO,
  "POST /api/purchase-orders/:id/receive": AO,
  "POST /api/purchase-orders": AO,
  "PATCH /api/purchase-orders/:id": AO,
  "DELETE /api/purchase-orders/:id": AO,
  "POST /api/sales-orders": AO,
  "PATCH /api/sales-orders/:id": AO,
  "DELETE /api/sales-orders/:id": AO,
  "POST /api/sales-orders/:id/dispatch": AO,
  "PUT /api/boms/:itemId": AO,
  "DELETE /api/boms/:itemId": AO,
  "POST /api/leads": AO, "PATCH /api/leads/:id": AO, "DELETE /api/leads/:id": AO,
  "POST /api/customers": AO, "PATCH /api/customers/:id": AO, "DELETE /api/customers/:id": AO,
  "POST /api/suppliers": AO, "PATCH /api/suppliers/:id": AO, "DELETE /api/suppliers/:id": AO,
  "PATCH /api/org": AO,
  "PATCH /api/warehouses/:id": AO,
  "POST /api/appointments": AO, "PATCH /api/appointments/:id": AO, "DELETE /api/appointments/:id": AO,
  "POST /api/complaints": AO, "PATCH /api/complaints/:id": AO, "DELETE /api/complaints/:id": AO,
  "POST /api/quotations": AO, "PATCH /api/quotations/:id": AO, "DELETE /api/quotations/:id": AO,
  "POST /api/quotations/:id/reprice": AO, "POST /api/quotations/:id/win": AO,
  "POST /api/quotations/:id/lose": AO, "POST /api/quotations/:id/reopen": AO,
  "GET /api/batches/:id/spread": "any",
  "POST /api/transporters": AO, "PATCH /api/transporters/:id": AO, "DELETE /api/transporters/:id": AO,
  "POST /api/lab/products": AO, "PATCH /api/lab/products/:id": AO, "DELETE /api/lab/products/:id": AO,
  "PUT /api/lab/products/:id/spec": ["admin"],
  "POST /api/lab/reports": AOL, "PATCH /api/lab/reports/:id": AOL,
  "DELETE /api/lab/reports/:id": AO,
  "POST /api/lab/reports/:id/decision": ["admin"],
  "GET /api/tds": "any", "GET /api/tds/file": "any",
  "PUT /api/tds": ["admin"], "DELETE /api/tds": ["admin"],
  "GET /api/grn-tests/params": "any",
  "GET /api/grn-tests/pending": AOL,
  "GET /api/grns/:grnId/tests/:itemId": AOL,
  "POST /api/grns/:grnId/tests": AOL,
  "DELETE /api/grn-tests/:id": AO,
  "PUT /api/items/:id/qc": ["admin", "lab"],
  "GET /api/grn-tests/decisions": AO,
  "POST /api/grn-tests/:id/decision": ["admin"],
  "DELETE /api/items/:id": AO,
  "DELETE /api/production/wo/:id": AO,
  "PATCH /api/production/wo/:id": AO,
  "PUT /api/state": AO,
  "PATCH /api/settings": AO,
  "POST /api/catalogue/new-item": AOL,
  "POST /api/catalogue/bom": AOL,
  "GET /api/approvals": AOL, "POST /api/approvals": AOL,
  "POST /api/approvals/:id/decide": ["admin"],
  "DELETE /api/approvals/:id": AOL,
  "POST /api/reset": ["admin"],
  // auth
  "POST /api/auth/login": "public",
  "POST /api/auth/logout": "public",
  "POST /api/auth/change-password": "any",
  "GET /api/auth/me": "any",
  "GET /api/auth/users": ["admin"], "POST /api/auth/users": ["admin"],
  "PATCH /api/auth/users/:id": ["admin"], "DELETE /api/auth/users/:id": ["admin"],
  // fx (public, sourced from Google)
  "GET /api/fx": "public", "GET /api/fx/pair": "public",
  // hr
  "POST /api/hr/punch": "device", "POST /api/hr/punch/batch": "device",
  "GET /api/hr/punches": AO,
  "POST /api/hr/workers": AO, "PATCH /api/hr/workers/:id": AO, "DELETE /api/hr/workers/:id": AO,
  "POST /api/hr/attendance": AO,
  "GET /api/hr/leave-balances/:workerId": AO,
  "POST /api/hr/leave-types": AO, "DELETE /api/hr/leave-types/:id": AO,
  "POST /api/hr/leaves": AO, "POST /api/hr/leaves/:id/decide": AO, "DELETE /api/hr/leaves/:id": AO,
  "POST /api/hr/payroll/run": AO, "POST /api/hr/payroll/:id/finalize": AO,
  "POST /api/hr/payroll/:id/reopen": ["admin"],
  "DELETE /api/hr/payroll/:id": AO, "GET /api/hr/payroll/:id/payslips": AO,
  "PATCH /api/hr/payslips/:id": AO,
  "GET /api/hr/workers/:id/advance": AO, "PUT /api/hr/workers/:id/advance": AO,
  "GET /api/hr/config": AO, "PATCH /api/hr/config": AO,
};

/* the routers' own tables — the ground truth for what exists */
function inventory() {
  const out = [];
  const take = (router, prefix) => (router.stack || []).forEach((l) => {
    if (!l.route) return;
    Object.keys(l.route.methods).filter((m) => l.route.methods[m] && m !== "_all")
      .forEach((m) => out.push(m.toUpperCase() + " " + prefix + l.route.path));
  });
  take(require("../src/routes/api"), "/api");
  take(require("../src/routes/auth").router, "/api/auth");
  take(require("../src/routes/hr"), "/api/hr");
  ((H.app._router || {}).stack || []).forEach((l) => {
    if (!l.route) return;
    const paths = Array.isArray(l.route.path) ? l.route.path : [l.route.path];
    paths.forEach((p) => {
      if (!String(p).startsWith("/api")) return;
      Object.keys(l.route.methods).forEach((m) => out.push(m.toUpperCase() + " " + p));
    });
  });
  return [...new Set(out)];
}
const fill = (p) => p.replace(/:grnId/g, "GRN%2F00-00%2F0001").replace(/:[a-zA-Z]+/g, "AUDIT-NOPE");

async function run() {
  await H.start();

  section("1. Route inventory matches the written access policy");
  const routes = inventory();
  note("routes found in the routers", routes.length);
  const unlisted = routes.filter((r) => !(r in POLICY));
  const stale = Object.keys(POLICY).filter((r) => routes.indexOf(r) < 0);
  ok("every route has a stated access policy", unlisted.length === 0, J(unlisted));
  ok("the policy names no route that no longer exists", stale.length === 0, J(stale));

  const tok = {
    admin: await login("admin"), office: await login("office"),
    lab: await login("lab"), supervisor: await login("coating1"),
  };
  ok("admin, office, lab and a supervisor all sign in", ALL.every((r) => !!tok[r]), J(Object.keys(tok).filter((r) => !tok[r])));

  section("2. No credential, no entry (401) — every protected route");
  {
    const bad = [];
    for (const r of routes) {
      const pol = POLICY[r];
      if (pol === "public" || pol === undefined) continue;
      const [m, p] = r.split(" ");
      const res = await call(m, fill(p).replace(/^\/api/, ""), null, m === "GET" || m === "DELETE" ? undefined : {});
      if (res.status !== 401) bad.push(r + " → " + res.status);
    }
    ok("all " + routes.filter((r) => POLICY[r] !== "public").length + " protected routes answer 401 without a token", bad.length === 0, J(bad));
    /* a forged or tampered token is not a credential either */
    const t = tok.office; const [pl, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(pl, "base64").toString()), { role: "admin" })))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "." + sig;
    ok("a token whose payload was edited (office → admin) is refused", (await call("GET", "/auth/users", forged)).status === 401);
    ok("garbage in the Authorization header is refused", (await call("GET", "/state", "not-a-token")).status === 401);
    ok("a cookie with a bad token is refused", (await call("GET", "/state", null, undefined, { headers: { Cookie: "chh_token=abc.def" } })).status === 401);
  }

  section("3. Every role a route does not admit is refused (403)");
  {
    const bad = [];
    let checked = 0;
    for (const r of routes) {
      const pol = POLICY[r];
      if (!Array.isArray(pol) && pol !== "device") continue;
      const allowed = pol === "device" ? AO : pol;
      const [m, p] = r.split(" ");
      for (const role of ALL) {
        if (allowed.indexOf(role) >= 0) continue;
        const res = await call(m, fill(p).replace(/^\/api/, ""), tok[role], m === "GET" || m === "DELETE" ? undefined : {});
        checked++;
        const want = pol === "device" ? 401 : 403;
        if (res.status !== want) bad.push(r + " as " + role + " → " + res.status + " (want " + want + ")");
      }
    }
    ok("all " + checked + " (route × refused role) pairs are refused", bad.length === 0, J(bad.slice(0, 30)));
  }

  const A = tok.admin, O = tok.office, L = tok.lab, S = tok.supervisor;
  const st0 = (await call("GET", "/state", A)).d;

  section("4a. Customers — create, edit, delete and its guards");
  {
    const c1 = await call("POST", "/customers", O, { id: "CUST-AUD1", name: "Audit Cables Pvt Ltd", gstin: "29ABCDE1234F1Z5", city: "Pune" });
    ok("office creates a customer (201)", c1.status === 201 && c1.d.id === "CUST-AUD1", c1.status + " " + J(c1.d));
    ok("a customer needs an id and a name (400)", (await call("POST", "/customers", O, { name: "No id" })).status === 400);
    const ed = await call("PATCH", "/customers/CUST-AUD1", O, { city: "Nashik" });
    ok("PATCH edits one field and keeps the rest", ed.status === 200 && ed.d.city === "Nashik" && ed.d.gstin === "29ABCDE1234F1Z5", J(ed.d));
    ok("PATCH of an unknown customer is 404", (await call("PATCH", "/customers/CUST-NOPE", O, { city: "x" })).status === 404);
    ok("PATCH cannot blank the name (400)", (await call("PATCH", "/customers/CUST-AUD1", O, { name: "" })).status === 400);
    /* POST is an upsert: a second POST with the same id REPLACES the record */
    const dup = await call("POST", "/customers", O, { id: "CUST-AUD1", name: "Someone else" });
    const back = ((await call("GET", "/state", A)).d.customers || []).find((c) => c.id === "CUST-AUD1") || {};
    ok("creating a customer with an id already in use is refused, not a silent overwrite",
      dup.status === 409, dup.status + " — record is now " + J(back));
    await call("PATCH", "/customers/CUST-AUD1", O, { name: "Audit Cables Pvt Ltd", gstin: "29ABCDE1234F1Z5", city: "Nashik" });
    const fg = st0.items.find((i) => i.cat === "FG" && i.active !== false);
    const so = await call("POST", "/sales-orders", O, { customerId: "CUST-AUD1", lines: [{ itemId: fg.id, qty: 1, rate: 1 }] });
    const del1 = await call("DELETE", "/customers/CUST-AUD1", O);
    ok("a customer with a sales order cannot be deleted (400)", del1.status === 400 && /sales order/.test(del1.d.error || ""), J(del1.d));
    await call("DELETE", "/sales-orders/" + so.d.id, O);
    /* a customer named on a quotation / complaint / work order is a reference too */
    const q = await call("POST", "/quotations", O, { customerId: "CUST-AUD1", itemId: fg.id, price: 10, qty: 1 });
    const del2 = await call("DELETE", "/customers/CUST-AUD1", O);
    ok("a customer with a quotation on file cannot be deleted either", del2.status === 400,
      del2.status + " — the quotation " + (q.d && q.d.id) + " is left naming a customer that no longer exists");
    if (del2.status !== 200) {
      await call("DELETE", "/quotations/" + (q.d && q.d.id), O);
      const del3 = await call("DELETE", "/customers/CUST-AUD1", O);
      ok("with nothing referencing it, it is deleted (200)", del3.status === 200, del3.status);
    }
    ok("deleting an unknown customer is 404", (await call("DELETE", "/customers/CUST-NOPE", O)).status === 404);
  }

  section("4b. Suppliers — create, edit, delete and its guards");
  {
    const s1 = await call("POST", "/suppliers", O, { name: "Audit Resins" });
    ok("a supplier is created with a generated id (201)", s1.status === 201 && /^SUP-\d+/.test(s1.d.id || ""), J(s1.d));
    const sid = s1.d.id;
    ok("a second supplier with the same explicit id is refused (409)",
      (await call("POST", "/suppliers", O, { id: sid, name: "Clash" })).status === 409);
    ok("a supplier needs a name (400)", (await call("POST", "/suppliers", O, {})).status === 400);
    const e = await call("PATCH", "/suppliers/" + sid, O, { phone: "080-1234" });
    ok("PATCH edits a supplier", e.status === 200 && e.d.phone === "080-1234" && e.d.name === "Audit Resins");
    ok("PATCH of an unknown supplier is 404", (await call("PATCH", "/suppliers/SUP-NOPE", O, { name: "x" })).status === 404);
    const rm = st0.items.find((i) => i.cat === "RM");
    const po = await call("POST", "/purchase-orders", O, { supplierId: sid, lines: [{ itemId: rm.id, qty: 1, rate: 1 }] });
    ok("a supplier with a purchase order cannot be deleted (400)", (await call("DELETE", "/suppliers/" + sid, O)).status === 400);
    await call("DELETE", "/purchase-orders/" + po.d.id, O);
    ok("once free, it is deleted (200)", (await call("DELETE", "/suppliers/" + sid, O)).status === 200);
    ok("deleting it again is 404", (await call("DELETE", "/suppliers/" + sid, O)).status === 404);
  }

  section("4c. Transporters");
  {
    const t = await call("POST", "/transporters", O, { name: "Audit Roadways", phone: "99999" });
    ok("created (201) and active by default", t.status === 201 && t.d.active === true && /^TR-/.test(t.d.id), J(t.d));
    ok("a transporter needs a name (400)", (await call("POST", "/transporters", O, { phone: "1" })).status === 400);
    ok("an explicit id already in use is refused (409)", (await call("POST", "/transporters", O, { id: t.d.id, name: "x" })).status === 409);
    const e = await call("PATCH", "/transporters/" + t.d.id, O, { active: false });
    ok("edited", e.status === 200 && e.d.active === false && e.d.name === "Audit Roadways");
    ok("unknown transporter PATCH is 404", (await call("PATCH", "/transporters/TR-NOPE", O, { name: "x" })).status === 404);
    ok("deleted (200)", (await call("DELETE", "/transporters/" + t.d.id, O)).status === 200);
    ok("unknown transporter DELETE is 404", (await call("DELETE", "/transporters/" + t.d.id, O)).status === 404);
  }

  section("4d. Company profile (PATCH /org)");
  {
    const before = (await call("GET", "/state", A)).d.org || {};
    const companies = (before.companies || []).map((c) => Object.assign({}, c));
    ok("the two invoicing companies are on file", companies.length === 2, J(companies.map((c) => c.key)));
    const patched = companies.map((c, i) => i === 0 ? Object.assign({}, c, { gstin: " 29aaicc5462h1ze ", stateCode: "" }) : c);
    const r = await call("PATCH", "/org", O, { companies: patched });
    const c0 = (r.d.companies || [])[0] || {};
    ok("GSTIN is trimmed and upper-cased, and the state code is read off it", r.status === 200 && c0.gstin === "29AAICC5462H1ZE" && c0.stateCode === "29", J(c0));
    ok("an array body is refused (400)", (await call("PATCH", "/org", O, [])).status === 400);
    const bad = await call("PATCH", "/org", O, { companies: [Object.assign({}, companies[0], { gstin: "NOT-A-GSTIN" }), companies[1]] });
    ok("a malformed GSTIN is refused rather than printed on invoices", bad.status === 400,
      bad.status + " — stored " + J(((bad.d.companies || [])[0] || {}).gstin));
    await call("PATCH", "/org", A, { companies });   // put it back
  }

  section("4e. Warehouses (PATCH /warehouses/:id)");
  {
    const r = await call("PATCH", "/warehouses/WH-WIP", O, { name: "  Production Floor WIP  " });
    ok("a store is renamed and the name trimmed", r.status === 200 && r.d.name === "Production Floor WIP", J(r.d));
    ok("a blank name is refused (400)", (await call("PATCH", "/warehouses/WH-WIP", O, { name: "   " })).status === 400);
    ok("an unknown store is 404", (await call("PATCH", "/warehouses/WH-NOPE", O, { name: "x" })).status === 404);
    const ty = await call("PATCH", "/warehouses/WH-PNY", O, { type: "Quarantine" });
    const held = (await call("GET", "/state", A)).d.warehouses.find((w) => w.id === "WH-PNY");
    ok("re-typing the MAIN store as a quarantine store (which makes all its stock undrawable) is refused or confirmed",
      ty.status >= 400, "accepted silently: WH-PNY is now type " + J(held && held.type));
    await call("PATCH", "/warehouses/WH-PNY", A, { type: "Raw Material" });
  }

  section("4f. Lab products and GRN tests — the deletes");
  {
    const p = await call("POST", "/lab/products", O, { name: "AUDIT DELETE ME", code: "AUD-DEL" });
    ok("a free-standing lab product is created", p.status === 201 && !!p.d.id, J(p.d));
    ok("…and deleted (200)", (await call("DELETE", "/lab/products/" + p.d.id, O)).status === 200);
    ok("deleting it again is 404", (await call("DELETE", "/lab/products/" + p.d.id, O)).status === 404);
    ok("the lab incharge cannot delete a lab product (403)", (await call("DELETE", "/lab/products/LP-001", L)).status === 403);
    /* a GRN test, filed and then deleted */
    const rm = { id: "RM-AUD-GT", name: "Audit test resin", cat: "RM", uom: "KG", cost: 5 };
    await call("POST", "/items", A, rm);
    await call("PUT", "/items/" + rm.id + "/qc", A, { params: ["viscosity"], spec: { viscosity: { min: 100, max: 200 } } });
    const sup = (await call("GET", "/state", A)).d.suppliers[0].id;
    const po = await call("POST", "/purchase-orders", O, { supplierId: sup, lines: [{ itemId: rm.id, qty: 10, rate: 5 }] });
    const rec = await call("POST", "/purchase-orders/" + po.d.id + "/receive", O, { wh: "WH-PNY", lines: [{ i: 0, qty: 10 }] });
    const g = rec.d.grn.id;
    const t = await call("POST", "/grns/" + encodeURIComponent(g) + "/tests", L, { itemId: rm.id, values: { viscosity: 150 } });
    ok("the lab files the incoming test", t.status === 201 && t.d.test && t.d.test.id, t.status + " " + J(t.d).slice(0, 120));
    ok("…and is not shown its verdict", t.d.test && t.d.test.result === undefined);
    ok("the lab cannot delete a filed test (403)", (await call("DELETE", "/grn-tests/" + t.d.test.id, L)).status === 403);
    ok("office deletes it (200)", (await call("DELETE", "/grn-tests/" + t.d.test.id, O)).status === 200);
    ok("deleting it again is 404", (await call("DELETE", "/grn-tests/" + t.d.test.id, O)).status === 404);
    const pend = (await call("GET", "/grn-tests/pending", L)).d.pending || [];
    ok("with its test deleted, the receipt line is back on the lab's worklist", pend.some((x) => x.grnId === g && x.itemId === rm.id));
    ok("GET /grn-tests/params lists the catalogue", ((await call("GET", "/grn-tests/params", S)).d.params || []).length >= 10);
  }

  section("4g. The BOM one-shot and the approval queue");
  {
    await call("POST", "/items", A, { id: "RM-AUD-B1", name: "Audit fabric", cat: "RM", uom: "KG", cost: 50 });
    await call("POST", "/items", A, { id: "FG-AUD-B1", name: "Audit tape", cat: "FG", uom: "KG", cost: 90, price: 150 });
    const ob = await call("POST", "/catalogue/bom", O, { itemId: "FG-AUD-B1", bom: { yield: 95, lines: [["RM-AUD-B1", 1.05]] },
      tests: { params: ["thickness"], spec: { thickness: { min: 0.1, max: 0.2 } } } });
    ok("office saves a recipe with its test parameters in one go (201)", ob.status === 201 && ob.d.bom && ob.d.labProduct, ob.status + " " + J(ob.d).slice(0, 160));
    ok("the yield is stored as a fraction", ob.d.bom && Math.abs(ob.d.bom.yield - 0.95) < 1e-9, J(ob.d.bom && ob.d.bom.yield));
    const lpId = ob.d.labProduct && ob.d.labProduct.id;
    const nProducts = ((await call("GET", "/state", A)).d.labProducts || []).filter((p) => p.itemId === "FG-AUD-B1").length;
    ok("the item still has exactly one lab product (the placeholder was configured, not duplicated)", nProducts === 1, nProducts);
    ok("a product may not be its own component (400)", (await call("POST", "/catalogue/bom", O,
      { itemId: "FG-AUD-B1", bom: { lines: [["FG-AUD-B1", 1]] } })).status === 400);
    ok("an unknown component is refused (400)", (await call("POST", "/catalogue/bom", O,
      { itemId: "FG-AUD-B1", bom: { lines: [["RM-NOPE", 1]] } })).status === 400);

    /* the lab proposes; only an admin decides */
    const pr = await call("POST", "/catalogue/bom", L, { itemId: "FG-AUD-B1", bom: { yield: 1, lines: [["RM-AUD-B1", 1.1]] } });
    ok("the lab's recipe becomes a proposal (202)", pr.status === 202 && pr.d.proposed === true && pr.d.proposal && pr.d.proposal.status === "Pending", pr.status + " " + J(pr.d).slice(0, 120));
    const apId = pr.d.proposal.id;
    const list = await call("GET", "/approvals", O);
    ok("GET /approvals lists it for office", list.status === 200 && (list.d.approvals || []).some((a) => a.id === apId));
    ok("office cannot decide it (403)", (await call("POST", "/approvals/" + apId + "/decide", O, { approve: true })).status === 403);
    ok("a decision must say yes or no (400)", (await call("POST", "/approvals/" + apId + "/decide", A, {})).status === 400);
    const dec = await call("POST", "/approvals/" + apId + "/decide", A, { approve: true, note: "ok" });
    ok("admin approves and it is applied", dec.status === 200 && dec.d.status === "Approved", J(dec.d).slice(0, 120));
    const bom = (await call("GET", "/state", A)).d.boms["FG-AUD-B1"];
    ok("…the recipe now reads the proposed quantity", bom && JSON.stringify(bom.lines).indexOf("1.1") >= 0, J(bom && bom.lines));
    ok("a decided proposal cannot be decided again (409)", (await call("POST", "/approvals/" + apId + "/decide", A, { approve: false })).status === 409);
    ok("the lab cannot withdraw a decided proposal (409)", (await call("DELETE", "/approvals/" + apId, L)).status === 409);
    /* the limits are admin's — can the lab set them through a proposal? */
    const pr2 = await call("POST", "/catalogue/new-item", L, { item: { id: "FG-AUD-LABSPEC", name: "Lab-limited tape", cat: "FG" },
      tests: { params: ["thickness"], spec: { thickness: { min: 0, max: 99 } } } });
    ok("the lab's new item is a proposal too (202)", pr2.status === 202, pr2.status);
    const sumTxt = String(pr2.d.proposal && pr2.d.proposal.summary);
    ok("a proposal that carries spec LIMITS says so in the summary the admin approves from",
      /limit|spec|min|max|0\s*[–-]\s*99/i.test(sumTxt), "summary reads: " + sumTxt);
    ok("the proposer withdraws their own pending proposal (200)", (await call("DELETE", "/approvals/" + pr2.d.proposal.id, L)).status === 200);
    ok("an unknown proposal kind is refused (400)", (await call("POST", "/approvals", L, { kind: "nope", payload: {} })).status === 400);
    /* office writing a spec: the /spec route is admin-only, the product PATCH is not */
    const sneak = await call("PATCH", "/lab/products/" + lpId, O, { spec: { thickness: { min: 0, max: 1000 } } });
    const after = (await call("GET", "/state", A)).d.labProducts.find((p) => p.id === lpId) || {};
    ok("office cannot rewrite spec LIMITS through PATCH /lab/products (the /spec route is admin-only)",
      sneak.status === 403 || JSON.stringify((after.spec || {}).thickness) === JSON.stringify({ min: 0.1, max: 0.2 }),
      "PATCH answered " + sneak.status + " and the stored limit is now " + J((after.spec || {}).thickness));
    /* ONE ITEM, ONE LAB PRODUCT (2026-09-10) — the placeholder case was fixed;
       what about an item whose product is already configured? */
    const second = await call("POST", "/lab/products", A, { name: "Audit tape (second)", itemId: "FG-AUD-B1",
      spec: { tensile: { min: 5 } } });
    const linked = ((await call("GET", "/state", A)).d.labProducts || []).filter((p) => p.itemId === "FG-AUD-B1");
    ok("a second lab product for an item that already has a configured one is refused (409)",
      second.status === 409 || linked.length === 1,
      second.status + " — the item now has " + linked.length + " lab products: " + J(linked.map((p) => p.id + (p.auto ? "(auto)" : ""))));
    const sheet = await call("GET", "/production/finished/FG-AUD-B1/lab", A);
    note("…the store door now asks for", J((sheet.d.params || []).map((p) => p.key)) + " from " + J(sheet.d.product && sheet.d.product.id));
    if (second.status === 201) await call("DELETE", "/lab/products/" + second.d.id, A);
  }

  section("4h. User accounts (PATCH /auth/users/:id) and sessions");
  {
    const u = await call("POST", "/auth/users", A, { username: "audit.clerk", name: "Audit Clerk", role: "office", password: "clerk-pass-1" });
    ok("admin creates a user (201)", u.status === 201 && u.d.user && u.d.user.role === "office", J(u.d));
    const uid = u.d.user.id;
    ok("usernames are unique case-insensitively (409)", (await call("POST", "/auth/users", A, { username: "Audit.Clerk", role: "office", password: "xxxx" })).status === 409);
    ok("a supervisor needs a valid area (400)", (await call("POST", "/auth/users", A, { username: "audit.s", role: "supervisor", area: "moon", password: "xxxx" })).status === 400);
    const t1 = await login("audit.clerk", "clerk-pass-1");
    ok("the new user signs in", !!t1);
    ok("…and sees office data", (await call("GET", "/state", t1)).status === 200);
    ok("GET /auth/users never carries a password hash", !/"pass"|scrypt|[0-9a-f]{64,}/.test(J((await call("GET", "/auth/users", A)).d)));
    const me = (await call("GET", "/auth/me", t1)).d.user || {};
    ok("/auth/me does not echo internal session bookkeeping", !("revokedSids" in me) && !("tokenVersion" in me), Object.keys(me).join(","));
    const toLab = await call("PATCH", "/auth/users/" + uid, A, { role: "lab" });
    ok("a role change applies to the live session at once", toLab.status === 200 && (await call("GET", "/state", t1)).d.role === "lab");
    const toSup = await call("PATCH", "/auth/users/" + uid, A, { role: "supervisor" });
    const sup = toSup.d.user || {};
    ok("making someone a supervisor without an area is refused (400)", toSup.status === 400,
      toSup.status + " — stored role " + sup.role + " area " + J(sup.area));
    const badArea = await call("PATCH", "/auth/users/" + uid, A, { role: "supervisor", area: "everything" });
    ok("an area outside coating/slitting/fiberglass is refused (400)", badArea.status === 400,
      badArea.status + " — stored area " + J(badArea.d.user && badArea.d.user.area));
    await call("PATCH", "/auth/users/" + uid, A, { role: "office", area: null });
    const pw = await call("PATCH", "/auth/users/" + uid, A, { password: "new-pass-22" });
    ok("an admin password reset answers 200", pw.status === 200);
    ok("…and kills the old session", (await call("GET", "/state", t1)).status === 401);
    ok("…and the new password works", !!(await login("audit.clerk", "new-pass-22")));
    ok("a 3-character password is refused (400)", (await call("PATCH", "/auth/users/" + uid, A, { password: "abc" })).status === 400);
    const weak = await call("PATCH", "/auth/users/" + uid, A, { password: "abcd" });
    ok("an admin-set password is held to the same 8-character minimum as a self-service change", weak.status === 400,
      "a 4-character password was accepted (" + weak.status + ")");
    const t2 = await login("audit.clerk", weak.status === 200 ? "abcd" : "new-pass-22");
    await call("PATCH", "/auth/users/" + uid, A, { active: false });
    ok("deactivating a user ends their session", (await call("GET", "/state", t2)).status === 401);
    ok("…and they cannot sign in", !(await login("audit.clerk", weak.status === 200 ? "abcd" : "new-pass-22")));
    ok("PATCH of an unknown user is 404", (await call("PATCH", "/auth/users/U-NOPE", A, { name: "x" })).status === 404);
    ok("an invalid role is refused (400)", (await call("PATCH", "/auth/users/" + uid, A, { role: "god" })).status === 400);
    ok("the primary admin cannot be deleted (400)", (await call("DELETE", "/auth/users/U-ADMIN", A)).status === 400);
    /* …but can it be demoted or switched off? That locks everybody out of
       Users & Access, payroll reopen, spec limits and every ruling. */
    const self = await call("PATCH", "/auth/users/U-ADMIN", A, { role: "office" });
    const lastAdmin = ((await call("GET", "/auth/users", A)).d.users || []);
    ok("the last admin cannot demote themselves (no admin would be left)", self.status >= 400,
      "PATCH U-ADMIN {role:office} → " + self.status + "; admins left: " + lastAdmin.filter((x) => x.role === "admin").length);
    if (self.status < 400) {
      /* restore through the database — no admin session can do it any more */
      const repo = require("../src/db/userRepository");
      await repo.updateUser("U-ADMIN", { role: "admin" });
    }
    const off = await call("PATCH", "/auth/users/U-ADMIN", A, { active: false });
    ok("…nor switch their own account off", off.status >= 400, "PATCH U-ADMIN {active:false} → " + off.status);
    if (off.status < 400) { const repo = require("../src/db/userRepository"); await repo.updateUser("U-ADMIN", { active: true }); }
    tok.admin = await login("admin");
    await call("DELETE", "/auth/users/" + uid, tok.admin);

    /* self-service password change */
    const A2 = tok.admin;
    ok("change-password needs the current password (401)", (await call("POST", "/auth/change-password", A2, { currentPassword: "wrong", newPassword: "whatever-123" })).status === 401);
    ok("…and at least 8 characters (400)", (await call("POST", "/auth/change-password", A2, { currentPassword: "admin@123", newPassword: "short" })).status === 400);

    /* logout ends only this sign-in */
    const a1 = await login("office"), a2 = await login("office");
    await call("POST", "/auth/logout", a1);
    ok("logout revokes this sign-in", (await call("GET", "/state", a1)).status === 401);
    ok("…and leaves the same account's other sign-in working", (await call("GET", "/state", a2)).status === 200);

    /* brute force */
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await call("POST", "/auth/login", null, { username: "lab", password: "bad" + i })).status);
    ok("5 wrong passwords lock the account for this address (the 6th is 429)", codes.slice(0, 5).every((c) => c === 401) && codes[5] === 429, J(codes));
    ok("…and a correct password is refused during the lock", (await call("POST", "/auth/login", null, { username: "lab", password: "lab@123" })).status === 429);
    ok("the lock is per account: another user still signs in", !!(await login("slitting1")));
  }

  section("4i. HR — the punch device, leave types, leaves, payslips");
  {
    const O2 = await login("office");
    const w = await call("POST", "/hr/workers", O2, { name: "Audit Worker", monthlyCtc: 15600, deviceUid: "AUD-77", joined: "2025-01-01" });
    ok("a worker is created", w.status === 201 && w.d.id, J(w.d).slice(0, 120));
    const wid = w.d.id;
    ok("a second worker on the same device id is refused (409)", (await call("POST", "/hr/workers", O2, { name: "Clash", deviceUid: "AUD-77" })).status === 409);
    ok("a punch with no key and no login is refused (401)", (await call("POST", "/hr/punch", null, { deviceUid: "AUD-77" })).status === 401);
    ok("a punch with a wrong device key is refused (401)", (await call("POST", "/hr/punch", null, { deviceUid: "AUD-77" }, { headers: { "X-Device-Key": "nope" } })).status === 401);
    await call("PATCH", "/hr/config", O2, { deviceKey: "audit-device-key" });
    const p1 = await call("POST", "/hr/punch", null, { deviceUid: "AUD-77", ts: "2026-09-07T03:30:00Z" }, { headers: { "X-Device-Key": "audit-device-key" } });
    ok("the device key admits a punch (201)", p1.status === 201 && p1.d.matched === true, p1.status + " " + J(p1.d).slice(0, 140));
    ok("a UTC punch is stored as factory-local time (09:00 IST)", p1.d.punch && /T09:00/.test(p1.d.punch.ts), p1.d.punch && p1.d.punch.ts);
    const pb = await call("POST", "/hr/punch/batch", null, { punches: [{ deviceUid: "AUD-77", ts: "2026-09-07T12:30:00Z" }, { deviceUid: "UNKNOWN-9", ts: "2026-09-07T12:31:00Z" }, { ts: "2026-09-07T12:32:00Z" }] },
      { headers: { "X-Device-Key": "audit-device-key" } });
    ok("a batch is processed one by one and reports each", pb.status === 201 && pb.d.processed === 3 && pb.d.results[1].matched === false && pb.d.results[2].ok === false, J(pb.d).slice(0, 200));
    const day = ((await call("GET", "/state", O2)).d.hrAttendance || []).find((a) => a.workerId === wid && a.date === "2026-09-07");
    ok("two punches make a present day of 9 h", day && day.status === "P" && Math.abs(day.hours - 9) < 0.01, J(day));
    ok("the key also works in the query string", (await call("POST", "/hr/punch?key=audit-device-key", null, { deviceUid: "AUD-77" })).status === 201);
    ok("GET /hr/punches lists recent punches", ((await call("GET", "/hr/punches?limit=5", O2)).d.punches || []).length >= 3);
    ok("a punch with a nonsense timestamp is refused (400)", (await call("POST", "/hr/punch", O2, { deviceUid: "AUD-77", ts: "yesterday-ish" })).status === 400);

    const lt = await call("POST", "/hr/leave-types", O2, { id: "AUDL", name: "Audit leave", quota: 2, paid: true });
    ok("a leave type is saved", lt.status === 201, J(lt.d));
    ok("a leave type needs an id (400)", (await call("POST", "/hr/leave-types", O2, { name: "x" })).status === 400);
    const lv = await call("POST", "/hr/leaves", O2, { workerId: wid, type: "AUDL", fromDate: "2026-09-08", toDate: "2026-09-09" });
    ok("a leave is applied (201)", lv.status === 201 && lv.d.days === 2, J(lv.d));
    const delType = await call("DELETE", "/hr/leave-types/AUDL", O2);
    ok("a leave type that leaves are filed under cannot be deleted", delType.status >= 400,
      "deleted with " + delType.status + " — leave " + lv.d.id + " now names a type that does not exist");
    ok("deleting a leave type that never existed is 404", (await call("DELETE", "/hr/leave-types/NOPE-TYPE", O2)).status === 404);
    ok("DELETE /hr/leaves/:id removes a leave (200)", (await call("DELETE", "/hr/leaves/" + lv.d.id, O2)).status === 200);
    ok("…and an unknown one is 404", (await call("DELETE", "/hr/leaves/" + lv.d.id, O2)).status === 404);

    const run = await call("POST", "/hr/payroll/run", O2, { period: "2026-08", workerIds: [wid] });
    ok("a pay run for one worker", run.status === 201 && run.d.payrun && run.d.payrun.id === "PR-2026-08", run.status + " " + J(run.d).slice(0, 100));
    const slips = await call("GET", "/hr/payroll/PR-2026-08/payslips", O2);
    ok("GET /hr/payroll/:id/payslips returns its payslips", slips.status === 200 && (slips.d.payslips || []).some((s) => s.workerId === wid), J(slips.d).slice(0, 120));
    ok("…an unknown run returns an empty list rather than 404", (await call("GET", "/hr/payroll/PR-1999-01/payslips", O2)).status === 200);
    note("GET /hr/payroll/:id/payslips has no caller in the frontend (the payslips arrive in /state)");
    await call("DELETE", "/hr/payroll/PR-2026-08", O2);
    await call("DELETE", "/hr/workers/" + wid, O2);
  }

  section("4j. Exchange rates");
  {
    ok("a bad currency pair is refused without going to the network (400)", (await call("GET", "/fx/pair?from=US&to=INR")).status === 400);
    const t0 = Date.now();
    const fx = await call("GET", "/fx/pair?from=USD&to=INR");
    note("GET /fx/pair?from=USD&to=INR", fx.status + " in " + (Date.now() - t0) + " ms " + J(fx.d).slice(0, 160));
    ok("the live rate lookup never answers 500 (network or not)", fx.status < 500, fx.status + " " + J(fx.d).slice(0, 160));
    const fx2 = await call("GET", "/fx?add=THB,xx,EVIL$$,SEK");
    ok("GET /fx ignores malformed currency codes", fx2.status < 500, fx2.status + " " + J(fx2.d).slice(0, 120));
  }

  section("5. The HTTP surface");
  {
    const base = H.base;
    const idx = await fetch(base + "/");
    ok("the app shell is served (200, no-store)", idx.status === 200 && /no-store/.test(idx.headers.get("cache-control") || ""));
    ok("X-Powered-By is not advertised", !idx.headers.get("x-powered-by"), "X-Powered-By: " + idx.headers.get("x-powered-by"));
    ok("the page may not be framed by another site (X-Frame-Options / CSP frame-ancestors)",
      !!(idx.headers.get("x-frame-options") || /frame-ancestors/.test(idx.headers.get("content-security-policy") || "")), "no anti-framing header");
    ok("nosniff is set", /nosniff/i.test(idx.headers.get("x-content-type-options") || ""), "no X-Content-Type-Options");
    const nope = await call("GET", "/definitely-not-a-route", tok.admin);
    ok("an unknown /api path answers 404 in JSON", nope.status === 404 && typeof nope.d === "object", nope.status + " " + String(nope.text).slice(0, 60));
    const lg = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: J({ username: "office", password: "office@123" }) });
    const ck = lg.headers.get("set-cookie") || "";
    ok("the session cookie is HttpOnly and SameSite=Strict", /HttpOnly/i.test(ck) && /SameSite=Strict/i.test(ck), ck.slice(0, 120));
    ok("malformed JSON is a 400, with no stack trace", await (async () => {
      const r = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
      const t = await r.text(); return r.status === 400 && !/at .*\.js:\d+/.test(t);
    })());
    const big = "x".repeat(1.2 * 1024 * 1024);
    ok("a body over 1 MB on an ordinary route is refused (413)", (await call("POST", "/items", tok.admin, null, { raw: J({ id: "RM-BIG", name: big }) })).status === 413);
    ok("an anonymous 2 MB body to a 25 MB route is refused before parsing (413)", (await call("PUT", "/state", null, null, { raw: J({ x: "y".repeat(2 * 1024 * 1024) }) })).status === 413);
    ok("path traversal out of the frontend folder is not served", (await fetch(base + "/js/../../backend/package.json")).status === 404);
    ok("…nor with encoded dots", (await fetch(base + "/%2e%2e/backend/src/server.js")).status >= 400);
    ok("the database file / env are not served", (await fetch(base + "/run-local.cmd")).status === 404);
  }

  section("6. Hostile input — no write route may answer 500");
  {
    const A3 = await login("admin");
    const bodies = [
      ["an array", []], ["a bare string", "x"], ["null", null], ["an empty object", {}],
      ["objects where strings go", { id: { $gt: "" }, name: { a: 1 }, itemId: [1], customerId: {}, supplierId: [] }],
      ["strings where numbers go", { qty: "lots", rate: "cheap", price: "NaN", yield: "Infinity", amount: "1e999" }],
      ["lines that are not lines", { lines: "x" }], ["lines of nulls", { lines: [null, 1, "a"] }],
      ["lines of empty objects", { lines: [{}, { i: "x", qty: -1 }] }],
      ["Infinity quantities", { itemId: "RM-X", qty: 1e308 * 10, type: "GRN", wh: "WH-PNY" }],
      ["SQL-ish text", { id: "x'); DROP TABLE items;--", name: "' OR 1=1 --" }],
      ["deep nesting", JSON.parse("{\"a\":".repeat(200) + "1" + "}".repeat(200))],
      ["a prototype-pollution attempt", JSON.parse("{\"__proto__\":{\"isAdmin\":true},\"constructor\":{\"prototype\":{\"polluted\":1}}}")],
    ];
    const skip = new Set(["POST /api/reset", "POST /api/auth/logout", "POST /api/auth/login", "PUT /api/tds", "DELETE /api/tds"]);
    const writes = routes.filter((r) => /^(POST|PUT|PATCH|DELETE) /.test(r) && !skip.has(r));
    const ids = ["AUDIT-NOPE", "%00", "..%2F..%2Fetc", "x".repeat(300), "' OR '1'='1", "WO-0001"];
    const five = [];
    let sent = 0;
    for (const r of writes) {
      const [m, p] = r.split(" ");
      const pathOnly = p.replace(/^\/api/, "");
      for (const [label, b] of bodies) {
        const res = await call(m, fill(pathOnly), A3, m === "DELETE" ? undefined : b);
        sent++;
        if (res.status >= 500) five.push(r + " with " + label + " → " + res.status);
      }
      if (/:/.test(p)) for (const id of ids) {
        const res = await call(m, pathOnly.replace(/:[a-zA-Z]+/g, id), A3, m === "DELETE" ? undefined : {});
        sent++;
        if (res.status >= 500) five.push(r + " with id " + JSON.stringify(id).slice(0, 30) + " → " + res.status);
      }
    }
    ok("none of " + sent + " hostile requests to " + writes.length + " write routes answered 5xx", five.length === 0, J(five.slice(0, 40)));
    ok("the prototype-pollution attempt did not reach Object.prototype", ({}).isAdmin === undefined && ({}).polluted === undefined);
    const alive = await call("GET", "/health");
    ok("the server is still up afterwards", alive.status === 200);
    /* a quantity the database cannot hold */
    const inf = await call("POST", "/movements", A3, { itemId: "RM-AUD-GT", type: "GRN", qty: "Infinity", wh: "WH-PNY", manual: true });
    ok("an 'Infinity' quantity is refused (400), not stored or 500", inf.status === 400, inf.status + " " + J(inf.d).slice(0, 100));
    const bigq = await call("POST", "/movements", A3, { itemId: "RM-AUD-GT", type: "GRN", qty: 1e15, wh: "WH-PNY", manual: true });
    ok("an absurd receipt (10^15 kg) is refused as implausible", bigq.status === 400, bigq.status + " — accepted");
    const date = await call("POST", "/movements", A3, { itemId: "RM-AUD-GT", type: "GRN", qty: 1, wh: "WH-PNY", date: "2026-13-45", manual: true });
    ok("a movement dated 2026-13-45 is refused (400)", date.status === 400, date.status + " — the ledger now holds an impossible date");
    const fut = await call("POST", "/movements", A3, { itemId: "RM-AUD-GT", type: "GRN", qty: 1, wh: "WH-PNY", date: "2099-01-01", manual: true });
    ok("a movement dated 2099 is refused or flagged", fut.status === 400, fut.status + " — accepted");
  }

  section("7. Starting the ERP when its port is already taken");
  {
    /* A second double-click on run-local.cmd, or a stale server still up.
       The process should say so and stop, not print the start-up banner and
       sit there connected to the database serving nothing. */
    const net = require("net"), { spawn } = require("child_process"), path = require("path");
    const blocker = net.createServer().listen(0, "::");
    await new Promise((r) => blocker.once("listening", r));
    const port = blocker.address().port;
    const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
      env: Object.assign({}, process.env, { PORT: String(port) }), stdio: ["ignore", "pipe", "pipe"] });
    let outTxt = "";
    child.stdout.on("data", (b) => { outTxt += b; }); child.stderr.on("data", (b) => { outTxt += b; });
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => resolve("still running"), 15000);
      child.once("exit", (c) => { clearTimeout(t); resolve(c); });
    });
    if (code === "still running") child.kill();
    blocker.close();
    ok("a server that cannot open its port exits with an error", code !== "still running" && code !== 0,
      "after 15 s it is " + code + "; it logged EADDRINUSE " + /EADDRINUSE/.test(outTxt) + " and then printed its normal banner: "
      + J((outTxt.match(/Chhaperia ERP[\s\S]{0,120}/) || [""])[0].replace(/\s+/g, " ")));
  }
}

run().then(() => H.finish(), (e) => H.finish(e));
