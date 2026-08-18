/* ============================================================
   CHHAPERIA ERP — DATABASE LAYER · user repository (DAO) [MySQL]
   The ONLY place with SQL for the users table. Stores/reads
   user accounts for authentication & RBAC. Passwords are
   already-hashed strings by the time they reach here.

   ⚠ findByUsername STILL COMPARES CASE-INSENSITIVELY, on purpose.
   The users table is stored under a case-SENSITIVE collation so
   that 'Admin' and 'admin' remain two different rows exactly as
   they were under SQLite — but signing in has always accepted
   either spelling, and taking that away would lock people out of
   accounts they have been using for months. LOWER() on both sides
   keeps the old behaviour under the new collation.
   ============================================================ */
"use strict";
const { db } = require("./connection");

const J = (o) => JSON.stringify(o || {});
/* A JSON column comes back parsed; a legacy TEXT column comes back as a
   string. Both have to survive the round trip. */
const P = (s, d) => {
  if (s == null) return d;
  if (typeof s === "object") return s;
  try { return JSON.parse(s); } catch { return d; }
};
/* Re-serialise whatever the driver handed back, so an untouched doc is
   written out in the same shape it would have been created in. */
const S = (v) => (v == null ? J({}) : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Map a DB row to a user object (never leaks the password hash by default). */
function rowToUser(r, includePass = false) {
  if (!r) return null;
  const u = {
    id: r.id, username: r.username, name: r.name, role: r.role,
    area: r.area || null, active: !!r.active,
    created: r.created, lastLogin: r.last_login,
    ...P(r.doc, {}),
  };
  if (includePass) u.pass = r.pass;
  return u;
}

async function listUsers() {
  const x = await db();
  return (await x.all("SELECT * FROM `users` ORDER BY `role`, `username`")).map((r) => rowToUser(r));
}

async function findByUsername(username, includePass = false) {
  const x = await db();
  const r = await x.one("SELECT * FROM `users` WHERE LOWER(`username`) = LOWER(?)",
    [String(username || "")]);
  return rowToUser(r, includePass);
}

async function findById(id, includePass = false) {
  const x = await db();
  const r = await x.one("SELECT * FROM `users` WHERE `id` = ?", [id]);
  return rowToUser(r, includePass);
}

async function countUsers() {
  const x = await db();
  return Number(await x.val("SELECT COUNT(*) AS `n` FROM `users`"));
}

/** Insert a new user. `pass` must already be hashed. */
async function createUser(u) {
  const x = await db();
  await x.run(
    "INSERT INTO `users` " +
    "(`id`,`username`,`name`,`role`,`area`,`pass`,`active`,`created`,`last_login`,`doc`) " +
    "VALUES(:id,:username,:name,:role,:area,:pass,:active,:created,:last_login,:doc)",
    {
      id: u.id, username: u.username, name: u.name || u.username,
      role: u.role, area: u.area || null, pass: u.pass,
      active: u.active === false ? 0 : 1,
      created: u.created || new Date().toISOString(),
      last_login: null, doc: J(u.doc),
    });
  return findById(u.id);
}

/** Update mutable fields. Only updates `pass` when a new hash is provided. */
async function updateUser(id, patch) {
  const x = await db();
  const cur = await x.one("SELECT * FROM `users` WHERE `id` = ?", [id]);
  if (!cur) return null;
  const next = {
    name: patch.name != null ? patch.name : cur.name,
    role: patch.role != null ? patch.role : cur.role,
    area: patch.area !== undefined ? patch.area : cur.area,
    active: patch.active != null ? (patch.active ? 1 : 0) : cur.active,
    pass: patch.pass != null ? patch.pass : cur.pass,
    doc: patch.doc != null ? J(patch.doc) : S(cur.doc),
  };
  await x.run(
    "UPDATE `users` SET `name`=:name, `role`=:role, `area`=:area, " +
    "`active`=:active, `pass`=:pass, `doc`=:doc WHERE `id`=:id",
    { ...next, id });
  return findById(id);
}

async function touchLogin(id) {
  const x = await db();
  await x.run("UPDATE `users` SET `last_login`=? WHERE `id`=?", [new Date().toISOString(), id]);
}

/** Merge fields into the user's doc JSON (tokenVersion, mustChangePassword…). */
async function patchDoc(id, patch) {
  const x = await db();
  const cur = await x.one("SELECT `doc` FROM `users` WHERE `id` = ?", [id]);
  if (!cur) return null;
  const doc = Object.assign(P(cur.doc, {}), patch || {});
  await x.run("UPDATE `users` SET `doc`=? WHERE `id`=?", [J(doc), id]);
  return findById(id);
}

async function deleteUser(id) {
  const x = await db();
  const res = await x.run("DELETE FROM `users` WHERE `id` = ?", [id]);
  return res.affectedRows > 0;
}

module.exports = {
  listUsers, findByUsername, findById, countUsers,
  createUser, updateUser, touchLogin, deleteUser, patchDoc,
};
