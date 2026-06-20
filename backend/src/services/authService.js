/* ============================================================
   CHHAPERIA ERP — BACKEND · auth service (security brain)
   Pure Node 'crypto' — no external deps (avoids native-build
   pain). Provides:
     • password hashing/verify  (scrypt, salted)
     • stateless signed tokens   (HMAC-SHA256, like a mini-JWT)
     • login / current-user resolution
     • first-run seeding of default accounts
   Tokens are signed with a server secret so the client cannot
   forge a role. Nothing sensitive (no password) is in the token.
   ============================================================ */
"use strict";
const crypto = require("crypto");
const users = require("../db/userRepository");

/* ---- server secret (set AUTH_SECRET in prod; dev fallback below) ---- */
const SECRET = process.env.AUTH_SECRET ||
  "chhaperia-dev-secret-change-me-in-production-8f2a1c";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/* ============================================================
   PASSWORD HASHING  (scrypt with per-user random salt)
   Stored format: "<saltHex>:<hashHex>"
   ============================================================ */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  return salt.toString("hex") + ":" + hash.toString("hex");
}

function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [saltHex, hashHex] = stored.split(":");
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(String(plain), salt, 64);
  // constant-time compare to avoid timing attacks
  return expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual);
}

/* ============================================================
   TOKENS  (compact signed token: base64(payload).signature)
   ============================================================ */
function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sign(payloadStr) {
  return b64url(crypto.createHmac("sha256", SECRET).update(payloadStr).digest());
}

function issueToken(user) {
  const payload = { uid: user.id, role: user.role, area: user.area || null, exp: Date.now() + TOKEN_TTL_MS };
  const payloadStr = b64url(JSON.stringify(payload));
  return payloadStr + "." + sign(payloadStr);
}

/** Verify a token's signature + expiry; returns the payload or null. */
function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadStr, sig] = token.split(".");
  if (sign(payloadStr) !== sig) return null; // tampered / forged
  let payload;
  try { payload = JSON.parse(Buffer.from(payloadStr, "base64").toString("utf8")); }
  catch { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null; // expired
  return payload;
}

/* ============================================================
   LOGIN  /  CURRENT USER
   ============================================================ */
function login(username, password) {
  const u = users.findByUsername(username, true);
  if (!u || !u.active) return null;
  if (!verifyPassword(password, u.pass)) return null;
  users.touchLogin(u.id);
  const safe = users.findById(u.id); // without pass
  return { token: issueToken(safe), user: safe };
}

/** Resolve the user from a token (fresh from DB, so role changes apply). */
function userFromToken(token) {
  const payload = verifyToken(token);
  if (!payload) return null;
  const u = users.findById(payload.uid);
  if (!u || !u.active) return null;
  return u;
}

/* ============================================================
   SEEDING — create default accounts on first run.
   Default password for everyone is their username + "@123"
   (admin gets "admin@123"). Admin must change these.
   ============================================================ */
const DEFAULT_USERS = [
  { id: "U-ADMIN", username: "admin", name: "Administrator", role: "admin", area: null },
  { id: "U-OFFICE", username: "office", name: "Office Desk (Sales/Purchase/Finance)", role: "office", area: null },
  { id: "U-SUP-COAT1", username: "coating1", name: "Coating Supervisor 1", role: "supervisor", area: "coating" },
  { id: "U-SUP-COAT2", username: "coating2", name: "Coating Supervisor 2", role: "supervisor", area: "coating" },
  { id: "U-SUP-SLIT1", username: "slitting1", name: "Slitting Supervisor 1", role: "supervisor", area: "slitting" },
  { id: "U-SUP-SLIT2", username: "slitting2", name: "Slitting Supervisor 2", role: "supervisor", area: "slitting" },
  { id: "U-SUP-FG", username: "fiberglass", name: "Fiber-Glass & Slitting Supervisor", role: "supervisor", area: "fiberglass" },
];

function seedDefaultUsers() {
  if (users.countUsers() > 0) return { seeded: false, count: users.countUsers() };
  let n = 0;
  for (const du of DEFAULT_USERS) {
    users.createUser({ ...du, pass: hashPassword(du.username + "@123") });
    n++;
  }
  return { seeded: true, count: n };
}

/* ============================================================
   USER MANAGEMENT helpers (used by admin routes)
   ============================================================ */
const VALID_ROLES = ["admin", "office", "supervisor"];
const VALID_AREAS = ["coating", "slitting", "fiberglass"];

function createUserAccount({ username, name, role, area, password }) {
  username = String(username || "").trim().toLowerCase();
  if (!username) throw httpErr("Username is required", 400);
  if (!VALID_ROLES.includes(role)) throw httpErr("Invalid role", 400);
  if (role === "supervisor" && !VALID_AREAS.includes(area)) throw httpErr("Supervisor needs a valid area", 400);
  if (users.findByUsername(username)) throw httpErr("Username already exists", 409);
  if (!password || String(password).length < 4) throw httpErr("Password must be at least 4 characters", 400);
  const id = "U-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  return users.createUser({
    id, username, name: name || username, role,
    area: role === "supervisor" ? area : null,
    pass: hashPassword(password),
  });
}

function updateUserAccount(id, patch) {
  const out = {};
  if (patch.name != null) out.name = patch.name;
  if (patch.role != null) {
    if (!VALID_ROLES.includes(patch.role)) throw httpErr("Invalid role", 400);
    out.role = patch.role;
  }
  if (patch.area !== undefined) out.area = patch.area || null;
  if (patch.active != null) out.active = !!patch.active;
  if (patch.password) {
    if (String(patch.password).length < 4) throw httpErr("Password must be at least 4 characters", 400);
    out.pass = hashPassword(patch.password);
  }
  const u = users.updateUser(id, out);
  if (!u) throw httpErr("User not found", 404);
  return u;
}

function httpErr(msg, status) { const e = new Error(msg); e.status = status; return e; }

module.exports = {
  hashPassword, verifyPassword, issueToken, verifyToken,
  login, userFromToken, seedDefaultUsers,
  createUserAccount, updateUserAccount,
  listUsers: () => users.listUsers(),
  deleteUser: (id) => users.deleteUser(id),
  VALID_ROLES, VALID_AREAS,
};
