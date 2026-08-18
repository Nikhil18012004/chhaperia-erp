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

/* ---- server secret ----
   Tokens are HMAC-signed with this secret, so a known/committed value lets
   anyone forge an admin session. AUTH_SECRET MUST be set in production; we
   fail fast (refuse to boot) if it isn't. In development we fall back to a
   fixed local secret and warn loudly so tokens survive restarts. */
const IS_PROD = process.env.NODE_ENV === "production";
if (IS_PROD && !process.env.AUTH_SECRET) {
  throw new Error(
    "AUTH_SECRET is not set. Refusing to start in production with a default " +
    "token-signing secret — it would let anyone forge an admin session. " +
    "Set AUTH_SECRET to a long random value (e.g. `openssl rand -hex 32`) and restart."
  );
}
const SECRET = process.env.AUTH_SECRET ||
  "chhaperia-dev-secret-change-me-in-production-8f2a1c";
if (!process.env.AUTH_SECRET) {
  console.warn("[auth] AUTH_SECRET not set — using the INSECURE dev fallback secret. Never run production like this.");
}
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

function issueToken(user, sid) {
  // v = the user's token version; bumping it (password change / admin reset)
  //     instantly invalidates every outstanding token for the account.
  // sid = this SIGN-IN's own id. One account may be signed in on several
  //     machines at once — the shop floor shares logins — so signing out on
  //     one of them revokes only that sid and leaves the others working.
  //     Renewal carries the sid forward, so a session keeps one id for life.
  const payload = { uid: user.id, role: user.role, area: user.area || null,
    v: user.tokenVersion || 0, sid: sid || crypto.randomBytes(9).toString("hex"),
    exp: Date.now() + TOKEN_TTL_MS };
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
async function login(username, password) {
  const u = await users.findByUsername(username, true);
  if (!u || !u.active) return null;
  if (!verifyPassword(password, u.pass)) return null;
  await users.touchLogin(u.id);
  const safe = await users.findById(u.id); // without pass
  return { token: issueToken(safe), user: safe };
}

/** Sliding session: a token past the halfway point of its life is reissued so
    that ACTIVE use keeps someone signed in. Without this a session dies a hard
    12 hours after sign-in, which lands mid-shift on anyone who starts early.
    Returns null while the token is still fresh, so we are not re-signing and
    re-setting the cookie on every single request. */
function renewedToken(token, user) {
  const payload = verifyToken(token);
  if (!payload) return null;
  if (payload.exp - Date.now() > TOKEN_TTL_MS / 2) return null;
  return issueToken(user, payload.sid); // same session, later expiry
}

/** Resolve the user from a token (fresh from DB, so role changes apply).
    A token whose version lags the user's current one has been revoked. */
async function userFromToken(token) {
  const payload = verifyToken(token);
  if (!payload) return null;
  const u = await users.findById(payload.uid);
  if (!u || !u.active) return null;
  if ((payload.v || 0) !== (u.tokenVersion || 0)) return null; // account-wide revoke
  if (payload.sid && isSessionRevoked(u, payload.sid)) return null; // this device signed out
  return u;
}

/* ---- per-session revocation ----
   Signing out must end THAT sign-in only, never the same account's other
   machines. The list is pruned by expiry on every write, so it cannot grow
   without bound — a revoked sid stops mattering once its token would have
   expired anyway. */
function isSessionRevoked(user, sid) {
  return (user.revokedSids || []).some((r) => r && r.sid === sid && (r.exp || 0) > Date.now());
}

/** Revoke ONE sign-in (the device that clicked Sign Out). */
async function revokeSession(userId, sid) {
  const u = await users.findById(userId);
  if (!u || !sid) return null;
  const live = (u.revokedSids || []).filter((r) => r && (r.exp || 0) > Date.now());
  if (!live.some((r) => r.sid === sid)) live.push({ sid, exp: Date.now() + TOKEN_TTL_MS });
  return await users.patchDoc(userId, { revokedSids: live });
}

/** Invalidate every outstanding token for a user (password change / reset). */
async function revokeTokens(userId) {
  const u = await users.findById(userId);
  if (!u) return null;
  return await users.patchDoc(userId, { tokenVersion: (u.tokenVersion || 0) + 1 });
}

/** Self-service password change; clears the must-change flag and rotates
    the token version so old sessions die. Returns { token, user }. */
async function changePassword(userId, currentPassword, newPassword) {
  const u = await users.findById(userId, true);
  if (!u) throw httpErr("User not found", 404);
  if (!verifyPassword(currentPassword, u.pass)) throw httpErr("Current password is incorrect", 401);
  if (!newPassword || String(newPassword).length < 8) throw httpErr("New password must be at least 8 characters", 400);
  if (String(newPassword) === String(currentPassword)) throw httpErr("New password must be different", 400);
  await users.updateUser(userId, { pass: hashPassword(newPassword) });
  const fresh = await users.patchDoc(userId, {
    mustChangePassword: false,
    tokenVersion: (u.tokenVersion || 0) + 1,
  });
  return { token: issueToken(fresh), user: fresh };
}

/** Clear any leftover forced-password-change flag. Nothing sets the flag any
    more — changing a password is optional — so this only tidies up accounts
    flagged by an earlier build, which would otherwise be prompted forever. */
async function clearPasswordChangeFlags() {
  let cleared = 0;
  for (const u of await users.listUsers()) {
    if (!u.mustChangePassword) continue;
    await users.patchDoc(u.id, { mustChangePassword: false });
    cleared++;
  }
  return { cleared };
}

/* ============================================================
   SEEDING — create default accounts on first run.
   Default password for everyone is their username + "@123"
   (admin gets "admin@123"). Admin must change these.
   ============================================================ */
const DEFAULT_USERS = [
  { id: "U-ADMIN", username: "admin", name: "Administrator", role: "admin", area: null },
  { id: "U-OFFICE", username: "office", name: "Office Desk (Sales/Purchase/Finance)", role: "office", area: null },
  { id: "U-LAB", username: "lab", name: "Lab Incharge (QC)", role: "lab", area: null },
  { id: "U-SUP-COAT1", username: "coating1", name: "Coating Supervisor 1", role: "supervisor", area: "coating" },
  { id: "U-SUP-COAT2", username: "coating2", name: "Coating Supervisor 2", role: "supervisor", area: "coating" },
  { id: "U-SUP-SLIT1", username: "slitting1", name: "Slitting Supervisor 1", role: "supervisor", area: "slitting" },
  { id: "U-SUP-SLIT2", username: "slitting2", name: "Slitting Supervisor 2", role: "supervisor", area: "slitting" },
  { id: "U-SUP-FG", username: "fiberglass", name: "Fiber-Glass & Slitting Supervisor", role: "supervisor", area: "fiberglass" },
];

async function seedDefaultUsers() {
  if (await users.countUsers() > 0) return { seeded: false, count: await users.countUsers() };
  let n = 0;
  for (const du of DEFAULT_USERS) {
    await users.createUser({ ...du, pass: hashPassword(du.username + "@123") });
    n++;
  }
  return { seeded: true, count: n };
}

/* ============================================================
   USER MANAGEMENT helpers (used by admin routes)
   ============================================================ */
const VALID_ROLES = ["admin", "office", "lab", "supervisor"];
const VALID_AREAS = ["coating", "slitting", "fiberglass"];

async function createUserAccount({ username, name, role, area, password }) {
  username = String(username || "").trim().toLowerCase();
  if (!username) throw httpErr("Username is required", 400);
  if (!VALID_ROLES.includes(role)) throw httpErr("Invalid role", 400);
  if (role === "supervisor" && !VALID_AREAS.includes(area)) throw httpErr("Supervisor needs a valid area", 400);
  if (await users.findByUsername(username)) throw httpErr("Username already exists", 409);
  if (!password || String(password).length < 4) throw httpErr("Password must be at least 4 characters", 400);
  const id = "U-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  return await users.createUser({
    id, username, name: name || username, role,
    area: role === "supervisor" ? area : null,
    pass: hashPassword(password),
  });
}

async function updateUserAccount(id, patch) {
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
  const u = await users.updateUser(id, out);
  if (!u) throw httpErr("User not found", 404);
  if (patch.password) {
    // the new password stands on its own — no change is forced afterwards —
    // but every session issued under the OLD password is still revoked
    return await users.patchDoc(id, { tokenVersion: (u.tokenVersion || 0) + 1 });
  }
  return u;
}

function httpErr(msg, status) { const e = new Error(msg); e.status = status; return e; }

module.exports = {
  hashPassword, verifyPassword, issueToken, verifyToken, renewedToken,
  login, userFromToken, seedDefaultUsers, revokeSession,
  revokeTokens, changePassword, clearPasswordChangeFlags, IS_PROD,
  createUserAccount, updateUserAccount,
  listUsers: async () => await users.listUsers(),
  deleteUser: async (id) => await users.deleteUser(id),
  VALID_ROLES, VALID_AREAS,
};
