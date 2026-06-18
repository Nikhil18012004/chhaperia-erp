# Deploying Chhaperia ERP

The app is a single Node + Express server that exposes the REST API **and** serves
the static frontend on the same origin. State lives in SQLite (`better-sqlite3`),
so it needs a real server with a writable disk — **not** a static/serverless host.

It is already production-shaped:
- binds to `process.env.PORT` (`backend/src/server.js`)
- frontend calls the API same-origin (`frontend/js/data.js`) — nothing hardcoded
- DB location is overridable via `CHHAPERIA_DATA_DIR` (`backend/src/db/connection.js`)
- health check at `GET /api/health`

---

## Option A — Render (free, no credit card) ★ recommended to start

1. Make sure this repo is pushed to GitHub (it is: `Nikhil18012004/chhaperia-erp`).
2. Go to **https://render.com** → sign in with GitHub.
3. **New → Blueprint** → pick the `chhaperia-erp` repo → **Apply**.
   Render reads [`render.yaml`](render.yaml) and provisions the service.
4. Wait for the build → you get a public URL like `https://chhaperia-erp.onrender.com`.

Don't want to use a Blueprint? Do **New → Web Service** instead and set:
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/api/health`

> **Free-tier caveats:** the instance sleeps after ~15 min idle (first hit after
> sleep is slow), and there is **no persistent disk** — the SQLite DB is ephemeral.
> It auto-seeds demo data on each cold start and resets on redeploy. Fine for a
> demo. For durable data, see **"Make data persistent"** below.

## Option B — Docker host (Fly.io / Railway / Koyeb / …)

A [`Dockerfile`](Dockerfile) is included. It stores the DB at `/data` (a volume),
so data persists.

**Fly.io** (has a small free allowance; needs the `flyctl` CLI + a card on file):
```bash
# install: https://fly.io/docs/flyctl/install/
fly launch --no-deploy          # detects the Dockerfile; creates fly.toml
fly volumes create chhaperia_data --size 1 --region sin
# add to fly.toml:  [mounts]\n  source = "chhaperia_data"\n  destination = "/data"
fly deploy
```

**Railway:** New Project → Deploy from GitHub repo → it builds the Dockerfile →
add a Volume mounted at `/data`.

---

## Make data persistent

The DB path is controlled by the `CHHAPERIA_DATA_DIR` env var. Point it at a
mounted persistent disk:

- **Render (paid):** upgrade the service off `free`, add a **Disk** (e.g. mount
  path `/var/data`, 1 GB), then set env var `CHHAPERIA_DATA_DIR=/var/data`.
- **Docker hosts:** the image already uses `/data`; just attach a volume there
  (the Dockerfile declares `VOLUME ["/data"]`).

Without a persistent disk the app still works — it simply re-seeds demo data
whenever the instance restarts.

---

## Run locally (sanity check before deploying)

```bash
npm install        # installs backend deps via postinstall
npm start          # -> http://localhost:4000
```
