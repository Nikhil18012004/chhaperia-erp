# Chhaperia ERP — Cable-Tape Manufacturing Suite

A modern ERP for **Chhaperia Cable Material Pvt. Ltd.** (Chhaperia Group) — India's
largest manufacturer of mica & cable insulation tapes, established 1959, Doddaballapur,
Bangalore. Built as a clean **3-tier (layered) architecture**: frontend, backend and
database are fully separated.

> Manufacturer of Mica Tapes, Water-Blocking Tapes, Semi-Conducting Tapes and Other
> Cable Tapes for fire-survival, HT/EHV power, instrumentation and optical cables.

---

## 🧱 Layered architecture

```
chhaperia-erp/
├── frontend/                 # PRESENTATION LAYER  (HTML/CSS/vanilla JS SPA)
│   ├── index.html
│   ├── css/                  # theme tokens + components
│   ├── js/
│   │   ├── data.js           #   → REST API client (talks to backend)
│   │   ├── engine.js         #   → client-side calc engine (views over the data)
│   │   ├── charts.js, ui.js, mod-*.js, app.js
│   └── assets/               # logo + favicons
│
├── backend/                  # APPLICATION / API LAYER  (Node + Express)
│   ├── package.json
│   └── src/
│       ├── server.js         #   → Express app: REST API + serves frontend
│       ├── routes/api.js     #   → HTTP endpoints (thin)
│       ├── services/         #   → business logic (erpService)
│       ├── seed/             #   → deterministic demo-data generator
│       └── db/               #   → connection + repository (the ONLY SQL)
│
└── database/                 # DATABASE LAYER  (SQLite)
    └── schema.sql            #   → normalised tables + JSON columns
        (runtime DB lives in /data/chhaperia.db, gitignored)
```

**Separation of concerns**
- **Frontend** never touches storage — it calls the REST API only (`/api/state`, `/api/reset`, …).
- **Backend** owns business logic + seeding; routes stay thin, services hold the rules.
- **Database layer** is the *only* code that knows SQL. The backend talks to it through
  `db/repository.js`, which maps relational tables ⇄ the dataset document the frontend expects.

```
 Browser (frontend)  ──HTTP/JSON──►  Express API (backend)  ──►  repository  ──►  SQLite (database)
```

## ✨ Features

- **Auto-calculation engine** — on-hand, usage (30/90d), pending-in (open POs), pending-out
  (demand), Available-to-Promise (ATP), moving-average valuation, days-of-cover, reorder
  suggestions, ABC analysis and demand forecasting — all derived live from the stock ledger.
- **Real product catalogue** — 21 finished cable-tapes across 4 families with genuine type
  codes (CM 25 G, CP 25 GE…), IEC 60331-2 / BS 6387 CWZ / EN50200 standards, flame ratings & BOMs.
- **12 modules** — Dashboard, Analytics, Stock Items, Stock Ledger, Warehouses, Production
  (auto BOM consumption), Products & BOM, Procurement, Sales, Suppliers, Customers, Reports, Settings.
- **Dynamic UI** — 8 switchable accent colours + dark/light, custom canvas charts, ⌘K command
  palette, live alerts, sortable tables, CSV exports, JSON backup/restore.
- **Persistent** — data is stored in SQLite and survives restarts (no more browser-only storage).

## 🚀 Run

```bash
# 1. install backend deps (also builds the SQLite native module)
cd backend
npm install

# 2. (optional) seed the database explicitly — otherwise it auto-seeds on first request
npm run seed

# 3. start the server (serves API + frontend on one origin)
npm start
#   → http://localhost:4000
```

Open **http://localhost:4000** in your browser.

> The database auto-seeds ~120 days of realistic, balanced demo data on first run.
> Use **Settings → Reset to Demo Data** (or `POST /api/reset`) to regenerate.

## 🔌 API

| Method | Path             | Description                          |
|--------|------------------|--------------------------------------|
| GET    | `/api/health`    | Liveness probe                       |
| GET    | `/api/state`     | Full dataset (auto-seeds if empty)   |
| PUT    | `/api/state`     | Replace the full dataset             |
| PATCH  | `/api/settings`  | Patch UI settings only               |
| POST   | `/api/reset`     | Regenerate the demo dataset          |

## 🛠️ Tech

- **Frontend:** HTML, CSS, vanilla JS (no framework, no build step)
- **Backend:** Node.js + Express
- **Database:** SQLite via `better-sqlite3`

## 🏭 Company

**Chhaperia Cable Material Pvt. Ltd.** · Doddaballapur, Bangalore-561203, Karnataka, India
[www.chhaperiatapes.com](https://www.chhaperiatapes.com)

---

*Built as an internal operations tool. Demo data is illustrative.*
