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

  /* ---- token store (localStorage so it survives reloads) ---- */
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; } }
  function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; } }
  function setSession(token, user) {
    try { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch {}
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
  };

  /* ---- admin user management ---- */
  const users = {
    list() { return http("GET", "/auth/users"); },
    create(u) { return http("POST", "/auth/users", u); },
    update(id, patch) { return http("PATCH", "/auth/users/" + id, patch); },
    remove(id) { return http("DELETE", "/auth/users/" + id); },
  };

  /* ---- production / supervisor stage actions ---- */
  const production = {
    // advance a work order's CURRENT stage: start | pause | complete | dispatch
    advance(woId, action) { return http("POST", "/production/wo/" + woId + "/advance", { action }); },
    // back-compat: advance by target status
    setStatus(woId, status) { return http("POST", "/production/wo/" + woId + "/status", { status }); },
    // office/admin: create a new work order (with a fresh multi-stage route)
    create(wo) { return http("POST", "/production/wo", wo); },
  };

  global.DB = {
    loadAsync, save, saveSettings, reset, auth, users, production,
    helpers: { daysAgo, daysAhead, iso, today: () => today, DAY },
  };
})(window);
