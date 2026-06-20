/* ============================================================
   CHHAPERIA ERP — DATABASE LAYER · user repository (DAO)
   The ONLY place with SQL for the users table. Stores/reads
   user accounts for authentication & RBAC. Passwords are
   already-hashed strings by the time they reach here.
   ============================================================ */
"use strict";
const { getDb } = require("./connection");

const J = (o) => JSON.stringify(o || {});
const P = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

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

function listUsers() {
  return getDb().prepare("SELECT * FROM users ORDER BY role, username").all().map((r) => rowToUser(r));
}

function findByUsername(username, includePass = false) {
  const r = getDb().prepare("SELECT * FROM users WHERE lower(username) = lower(?)").get(String(username || ""));
  return rowToUser(r, includePass);
}

function findById(id, includePass = false) {
  const r = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id);
  return rowToUser(r, includePass);
}

function countUsers() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM users").get().n;
}

/** Insert a new user. `pass` must already be hashed. */
function createUser(u) {
  getDb().prepare(`INSERT INTO users
    (id,username,name,role,area,pass,active,created,last_login,doc)
    VALUES(@id,@username,@name,@role,@area,@pass,@active,@created,@last_login,@doc)`)
    .run({
      id: u.id, username: u.username, name: u.name || u.username,
      role: u.role, area: u.area || null, pass: u.pass,
      active: u.active === false ? 0 : 1,
      created: u.created || new Date().toISOString(),
      last_login: null, doc: J(u.doc),
    });
  return findById(u.id);
}

/** Update mutable fields. Only updates `pass` when a new hash is provided. */
function updateUser(id, patch) {
  const cur = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!cur) return null;
  const next = {
    name: patch.name != null ? patch.name : cur.name,
    role: patch.role != null ? patch.role : cur.role,
    area: patch.area !== undefined ? patch.area : cur.area,
    active: patch.active != null ? (patch.active ? 1 : 0) : cur.active,
    pass: patch.pass != null ? patch.pass : cur.pass,
    doc: patch.doc != null ? J(patch.doc) : cur.doc,
  };
  getDb().prepare(`UPDATE users SET name=@name, role=@role, area=@area,
    active=@active, pass=@pass, doc=@doc WHERE id=@id`)
    .run({ ...next, id });
  return findById(id);
}

function touchLogin(id) {
  getDb().prepare("UPDATE users SET last_login=? WHERE id=?").run(new Date().toISOString(), id);
}

function deleteUser(id) {
  return getDb().prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
}

module.exports = {
  listUsers, findByUsername, findById, countUsers,
  createUser, updateUser, touchLogin, deleteUser,
};
