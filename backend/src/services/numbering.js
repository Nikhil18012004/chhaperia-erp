"use strict";
/* ============================================================
   DOCUMENT NUMBERS — one series per kind of document, taken under a lock.

   Every number used to be "the biggest on file plus one", worked out by the
   request that needed it. Two clerks pressing Save at the same moment read
   the same biggest number, minted the same PO-0025 / WO-0031 / QTN-0001, and
   the later save silently overwrote the earlier one — a work order's
   material was even issued twice while only one order remained on file
   (the 11 Sep test's H1). A deleted job's number also came straight back,
   carrying the deleted job's certificate (H3/H4).

   Now a series row in `counters` holds the last number handed out, and a
   taker locks that row first, so two takers queue and each leaves with its
   own number. The floor is whatever the caller can see on file — so an
   imported ledger, a renumbered job or a series that predates the table
   never makes the counter hand out a number that already exists — and a
   number, once given, is never given again.

     const id = await N.nextId("po", state.purchaseorders, "PO-");
     // → "PO-0026", padded like the widest number already on file (min 3)

   `series` names the counter, not the printed prefix: appointments and the
   lab's approval queue both print "AP-", but they are two series.
   ============================================================ */
const repo = require("../db/repository");

const TRAIL = /(\d+)\s*$/;

/* The biggest number and the widest zero-padding among the ids on file
   that carry this prefix. */
function seriesOf(list, prefix) {
  let max = 0, width = 0;
  (list || []).forEach((x) => {
    const id = String((x && x.id) || "");
    if (prefix && !id.startsWith(prefix)) return;
    const m = TRAIL.exec(id);
    if (m) { max = Math.max(max, +m[1]); width = Math.max(width, m[1].length); }
  });
  return { max, width };
}

/* The next id in a series: `prefix` + zero-padded number. `width` is the
   minimum padding (the widest number already on file wins if wider; never
   under 3). Pass the caller's transaction executor `x` when the id is taken
   inside one, so the lock rides with that transaction. */
async function nextId(series, list, prefix, width, x) {
  const s = seriesOf(list, prefix);
  const n = await repo.nextNumber(series, s.max, x);
  return prefix + String(n).padStart(Math.max(width || 0, s.width, 3), "0");
}

module.exports = { nextId, seriesOf };
