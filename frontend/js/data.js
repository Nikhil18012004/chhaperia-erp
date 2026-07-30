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
      let msg = res.status + " " + res.statusText;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  }

  /* ---- dataset ---- */
  async function loadAsync() { return http("GET", "/state"); }

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
  function saveSettings(settings) { return http("PATCH", "/settings", settings).catch((e) => console.warn("settings save failed", e)); }
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
  };

  /* ---- production / supervisor stage actions ---- */
  const production = {
    // advance a work order's CURRENT stage: start | pause | complete | dispatch
    advance(woId, action) { return http("POST", "/production/wo/" + woId + "/advance", { action }); },
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
    // floor actions: send material back to a store / record an unplanned run
    returnStock(payload) { return http("POST", "/production/return", payload); },
    adhoc(payload) { return http("POST", "/production/adhoc", payload); },
    // supervisor/admin: report extra raw material drawn from store — deducts each
    // line from the store. payload: { woId?, lines:[{ itemId, qty, location, reason }] }
    recordExcess(payload) { return http("POST", "/production/excess-material", payload); },
    // office/admin: delete a work order
    remove(woId) { return http("DELETE", "/production/wo/" + enc(woId)); },
  };

  global.DB = {
    loadAsync, save, saveSettings, reset, auth, users, production,
    items, movements, purchase, sales, boms, leads, customers, suppliers, org, transporters, warehouses, hr,
    labProducts, labReports,
    helpers: { daysAgo, daysAhead, iso, today: () => today, DAY },
  };
})(window);
