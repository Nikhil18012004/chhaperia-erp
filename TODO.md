# Chhaperia ERP — pending work

Kept up to date at the end of each working session. Last update: 2026-09-07 (Label Studio types Word's way).

## 1. Waiting on the user — data and decisions

Nothing below can be built without these; they are not software tasks.

| # | Item | Where it goes |
|---|------|---------------|
| A1 | GSTIN of Chhaperia International Company (CIC) — invoices print "GSTIN pending" | Settings → Invoice Companies |
| A2 | PAN of CIC | Settings → Invoice Companies |
| A3 | CIN of CIC (possibly U25209KA2011PTC058313 — confirm) | Settings → Invoice Companies |
| A4 | Confirm which CIN belongs to CCM: U27320KA2008PTC046773 (sample 1) or U25209KA2011PTC058313 (sample 2) | Settings → Invoice Companies |
| A5 | Confirm CCM GSTIN 29AAICC5462H1ZE is still current | Settings → Invoice Companies |
| A6 | Bank details for BOTH companies: bank, A/c name, A/c no, IFSC, branch, UPI, SWIFT | Settings → Invoice Companies |
| A7 | Official invoice terms & conditions wording (built-in defaults are used today) | Settings → Invoice Companies |
| A8 | HSN code and GST % per stock item (most are blank; GST defaults to 18) | Stock Items → Edit |
| B | Five GSM corrections in the BOM sheet (fabric GSM ≥ FG GSM, so production cannot compute): CH-RPST-13, CH-ALPFT-50, CH-NW-B-10, CHN-30 WS, CH-RCT-15 | Products & BOM |
| B2 | GSM for RM-CHSNW-015-50MM (about ₹63 L reads in metres) | Stock Items |
| B3 | Office review of the 9 mass-creating recipes and the 8 GSM conflicts | Products & BOM |
| C1 | Ruling on the 5 historical stock-deducting dispatches (leave, reverse, or re-post) | Stock Ledger |
| C2 | The GitHub repository is PUBLIC and its history holds real BOM, TDS and company identifiers — flip it to private | GitHub settings |
| C3 | AWS hosting is blocked until AWS credentials exist on this laptop; Render env vars (AUTH_SECRET, NODE_ENV) need checking on the next deploy | Hosting |

## 2. Decisions to make

- **Customers → "Gone quiet" tab.** It lists customers whose own ordering rhythm says they are overdue to order (worked out from their history). Read-only, a sales chaser, affects no data. Keep or remove?
- **Design direction.** The 2026-08-14 review left two items that need the direction ruling (Mill / Graphite / Mica) before they can be built: the emoji → line-icon sprite, and the single-accent choice (kill the 8-swatch picker and the per-module accent).
- **CRM Calendar.** Removed by ruling on 2026-08-28, brought back on main by another contributor on 2026-08-31. Confirm whether it stays.

## 3. Software to-dos

- Dashboard: a sanity-flag tile for absurd or negative ledger values (the dashboard renders them deadpan today).
- Lab Reports → Products form: offer "add a parameter of its own" there too. Today a product's own parameters are defined only when the product is created through Stock Items → New Item (or on a material through the QC dialog).
- Work orders: the production line of a released order cannot be changed (every stage's stock is issued at release). Allowing it needs a rollback-of-postings design.
- Lab Reports: the incoming-material tab's Pending / Completed sub-tab resets on the 15-second refresh (the search and the result/series selects are kept).
- Test suite: `chh_smoke_disp` scratch database is left behind by `backend/test/smoke.js`.
- Test suite: `backend/test/http.js` fails 5 checks in the lab / work-order QC section on main ("the floor is given the parameter list" … `UNCAUGHT: … reading 'prodResult'`), and the uncaught error ends the run — every section after it never executes. Verified on untouched `3485ff8`. Until it is fixed, `node backend/test/http-labels.js` is the label round-trip.
- Label Studio: a table object (Word's Insert ▸ Table) is the one thing the plant's Word labels still have that the designer does not; bullets and numbering likewise.
- Label Studio: a saved Hindi label from before 2026-09-07 was silently saved as Arial by the server (the font was missing from the whitelist) — reopen and set the font once; it holds now.

## 4. Recently closed (for reference)

2026-09-07 (later): Label Studio checked at nine screen sizes with headless Chrome (360 to 1600 wide, phone/tablet/laptop, both orientations) — the studio no longer runs under the phone's bottom nav, the ribbon's size block and the way back to the library stay on screen at every width (own row below 1600px), the Font group leads on phones, a phone on its side gets the designer full-screen, the right-click menu and Page setup fit a phone. Supervisors and the lab incharge see the WHOLE store view-only — Stock Items, Stock Ledger, Warehouses — through the money-free `GET /api/store` feed (floor panel pages in mod-supervisor.js; the lab gets the ledger menu entry); neither sees Label Studio. The report preview (every Reports export) has row ticks and a typed row count; print and download carry exactly those rows. Tests: `backend/test/http-store.js`.

2026-09-07: Label Studio edits text Word's way — select letters and format just those (bold, italic, underline, strike, super/subscript, size, font, colour, highlight), the word under the caret, or the next thing typed; Word's keys (Ctrl+B/I/U, Ctrl+]/[, Ctrl+L/E/R/J, Ctrl+=, Ctrl+Shift++, Ctrl+Space, Ctrl+Shift+C/V); Format Painter; the editor's own Ctrl+Z; text copied from Word/Excel pastes as a new field and a field's words copy out; the server keeps the runs and the Hindi font. Tests: `backend/test/label-runs.js`, `http-labels.js`, `ui-text.js`.

2026-09-02 evening (`d61df5f`, `92db72d`): Enter walks the form before it saves; filters survive the refresh; the floor has a bell; QA-3 (RM-only purchase orders server-side), QA-4 (ungradable readings read "Recorded"), QA-5 (copy); imported transfers must be matched pairs; the Stock Ledger is paged; no Google Fonts download; four chart hues; the one-shot New Item form (item + test parameters + recipe); the lab's proposals go to the admin for approval.
