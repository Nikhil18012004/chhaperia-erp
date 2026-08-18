/* ============================================================
   CHHAPERIA ERP — BACKEND · auth routes + middleware
       POST /api/auth/login     -> { token, user }
       POST /api/auth/logout    -> client just drops the token
       GET  /api/auth/me        -> current user (from token)
       GET  /api/auth/users     -> [admin] list users
       POST /api/auth/users     -> [admin] create user
       PATCH/api/auth/users/:id -> [admin] update user / reset pw
       DEL  /api/auth/users/:id -> [admin] delete user
   Middleware exported for use by other routers:
       requireAuth   — must be logged in
       requireRole(...roles) — must hold one of the roles
   ============================================================ */
"use strict";
const express = require("express");
const auth = require("../services/authService");

const router = express.Router();

/* ---- middleware ---- */
const COOKIE_NAME = "chh_token";
const COOKIE_MAX_AGE = 12 * 60 * 60 * 1000; // matches token TTL

/* Minimal cookie parse — avoids a cookie-parser dependency. */
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
/* The token now travels in an httpOnly cookie (XSS cannot read it).
   Bearer headers keep working for API scripts and legacy sessions. */
function getToken(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return req.headers["x-auth-token"] || parseCookies(req)[COOKIE_NAME] || null;
}
function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, sameSite: "strict", secure: auth.IS_PROD,
    maxAge: COOKIE_MAX_AGE, path: "/",
  });
}
function clearAuthCookie(res) {
  res.cookie(COOKIE_NAME, "", { httpOnly: true, sameSite: "strict", secure: auth.IS_PROD, maxAge: 0, path: "/" });
}

async function requireAuth(req, res, next) {
  const token = getToken(req);
  const user = await auth.userFromToken(token);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  req.user = user;
  /* Sliding session — every authenticated request pushes the expiry back out
     once the token is over halfway through its life. Someone actually using
     the app is never signed out from under themselves; an idle machine still
     lapses on its own, which is the point of having an expiry at all. */
  const fresh = auth.renewedToken(token, user);
  if (fresh) setAuthCookie(res, fresh);
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden: insufficient role" });
    next();
  };
}

/* ---- brute-force guard for /login ----
   Locks an (ip + username) pair after repeated failures for a cooldown.
   In-memory (fine for this single-process server); no external deps. */
const MAX_FAILS = 5;             // failures allowed inside the window
const WINDOW_MS = 15 * 60 * 1000; // counting window
const LOCK_MS = 15 * 60 * 1000;   // lockout duration once tripped
const failMap = new Map();        // key -> { count, firstAt, lockUntil }
function limiterKey(req, username) {
  const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || "unknown").replace(/^::ffff:/, "");
  return ip + "|" + String(username || "").toLowerCase();
}
function lockSecondsLeft(key) {
  const e = failMap.get(key);
  if (e && e.lockUntil && Date.now() < e.lockUntil) return Math.ceil((e.lockUntil - Date.now()) / 1000);
  return 0;
}
function noteFail(key) {
  const now = Date.now();
  let e = failMap.get(key);
  if (!e || now - e.firstAt > WINDOW_MS) e = { count: 0, firstAt: now, lockUntil: 0 };
  e.count += 1;
  if (e.count >= MAX_FAILS) e.lockUntil = now + LOCK_MS;
  failMap.set(key, e);
}
// prune stale entries so the map can't grow unbounded
const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, e] of failMap) {
    if ((!e.lockUntil || now > e.lockUntil) && now - e.firstAt > WINDOW_MS) failMap.delete(k);
  }
}, WINDOW_MS);
if (pruneTimer.unref) pruneTimer.unref();

/* ---- auth endpoints ---- */
router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const key = limiterKey(req, username);
    const wait = lockSecondsLeft(key);
    if (wait) return res.status(429).json({ error: "Too many failed attempts. Try again in about " + Math.ceil(wait / 60) + " min." });
    const result = await auth.login(username, password);
    if (!result) { noteFail(key); return res.status(401).json({ error: "Invalid username or password" }); }
    failMap.delete(key); // reset on success
    setAuthCookie(res, result.token);
    res.json(result);
  } catch (e) { next(e); }
});

// Logout ends THIS sign-in only — its own session id is revoked and the
// cookie cleared. The same account signed in on another machine is left
// alone, because one login is routinely shared across the floor.
router.post("/logout", async (req, res) => {
  const token = getToken(req);
  const user = await auth.userFromToken(token);
  if (user) {
    const payload = auth.verifyToken(token);
    try { await auth.revokeSession(user.id, payload && payload.sid); } catch {}
  }
  clearAuthCookie(res);
  res.json({ ok: true });
});

// Self-service password change; rotates the session so other devices drop.
router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const result = await auth.changePassword(req.user.id, currentPassword, newPassword);
    setAuthCookie(res, result.token);
    res.json(result);
  } catch (e) { next(e); }
});

router.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));

/* ---- user management (admin only) ---- */
router.get("/users", requireAuth, requireRole("admin"), async (req, res, next) => {
  try { res.json({ users: await auth.listUsers() }); } catch (e) { next(e); }
});

router.post("/users", requireAuth, requireRole("admin"), async (req, res, next) => {
  try { res.status(201).json({ user: await auth.createUserAccount(req.body || {}) }); } catch (e) { next(e); }
});

router.patch("/users/:id", requireAuth, requireRole("admin"), async (req, res, next) => {
  try { res.json({ user: await auth.updateUserAccount(req.params.id, req.body || {}) }); } catch (e) { next(e); }
});

router.delete("/users/:id", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    if (req.params.id === "U-ADMIN") return res.status(400).json({ error: "Cannot delete the primary admin" });
    if (req.user.id === req.params.id) return res.status(400).json({ error: "Cannot delete your own account" });
    res.json({ deleted: await auth.deleteUser(req.params.id) });
  } catch (e) { next(e); }
});

module.exports = { router, requireAuth, requireRole, getToken };
