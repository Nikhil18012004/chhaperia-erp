/* ============================================================
   CHHAPERIA ERP — FRONTEND · data access (API client)
   This layer used to hold the seed + localStorage. In the
   3-tier architecture it is now a thin REST client that talks
   to the backend (which owns the SQLite database).

   The public surface is intentionally unchanged so the rest of
   the frontend keeps working:
       DB.loadAsync()      -> GET    /api/state   (Promise<dataset>)
       DB.save(dataset)    -> PUT    /api/state   (Promise, debounced)
       DB.reset()          -> POST   /api/reset   (Promise<dataset>)
       DB.helpers          -> pure client-side date math (unchanged)
   ============================================================ */
(function (global) {
  "use strict";

  // Same-origin by default (backend serves this frontend).
  // Override with window.CHHAPERIA_API_BASE if hosting separately.
  const BASE = (global.CHHAPERIA_API_BASE || "") + "/api";

  /* ---- date helpers (pure, client-side — used across modules) ---- */
  const DAY = 86400000;
  const today = new Date("2026-06-17T00:00:00");
  const iso = d => new Date(d).toISOString().slice(0, 10);
  const daysAgo = n => iso(today.getTime() - n * DAY);
  const daysAhead = n => iso(today.getTime() + n * DAY);

  async function http(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = res.status + " " + res.statusText;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
      throw new Error("API " + method + " " + path + " failed: " + msg);
    }
    return res.status === 204 ? null : res.json();
  }

  /** Load the full dataset from the backend (seeds on first run). */
  async function loadAsync() {
    return http("GET", "/state");
  }

  /* Debounced save so rapid UI mutations collapse into one PUT.
     Returns a promise that resolves when the in-flight save lands. */
  let saveTimer = null;
  let pending = null;
  function save(data) {
    pending = data;
    if (saveTimer) clearTimeout(saveTimer);
    return new Promise((resolve, reject) => {
      saveTimer = setTimeout(() => {
        const payload = pending; pending = null; saveTimer = null;
        http("PUT", "/state", payload).then(resolve).catch((e) => {
          console.warn("save failed", e); reject(e);
        });
      }, 250);
    });
  }

  /** Patch only the UI settings (fast path; optional). */
  function saveSettings(settings) {
    return http("PATCH", "/settings", settings).catch((e) => console.warn("settings save failed", e));
  }

  /** Regenerate the deterministic demo dataset on the server. */
  function reset() {
    return http("POST", "/reset");
  }

  global.DB = {
    loadAsync, save, saveSettings, reset,
    helpers: { daysAgo, daysAhead, iso, today: () => today, DAY },
  };
})(window);
