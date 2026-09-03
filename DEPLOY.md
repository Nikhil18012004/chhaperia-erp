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

On a machine that also RUNS THE TESTS, add the scratch schemas the suite
creates and drops for itself — and nothing wider:

```
GRANT ALL PRIVILEGES ON `chh\_smoke\_%`.* TO 'chhaperia'@'%';
GRANT ALL PRIVILEGES ON `chh\_http\_%`.*  TO 'chhaperia'@'%';
```

Never point the app at `root`. See `database/MIGRATION.md` for carrying data
across from the old SQLite file — one command, and it verifies the row counts
itself.

## 2. The environment

Copy `.env.example` to **`.env` in the repository root** and fill it in. That
file is this project's configuration and it is gitignored — see §2a for why it
is a file rather than machine-wide variables.

| Variable | Why it matters |
|---|---|
| `CHHAPERIA_DB_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_NAME` | where the database is. `_USER` has no default. |
| `CHHAPERIA_DB_SSL=true` | required if the database is not on this machine |
| `AUTH_SECRET` | **signs every login token.** Without it, anyone can forge an admin session |
| `NODE_ENV=production` | turns on the refusals below |
| `PORT` | defaults to 4000 |

Generate the secret once and keep it: `openssl rand -hex 32`. Changing it logs
everyone out, which is the correct way to end all sessions after a breach.

Anything already exported in the real environment wins over `.env`; the file
only fills in what is missing. That is what lets a container or a Render
service keep injecting its own secrets while a laptop reads them from disk.

## 2a. One project, one database, one folder

This machine may run other things. The ERP is built so that it cannot reach
into them, and nothing of it leaks out:

- **Configuration is a file inside the project**, not machine-wide variables.
  The bare `DATABASE_URL` — the most-shared variable name there is — is
  deliberately **not read**; if one is set the server says so once and ignores
  it. Every name the app honours starts with `CHHAPERIA_`.
- **One schema, and it must be ours.** On boot the app checks the schema it is
  pointed at. Empty, or already holding its own tables: it proceeds. Holding
  tables that belong to something else: it **refuses to start** rather than
  stamp an ERP over another application's data. (`CHHAPERIA_DB_ALLOW_FOREIGN=1`
  overrides it, for the one case where two things really do share a schema.)
- **Give the database account rights to this database only.** The `GRANT` in
  §1 is scoped to `chhaperia_erp.*` — so even a misconfiguration cannot write
  anywhere else. Never point the app at `root`.
- **Every file goes under the project.** `CHHAPERIA_DATA_DIR` defaults to
  `<repo>/data` and holds the BarTender hand-off CSVs and the TDS booklet.
  Override it for a mounted volume (the container image does); never point it
  at a shared location such as the system temp folder.
- **The test suite is fenced too.** Each run takes a throwaway schema named
  `chh_smoke_…` / `chh_http_…` and a directory under `data/_scratch/`, drops
  both at the end, and sweeps anything a killed run left behind. It never
  touches `chhaperia_erp`.

In production the server **refuses to start** if `AUTH_SECRET` is missing, if
the database password is empty, or if it would reach a remote database
unencrypted. Those refusals are the point — do not work around them.

## 3. First run

```
npm install --prefix backend --omit=dev
cp .env.example .env    # then fill it in (§2)
node backend/src/server.js
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

## 6. On AWS, in one command

`deploy/aws/` holds a CloudFormation template that builds the whole thing:
an EC2 instance running the app behind Caddy, and a private RDS MySQL 8.4.

```
powershell -ExecutionPolicy Bypass -File deploy/aws/deploy.ps1
powershell -ExecutionPolicy Bypass -File deploy/aws/deploy.ps1 -DomainName erp.chhaperia.in
```

It needs AWS credentials first — `aws configure` once, with a key from an IAM
user. Without them the script stops before creating anything.

**HTTPS is not decoration here.** In production the login cookie is marked
`secure`, so over plain HTTP the browser will not send it and *nobody can sign
in*. Caddy is on the instance to obtain and renew a real certificate by itself.
With no domain of your own the stack uses a free `sslip.io` name derived from
the instance's IP, which still gets a genuine certificate — enough to start,
and you can move to your own name later without rebuilding.

What the template deliberately does:

- The **database has no public address.** It sits in private subnets and
  accepts port 3306 from the application's security group and nothing else.
- **Both secrets are generated by AWS**, not written here — the database
  password and `AUTH_SECRET` live in Secrets Manager, and the instance reads
  them at boot through its own role. Neither appears in the template, the
  console, or a log.
- **No SSH port and no key pair.** A shell comes from SSM Session Manager;
  the stack prints the command.
- `DeletionProtection` on the database and a `Snapshot` deletion policy, so
  tearing the stack down cannot quietly take the ledger with it.
- Backups retained 7 days, taken around midnight IST.

Two things to do the moment it is up:

1. **Change every seeded password.** The eight accounts start as
   `<username>@123`; on a public address that is an unlocked door.
2. **Narrow who can reach it.** Re-run with `-AdminCidr <your-office-ip>/32`
   and only the works can open the site at all.

Rough cost in `ap-south-1` at the defaults (t3.small + db.t4g.micro + 40 GB +
an elastic IP): on the order of **USD 35–45 a month**. `-InstanceType t3.micro`
trims it, at the risk of swapping during a catalogue import.

## 7. Backups

The data is entirely in MySQL:

```
mysqldump --single-transaction --routines chhaperia_erp > chhaperia-YYYY-MM-DD.sql
```

`--single-transaction` matters: without it a dump taken while goods are being
received can catch a receipt half-written.
