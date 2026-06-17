# Chhaperia ERP — Cable-Tape Manufacturing Suite

A modern, offline-capable ERP web application built for **Chhaperia Cable Material Pvt. Ltd.** (Chhaperia Group) — India's largest manufacturer of mica & cable insulation tapes, established 1959, Doddaballapur, Bangalore.

> Manufacturer of Mica Tapes, Water-Blocking Tapes, Semi-Conducting Tapes and Other Cable Tapes for fire-survival, HT/EHV power, instrumentation and optical cables.

---

## ✨ Highlights

- **Zero build step.** Pure HTML + CSS + vanilla JS. Open `index.html` (or serve the folder) and it runs.
- **Auto-calculation engine.** On-hand, usage (30/90d), pending-in (open POs), pending-out (demand), Available-to-Promise (ATP), moving-average valuation, days-of-cover, reorder suggestions, ABC analysis and demand forecasting — all **derived live from a single movement ledger**, never hand-keyed.
- **Real product catalogue.** 21 finished cable-tapes across 4 families with genuine type codes (CM 25 G, CP 25 GE…), IEC 60331-2 / BS 6387 CWZ / EN50200 standards, flame ratings and full bills of material.
- **Dynamic, interactive UI.** 8 switchable accent colours + dark/light themes (all derived from the brand orange), custom canvas charts that recolour with the theme, ⌘K command palette, live alerts drawer, sortable/filterable tables, toasts and modals.
- **Local-first.** All data persists to `localStorage`; backup/restore to JSON and reset-to-demo built in.

## 🧩 Modules

| Area | Modules |
|------|---------|
| **Overview** | Dashboard, Analytics (trends, ABC, forecasting) |
| **Inventory** | Stock Items, Stock Ledger (auto running balance), Warehouses |
| **Operations** | Production (work orders auto-consume BOM raws → post finished goods), Products & BOM (cost roll-up + margins) |
| **Trade** | Procurement (smart reorder wizard + GRN posting), Sales (ATP-checked dispatch), Suppliers, Customers |
| **System** | Reports (8 CSV exports), Settings (company profile, theming, data management) |

## 🚀 Run it

```bash
# any static file server works, e.g.
python -m http.server 8848
# then open http://127.0.0.1:8848
```

Or just double-click `index.html`.

> First run seeds ~120 days of realistic, balanced demo data (POs, work orders, sales). Use **Settings → Reset to Demo Data** to regenerate.

## 📁 Structure

```
chhaperia-erp/
├── index.html              # app shell
├── assets/                 # logo, favicons (from company logo)
├── css/
│   ├── theme.css           # design tokens, dynamic accents, dark/light
│   └── app.css             # layout & components
└── js/
    ├── data.js             # seed data + balanced inventory simulation
    ├── engine.js           # calculation engine (stock/usage/pending/ATP/ABC/forecast)
    ├── charts.js           # canvas charts (line/bar/donut/spark/gauge)
    ├── ui.js               # DOM toolkit, tables, modals, nav manifest
    ├── mod-common.js       # shared widgets
    ├── mod-overview.js     # Dashboard + Analytics
    ├── mod-inventory.js    # Stock Items, Ledger, Warehouses
    ├── mod-production.js   # Production + Products/BOM
    ├── mod-trade.js        # Procurement, Sales, Suppliers, Customers
    ├── mod-reports.js      # Reports + Settings
    └── app.js              # router, theme, command palette, alerts
```

## 🏭 Company

**Chhaperia Cable Material Pvt. Ltd.** · Doddaballapur, Bangalore-561203, Karnataka, India
[www.chhaperiatapes.com](https://www.chhaperiatapes.com)

---

*Built as an internal operations tool. Demo data is illustrative.*
