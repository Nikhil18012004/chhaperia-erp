/* ============================================================
   CHHAPERIA ERP — FRONTEND · data access (API client)
   Thin REST client to the backend (which owns the database).

   Now auth-aware: every request carries the logged-in user's
   token (Bearer). On 401 we drop the token and bounce to login.

   Public surface:
       DB.loadAsync()      -> GET    /api/state   (role-scoped)
       DB.save(dataset)    -> PUT    /api/state   (admin/office)
       DB.reset()          -> POST   /api/reset   (admin)
       DB.auth.login(u,p)  -> POST   /api/auth/login -> {token,user}
       DB.auth.me()        -> GET    /api/auth/me
       DB.auth.logout()    -> clears token (+ POST /logout)
       DB.auth.token()/user()/set()/clear()
       DB.users.*          -> admin user-management endpoints
       DB.helpers          -> pure client-side date math
   ============================================================ */
(function (global) {
  "use strict";

  const BASE = (global.CHHAPERIA_API_BASE || "") + "/api";
  const TOKEN_KEY = "chh_token";
  const USER_KEY = "chh_user";

  /* ---- session store ----
     The auth token now lives in an httpOnly cookie set by the server (so
     XSS cannot exfiltrate it); only the non-sensitive user profile is kept
     in localStorage. A token found in localStorage is a LEGACY session —
     still honoured via the Bearer header until its owner logs out. */
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; } }
  function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; } }
  function setSession(token, user) {
    try { localStorage.removeItem(TOKEN_KEY); localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch {}
  }
  function clearSession() {
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch {}
  }

  /* ---- date helpers (pure, client-side, LOCAL time) ---- */
  const DAY = 86400000;
  function iso(d){ const x = new Date(d);
    const y = x.getFullYear(), m = String(x.getMonth()+1).padStart(2,"0"), dd = String(x.getDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`; }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = n => iso(today.getTime() - n * DAY);
  const daysAhead = n => iso(today.getTime() + n * DAY);

  /* ---- core HTTP with auth + 401 handling ---- */
  async function http(method, path, body, opts) {
    opts = opts || {};
    const headers = { "Content-Type": "application/json" };
    const tok = getToken();
    if (tok) headers.Authorization = "Bearer " + tok;
    const res = await fetch(BASE + path, {
      method, headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !opts.noAuthRedirect) {
      // session gone/expired — drop it and show the login gate
      clearSession();
      if (global.App && typeof App.showLogin === "function") App.showLogin("Your session expired. Please sign in again.");
      throw new Error("Not authenticated");
    }
    if (!res.ok) {
      let msg = res.status + " " + res.statusText, body = null;
      try { body = await res.json(); if (body && body.error) msg = body.error; } catch {}
      /* Some 4xx answers carry detail the FORM has to act on — a material
         shortage lists what is short and how much can still be made — so the
         parsed body and status travel with the error instead of being lost. */
      const e = new Error(msg);
      e.status = res.status;
      if (body && typeof body === "object") Object.assign(e, { body }, body.shortage ? {
        shortage: body.shortage, canMake: body.canMake, pendingQty: body.pendingQty,
      } : {});
      throw e;
    }
    return res.status === 204 ? null : res.json();
  }

  /* ---- dataset ---- */
  /* `slim` asks the server to leave out the bulky reference data the caller
     already holds — used by the shop floor between stage actions. */
  async function loadAsync(opts) { return http("GET", "/state" + ((opts && opts.slim) ? "?slim=1" : "")); }

  let saveTimer = null, pending = null;
  function save(data) {
    pending = data;
    if (saveTimer) clearTimeout(saveTimer);
    return new Promise((resolve, reject) => {
      saveTimer = setTimeout(() => {
        const payload = pending; pending = null; saveTimer = null;
        http("PUT", "/state", payload).then(resolve).catch((e) => { console.warn("save failed", e); reject(e); });
      }, 250);
    });
  }
  function saveSettings(settings) { return http("PATCH", "/settings", settings); }
  function reset() { return http("POST", "/reset"); }

  /* ---- auth ---- */
  const auth = {
    token: getToken,
    user: getUser,
    set: setSession,
    clear: clearSession,
    async login(username, password) {
      const r = await http("POST", "/auth/login", { username, password }, { noAuthRedirect: true });
      if (r && r.token) setSession(r.token, r.user);
      return r;
    },
    async me() { return http("GET", "/auth/me"); },
    async logout() { try { await http("POST", "/auth/logout", {}, { noAuthRedirect: true }); } catch {} clearSession(); },
    async changePassword(currentPassword, newPassword) {
      const r = await http("POST", "/auth/change-password", { currentPassword, newPassword });
      if (r && r.user) setSession(r.token, r.user);
      return r;
    },
  };

  /* ---- admin user management ---- */
  const users = {
    list() { return http("GET", "/auth/users"); },
    create(u) { return http("POST", "/auth/users", u); },
    update(id, patch) { return http("PATCH", "/auth/users/" + id, patch); },
    remove(id) { return http("DELETE", "/auth/users/" + id); },
  };

  /* ---- granular writes (avoid full-dataset rewrites & last-writer clobber) ---- */
  const enc = encodeURIComponent;
  const items = {
    // upsert one item (PATCH is an INSERT-or-UPDATE on the server)
    put(item) { return http("PATCH", "/items/" + enc(item.id), item); },
    remove(id) { return http("DELETE", "/items/" + enc(id)); },
  };
  const movements = {
    add(m) { return http("POST", "/movements", m); },
  };
  const purchase = {
    // receive goods against a PO: { wh, date?, lines:[{i:lineIndex, qty}] }
    receive(poId, payload) { return http("POST", "/purchase-orders/" + enc(poId) + "/receive", payload); },
    create(po) { return http("POST", "/purchase-orders", po); },
    update(id, patch) { return http("PATCH", "/purchase-orders/" + enc(id), patch); },
    remove(id) { return http("DELETE", "/purchase-orders/" + enc(id)); },
  };
  const sales = {
    create(so) { return http("POST", "/sales-orders", so); },
    update(id, patch) { return http("PATCH", "/sales-orders/" + enc(id), patch); },
    remove(id) { return http("DELETE", "/sales-orders/" + enc(id)); },
    dispatch(id, payload) { return http("POST", "/sales-orders/" + enc(id) + "/dispatch", payload || {}); },
  };
  const boms = {
    // save one product's recipe: { yield, lines:[[rawId, perKg], …] }
    save(itemId, bom) { return http("PUT", "/boms/" + enc(itemId), bom); },
    remove(itemId) { return http("DELETE", "/boms/" + enc(itemId)); },
  };
  const leads = {
    create(lead) { return http("POST", "/leads", lead); },
    update(id, patch) { return http("PATCH", "/leads/" + enc(id), patch); },
    remove(id) { return http("DELETE", "/leads/" + enc(id)); },
  };
  const appointments = {
    create(a) { return http("POST", "/appointments", a); },
    update(id, patch) { return http("PATCH", "/appointments/" + enc(id), patch); },
    remove(id) { return http("DELETE", "/appointments/" + enc(id)); },
  };
  const complaints = {
    create(c) { return http("POST", "/complaints", c); },
    update(id, patch) { return http("PATCH", "/complaints/" + enc(id), patch); },
    remove(id) { return http("DELETE", "/complaints/" + enc(id)); },
    // the batch's other recipients and its lab reading — read-only
    spread(batch) { return http("GET", "/batches/" + enc(batch) + "/spread"); },
  };
  /* Quotations. A quote is a price discussion with a life of its own —
     opened, repriced round by round, won at a final price or lost against a
     counter price — so the moves are verbs on the server, not fields the
     client sets by hand. */
  const quotations = {
    create(q) { return http("POST", "/quotations", q); },
    update(id, patch) { return http("PATCH", "/quotations/" + enc(id), patch); },
    remove(id) { return http("DELETE", "/quotations/" + enc(id)); },
    reprice(id, body) { return http("POST", "/quotations/" + enc(id) + "/reprice", body || {}); },
    win(id, body) { return http("POST", "/quotations/" + enc(id) + "/win", body || {}); },
    lose(id, body) { return http("POST", "/quotations/" + enc(id) + "/lose", body || {}); },
    reopen(id) { return http("POST", "/quotations/" + enc(id) + "/reopen", {}); },
  };
  const customers = {
    upsert(cust) { return http("POST", "/customers", cust); },
    update(id, patch) { return http("PATCH", "/customers/" + enc(id), patch); },
    remove(id) { return http("DELETE", "/customers/" + enc(id)); },
  };
  const suppliers = {
    create(s) { return http("POST", "/suppliers", s); },
    update(id, patch) { return http("PATCH", "/suppliers/" + enc(id), patch); },
    remove(id) { return http("DELETE", "/suppliers/" + enc(id)); },
  };
  const org = {
    update(patch) { return http("PATCH", "/org", patch); },
  };
  const transporters = {
    create(t) { return http("POST", "/transporters", t); },
    update(id, patch) { return http("PATCH", "/transporters/" + enc(id), patch); },
    remove(id) { return http("DELETE", "/transporters/" + enc(id)); },
  };
  const warehouses = {
    update(id, patch) { return http("PATCH", "/warehouses/" + enc(id), patch); },
  };

  /* ---- Human Resources ---- */
  const hr = {
    // biometric ingest (also used by the in-app simulator via the office token)
    punch(p) { return http("POST", "/hr/punch", p); },
    punches(limit) { return http("GET", "/hr/punches?limit=" + (limit || 100)); },
    worker: {
      create(w) { return http("POST", "/hr/workers", w); },
      update(id, patch) { return http("PATCH", "/hr/workers/" + enc(id), patch); },
      remove(id) { return http("DELETE", "/hr/workers/" + enc(id)); },
    },
    attendance(a) { return http("POST", "/hr/attendance", a); },
    balances(workerId) { return http("GET", "/hr/leave-balances/" + enc(workerId)); },
    leaveType: {
      save(t) { return http("POST", "/hr/leave-types", t); },
      remove(id) { return http("DELETE", "/hr/leave-types/" + enc(id)); },
    },
    leave: {
      apply(l) { return http("POST", "/hr/leaves", l); },
      decide(id, status) { return http("POST", "/hr/leaves/" + enc(id) + "/decide", { status }); },
      remove(id) { return http("DELETE", "/hr/leaves/" + enc(id)); },
    },
    payroll: {
      run(period, opts) { return http("POST", "/hr/payroll/run", Object.assign({ period }, opts || {})); },
      finalize(id) { return http("POST", "/hr/payroll/" + enc(id) + "/finalize", {}); },
      remove(id) { return http("DELETE", "/hr/payroll/" + enc(id)); },
    },
    payslip: { update(id, patch) { return http("PATCH", "/hr/payslips/" + enc(id), patch); } },
    // an advance paid up front, recovered from later payslips month by month
    advance: {
      get(workerId) { return http("GET", "/hr/workers/" + enc(workerId) + "/advance"); },
      set(workerId, body) { return http("PUT", "/hr/workers/" + enc(workerId) + "/advance", body); },
    },
    config: {
      get() { return http("GET", "/hr/config"); },
      set(patch) { return http("PATCH", "/hr/config", patch); },
    },
  };

  /* ---- Lab reports (QC certificates + own product master) ---- */
  const labProducts = {
    create(p) { return http("POST", "/lab/products", p); },
    update(id, patch) { return http("PATCH", "/lab/products/" + enc(id), patch); },
    remove(id) { return http("DELETE", "/lab/products/" + enc(id)); },
    setSpec(id, spec) { return http("PUT", "/lab/products/" + enc(id) + "/spec", { spec }); },
  };
  const labReports = {
    create(r) { return http("POST", "/lab/reports", r); },
    update(id, patch) { return http("PATCH", "/lab/reports/" + enc(id), patch); },
    remove(id) { return http("DELETE", "/lab/reports/" + enc(id)); },
    // the admin's ruling on a failed certificate: accept the batch or reject it
    decide(id, accept, note) { return http("POST", "/lab/reports/" + enc(id) + "/decision", { accept, note }); },
  };

  /* ---- the catalogue, one shot, and the approval queue (2026-09-02) ----
     A new item with its test parameters and recipe in one request. Admin and
     office get it applied (201); the lab's becomes a proposal (202) that only
     an admin may approve — and every role reads the queue off /state. */
  const catalogue = {
    // { item:{…}, tests:{ params:[keys], custom:[{key,label,unit}], spec:{key:{min,max,nominal}} }, bom:{ mode:"none"|"create"|"append", … } }
    newItem(payload) { return http("POST", "/catalogue/new-item", payload); },
  };
  const approvals = {
    list() { return http("GET", "/approvals"); },
    propose(kind, payload) { return http("POST", "/approvals", { kind, payload }); },
    decide(id, approve, note) { return http("POST", "/approvals/" + enc(id) + "/decide", { approve, note }); },
    remove(id) { return http("DELETE", "/approvals/" + enc(id)); },
  };

  /* ---- the TDS booklet: what is on the server, and admin's replacement ---- */
  const tds = {
    info: () => http("GET", "/tds"),
    put: (name, data) => http("PUT", "/tds", { name, data }),
    reset: () => http("DELETE", "/tds"),
  };

  /* ---- Incoming-material testing: the lab incharge checks what a goods
     receipt actually brought in, and the result shows on the purchase order.
     `form` is fetched rather than read from state because it carries the
     parameter list for one material and the readings already filed. ---- */
  const grnTests = {
    catalogue() { return http("GET", "/grn-tests/params"); },
    pending() { return http("GET", "/grn-tests/pending"); },
    form(grnId, itemId) { return http("GET", "/grns/" + enc(grnId) + "/tests/" + enc(itemId)); },
    submit(grnId, payload) { return http("POST", "/grns/" + enc(grnId) + "/tests", payload); },
    remove(id) { return http("DELETE", "/grn-tests/" + enc(id)); },
    /* Which parameters a material is tested on: admin OR the lab incharge.
       `spec` (the pass/fail limits) is admin's alone — the server ignores it
       from anyone else rather than refusing the save, so a lab edit of the
       parameter list still goes through. */
    // `custom` — the material's own parameters [{key,label,unit}]; left out, the server keeps what it has
    setItemQc(itemId, params, spec, custom) { return http("PUT", "/items/" + enc(itemId) + "/qc", { params, spec, custom }); },
    // failed lots awaiting the admin's ruling, and that ruling
    decisions() { return http("GET", "/grn-tests/decisions"); },
    decide(id, approve, note) { return http("POST", "/grn-tests/" + enc(id) + "/decision", { approve, note }); },
  };

  /* ---- production / supervisor stage actions ---- */
  const production = {
    // advance a work order's CURRENT stage: start | pause | complete | dispatch
    // `extra` carries whatever the stage being closed has to state — today
    // that is wipWh, the store the coating floor puts the coated roll in
    advance(woId, action, extra) { return http("POST", "/production/wo/" + woId + "/advance", Object.assign({ action }, extra || {})); },
    // fill in the store for a roll coated before the question was asked (write once)
    setWipStore(woId, wh) { return http("POST", "/production/wo/" + woId + "/wip-store", { wh }); },
    // every remaining stage, in a single request
    advanceAll(woId) { return http("POST", "/production/wo/" + woId + "/advance", { action: "complete", all: true }); },
    // what raising this order would mean — shortage / pending, writes nothing
    preview(body) { return http("POST", "/production/wo/preview", body); },
    // office/admin release a pending balance (issues its material now)
    resume(woId, qty) { return http("POST", "/production/wo/" + woId + "/resume", qty == null ? {} : { qty }); },
    // back-compat: advance by target status
    setStatus(woId, status) { return http("POST", "/production/wo/" + woId + "/status", { status }); },
    // office/admin: create a new work order (with a fresh multi-stage route)
    create(wo) { return http("POST", "/production/wo", wo); },
    // office/admin: edit a planned run (due/priority any time; qty/line before start)
    update(woId, patch) { return http("PATCH", "/production/wo/" + woId, patch); },
    // office/admin: delete a work order (its posted movements roll back with it)
    remove(woId) { return http("DELETE", "/production/wo/" + woId); },
    // supervisor/admin: record finished stock made — deducts raws by BOM,
    // adds the produced qty to a warehouse. payload: { itemId, qty, wh }
    addFinishedStock(payload) { return http("POST", "/production/finished", payload); },
    /* the coating floor's QC reading for a batch. `labSheet` returns the
       parameters the Products master asks for (never the limits); `saveLab`
       records the measurement — coating cannot be finished without it. */
    labSheet(woId) { return http("GET", "/production/wo/" + enc(woId) + "/lab"); },
    saveLab(woId, payload) { return http("POST", "/production/wo/" + enc(woId) + "/lab", payload); },
    // the readings a product must carry before it can be booked into store
    finishedLabSheet(itemId) { return http("GET", "/production/finished/" + enc(itemId) + "/lab"); },
    // floor actions: send material back to a store / record an unplanned run
    returnStock(payload) { return http("POST", "/production/return", payload); },
    adhoc(payload) { return http("POST", "/production/adhoc", payload); },
    // supervisor/admin: report extra raw material drawn from store — deducts each
    // line from the store. payload: { woId?, lines:[{ itemId, qty, location, reason }] }
    recordExcess(payload) { return http("POST", "/production/excess-material", payload); },
    // office/admin: delete a work order
    remove(woId) { return http("DELETE", "/production/wo/" + enc(woId)); },
  };

  /* ---- BarTender hand-off: the server writes the sticker rows and starts
     the label app on its own machine (see backend bartenderService) ---- */
  const bartender = {
    stickers: (poId, csv) => http("POST", "/bartender/stickers", { poId, csv }),
    // the designed .btw the button opens — read by anyone, replaced by admin
    template: () => http("GET", "/bartender/template"),
    putTemplate: (name, data) => http("PUT", "/bartender/template", { name, data }),
  };

  global.DB = {
    loadAsync, save, saveSettings, reset, auth, users, production,
    items, movements, purchase, sales, boms, leads, appointments, complaints, quotations, customers, suppliers, org, transporters, warehouses, hr,
    labProducts, labReports, grnTests, bartender, tds, catalogue, approvals,
    helpers: { daysAgo, daysAhead, iso, today: () => today, DAY },
  };
})(window);
