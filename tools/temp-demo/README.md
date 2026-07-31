# Temporary demo data

A throw-away layer of realistic data laid on top of the live database so the whole
workflow can be shown end to end:

```
store sheet → purchase order → goods receipt → work order
            → production stages → sales order → dispatch → test certificate
```

**It is temporary by design.** One command puts the database back exactly as it was.

## Commands

```bash
node tools/temp-demo load      # build the demo layer
node tools/temp-demo status    # what is loaded right now
node tools/temp-demo verify    # re-check the loaded layer for anything broken
node tools/temp-demo remove    # put the database back exactly
```

Stop the server before `load` or `remove` (`npm start` holds the database open).

## What it loads

| | |
|---|---|
| Main store (WH-PNY) | the five physical stock sheets, ~88 items |
| Purchase orders | 22 — every receipt raised 7–10 days before the goods landed, one still in transit |
| Finished Goods Bay (WH-FG) | 5 665 kg opening stock across 56 of the 102 products |
| Work orders | 10 — 7 finished, 3 running, covering all four route shapes |
| Sales orders | 5 — 4 dispatched (3 205 kg), 1 still open |
| Test certificates | 4, each entered twice: production floor, then lab |

Every stage is performed by the login whose area it belongs to — `office` plans and
sells, `coating1` (Gautam) and `coating2` (Ganesh) run the RM lines, `fiberglass`
weaves, `slitting1`/`slitting2` slit and pack, `lab` issues the certificates.

## The two rules the stock sheets are read by

* **Mica tape** is held in the item master in metres at a known GSM; the sheets count
  kilos. `metres = kg × 1000 ÷ gsm` — the plant's own conversion (a 1000 mm × 1000 m
  batch is 1000 m²), and the same one the receipts already in the database use.
* **Anything the sheets count as rolls, pallets or boxes stays in rolls, pallets and
  boxes.** Nothing is invented. Those lines become their own store items and show as
  stock, but a BOM cannot consume them — a recipe needs metres or kilos.

## Why production materials are bought after the work orders are recorded

The five sheets are a snapshot of what is standing in the stores **today**, so they
list nothing that June's and July's runs already used up. `load` records the runs
first, adds up what they genuinely drew, and then raises purchase orders for exactly
that — from the right supplier, delivered before the first run (ordered 28 May,
received 6 June, first run 15 June).

The order matters. Where a job starts is decided from the store at the moment it is
planned: material there, it starts at slitting; material short, it starts on the
coating line of whoever makes that product. The coating jobs therefore have to be
planned against the sheets alone. Doing it the other way round would send every job
straight to slitting and no coating stage would ever appear.

## How "put it back exactly" works

Everything is written through the ERP's own service layer, so the records are
identical in shape to ones made in the browser. The loader records:

* the id of every row it creates, **as it creates it** (not by comparing before with
  after — work-order numbering restarts, so a fresh `WO-0001` would otherwise look
  like a row that had always been there),
* the previous cost / price / unit of every item it reprices,
* the full contents of every row it moves aside (the development test work orders and
  scratch movements).

`remove` replays that list backwards and deletes the manifest. Rows created by anyone
else in the meantime are untouched, and no feature, table or column is altered at any
point. The round trip has been checked by comparing all 25 tables against a backup
taken before the first load — they match row for row.

A pre-load backup is kept at `data/_pre-demo-backup/baseline.db` as a last resort.
The manifest lives at `data/temp-demo-manifest.json`; **do not delete it by hand**, it
is what `remove` reads.

## Editing the data

Everything is declared in `catalog.js` — stock lines, suppliers, purchase orders,
prices, finished stock, work orders, sales orders, certificates. Routes are *not*
declared: the ERP decides them from the store, exactly as it does for a real job.
To change anything, `remove`, edit, `load` again.
