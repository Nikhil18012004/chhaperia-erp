# Sharing data between two installs

Two people, two PCs, one set of ERP data. This describes how to move
that data across without hosting anything.

## The honest limitation, first

**This is a hand-off, not live sync.** Whoever imports last wins, for
the whole dataset. There is no merge.

That is a deliberate choice, not a missing feature. Stock is derived by
replaying the `movements` ledger. If two machines each add movements
offline and something tried to merge them, the result would be a stock
figure that matches neither machine and that nobody can audit. A stale
number you can explain beats an invented one you cannot.

So the rule is: **one person edits at a time.** Finish, export, hand
over. The other imports, then edits.

If you ever want both people editing at once, that needs one shared
database — which means hosting. Nothing here prevents that later; the
backend already accepts `CHHAPERIA_DB_URL`.

## Sending your data to the other machine

```
node tools/erp-export.js
```

Writes `data/exchange/` — one `.jsonl` file per table plus
`_manifest.json`. About 700 rows today; it is small enough to email.

Copy that whole folder across. Any route works: a shared Google Drive
or OneDrive folder, WhatsApp, a USB stick.

> A shared cloud folder is the least effort. Point the export straight
> into it — `node tools/erp-export.js --out "C:\Users\you\Google Drive\chhaperia-exchange"` —
> and the other machine imports with `--from` pointing at its own copy
> of the same synced folder. It is still a hand-off, still one editor
> at a time, but nobody has to remember to attach a file.

## Receiving the other machine's data

```
node tools/erp-import.js --dry     # see what would change
node tools/erp-import.js --yes     # actually do it
```

`--dry` prints every table as `here -> incoming` and marks the ones
whose row count moves. Read it before committing to the change.

The import **replaces** the tables in the export. Rows the other
machine deleted disappear here too — that is the point, and it is why
it cannot be a merge.

### Undo

Before writing anything, the import exports what is currently here into
`backups/erp-before-import-<timestamp>/`, in the very same format. So
undoing an import is just importing the backup:

```
node tools/erp-import.js --from "backups/erp-before-import-2026-08-18T11-39-33-453Z" --yes
```

## What travels, and what does not

Everything in the item master, BOMs, the movement ledger, work orders,
sales and purchase orders, suppliers, customers, transporters, leads,
appointments, HR (workers, punches, attendance, leave, payruns,
payslips), the lab (products and reports), GRNs and their tests, the
organisation record, and `settings` — which is where Label Studio keeps
your saved label designs.

Two tables are held back on purpose:

- **`users`** — password hashes. Each install keeps its own logins.
  Sharing the table would hand over everyone's account as well, and an
  import would lock you out of your own machine using the other
  person's passwords.
- **`meta`** — `seededAt` and schema version. Bookkeeping about *this*
  install; meaningless somewhere else.

## Do not commit the exchange folder

`data/exchange/` is in `.gitignore`, and it must stay there.

This repository is **public**. Those files are the real business data:
costs, prices, customer and supplier names, staff pay. Git keeps
deleted content in its history forever, so a single accidental commit
publishes it permanently — deleting the file afterwards does not take
it back.

This is the same reasoning that untracked the live database in
`30c8ac7`, and it is why the committed catalogue CSVs carry products
but no pricing or people.

If you would rather the data *did* ride along in git — which would make
the hand-off a `git pull` — make the repository private first. Until
then, carry the folder across by hand.

## Why row-for-row and not `GET /api/state`

There is an export endpoint, and it looks like an easier route. It is
not a faithful one: `getState()` builds a convenience document for the
UI, and it does not carry `hr_punches` at all. A copy taken table by
table cannot lose a column nobody remembered to map.

The same reasoning is written up at greater length in
`tools/migrate-sqlite-to-mysql.js`, which had to make the identical
choice.

## Verifying it worked

The import re-counts every table afterwards and says so. Beyond that,
an export is deterministic — rows ordered by primary key, object keys
sorted — so the same data always produces byte-identical files. That
gives you a check anyone can run:

```
node tools/erp-export.js --out data/exchange-verify
diff -r data/exchange data/exchange-verify      # silence means identical
```

Both machines exporting to identical bytes means both machines hold
identical data.
