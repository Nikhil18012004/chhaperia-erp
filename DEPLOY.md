# Putting Chhaperia ERP into service

Two audiences: the **server** (one machine, runs the ERP and holds the data)
and the **devices** (office PCs, floor tablets, phones). Nothing here needs
the internet unless you deliberately publish the server beyond the factory.

---

## 1. The database

The backend talks to **MySQL 8.4**. It will not start without credentials —
there is no file it can fall back to.

```
CREATE DATABASE chhaperia_erp CHARACTER SET utf8mb4;
CREATE USER 'chhaperia'@'%' IDENTIFIED BY '<a real password>';
GRANT ALL PRIVILEGES ON chhaperia_erp.* TO 'chhaperia'@'%';
```

Never point the app at `root`. See `database/MIGRATION.md` for carrying data
across from the old SQLite file — one command, and it verifies the row counts
itself.

## 2. The environment

| Variable | Why it matters |
|---|---|
| `CHHAPERIA_DB_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_NAME` | where the database is. `_USER` has no default. |
| `CHHAPERIA_DB_SSL=true` | required if the database is not on this machine |
| `AUTH_SECRET` | **signs every login token.** Without it, anyone can forge an admin session |
| `NODE_ENV=production` | turns on the refusals below |
| `PORT` | defaults to 4000 |

Generate the secret once and keep it: `openssl rand -hex 32`. Changing it logs
everyone out, which is the correct way to end all sessions after a breach.

In production the server **refuses to start** if `AUTH_SECRET` is missing, if
the database password is empty, or if it would reach a remote database
unencrypted. Those refusals are the point — do not work around them.

## 3. First run

```
npm install --prefix backend --omit=dev
NODE_ENV=production AUTH_SECRET=... CHHAPERIA_DB_USER=... node backend/src/server.js
```

The schema and the eight seed accounts are created on first boot. **Change
every seeded password before the machine is reachable by anyone else** — they
start as `<username>@123`.

## 4. Reaching it from the floor

The server binds all interfaces, so any device on the same network can reach
`http://<server-ip>:4000/`. Find the address with `ipconfig` — and re-check it
after any network change, because it moves.

### Tablets and phones

Install the Android app (`android/`, built with `tools/build-apk.ps1`). It
asks for the server address on first launch and remembers it, so a changed IP
means retyping an address rather than reinstalling.

The web app is also a proper installable PWA — but a service worker only runs
over **HTTPS**, so "Add to home screen" will not work from a plain
`http://<ip>:4000` server. Over HTTP the Android app is the way; the PWA
becomes available the day the server is put behind HTTPS on a real domain.

## 5. If you publish it beyond the factory

Everything above assumes a private network. Before exposing it:

- Terminate **HTTPS** in front of it (Caddy or nginx); the app speaks plain
  HTTP and expects something else to hold the certificate. Cookies are already
  marked `secure` when `NODE_ENV=production`.
- Put the database on a private network, or set `CHHAPERIA_DB_SSL=true`.
- Take a backup before every deploy. `POST /api/reset` exists and does exactly
  what it says.

## 6. Backups

The data is entirely in MySQL:

```
mysqldump --single-transaction --routines chhaperia_erp > chhaperia-YYYY-MM-DD.sql
```

`--single-transaction` matters: without it a dump taken while goods are being
received can catch a receipt half-written.
