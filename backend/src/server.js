/* ============================================================
   CHHAPERIA ERP — BACKEND · server entry
   Express app that:
     • exposes the /api REST surface (backend layer)
     • serves the static frontend/ (presentation layer)
   The database layer lives behind the service + repository.
   ============================================================ */
"use strict";
/* FIRST — the project's own .env, before any module reads process.env
   (authService decides its secret at require time, and the database layer
   its credentials). Configuration for this project lives in this project. */
require("./env");
const path = require("path");
const fs = require("fs");
const express = require("express");
const compression = require("compression");
const apiRoutes = require("./routes/api");
const hrRoutes = require("./routes/hr");
const { router: authRoutes, getToken } = require("./routes/auth");
const authService = require("./services/authService");
const erpService = require("./services/erpService");
const hrService = require("./services/hrService");
const labService = require("./services/labService");
const grnTestService = require("./services/grnTestService");
const { closeDb, init: initDb, readConfig } = require("./db/connection");

const PORT = process.env.PORT || 4000;
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend");

const app = express();
/* EVERYTHING that leaves this server is gzipped, and it has to be first in the
   chain to catch both the API and the static frontend.
   The plant does not browse this from the machine it runs on — it comes in over
   the factory LAN, and until this was added every byte went out raw: 2.4 MB of
   JavaScript on a cold load, and 0.55 MB of `GET /state` EVERY time a screen
   reloads its data (raising a work order does exactly that). Measured locally
   the same fetch is 227 ms; over a slow wireless link the operators were
   watching it for the best part of ten seconds after every click. JSON of this
   shape compresses to roughly a tenth of its size.
   The default threshold (1 KB) leaves small replies alone, where the CPU spent
   compressing would cost more than the bytes saved. */
app.use(compression());
// Lab test-certificate uploads carry embedded images and keep the old 25 MB
// allowance; everything else gets a tight 1 MB body cap (the JSON payloads
// are small — a huge body anywhere else is an attack, not a feature).
/* …and the generous limits are for AUTHENTICATED work only. These mounts run
   before requireAuth, so without this gate an anonymous caller could make the
   server buffer and JSON.parse 25 MB per request purely to be thrown out
   afterwards. No credential at all -> fall through to the 1 MB parser and let
   requireAuth answer 401. The credential test is auth's OWN getToken, so the
   two can never drift apart; it only checks that one was PRESENTED, never that
   it is valid — that stays requireAuth's job. */
const bigBody = (limit) => {
  const parse = express.json({ limit });
  return (req, res, next) => (getToken(req) ? parse(req, res, next) : next());
};
app.use("/api/lab", bigBody("25mb"));
app.use("/api/state", bigBody("25mb"));   // full-dataset restore
// a .btw label template arrives base64-encoded, so 8 MB of file is ~11 MB of body
app.use("/api/bartender/template", bigBody("14mb"));
/* Label Studio designs live in the settings document and can carry a placed
   picture per object as a data URL, so the settings patch needs more than the
   1 MB the rest of the API gets. The per-picture and per-document caps are
   enforced in erpService — this only decides what the parser will accept. */
app.use("/api/settings", bigBody("12mb"));
// the TDS booklet arrives base64-encoded (a 40 MB cap on the file itself)
app.use("/api/tds", bigBody("60mb"));
app.use(express.json({ limit: "1mb" }));

// Auth (login, me, user management)
app.use("/api/auth", authRoutes);
// Exchange rates, sourced from Google only (no business data — public).
// ?add=THB,SEK warms extra currencies the converter needs beyond the listed set.
app.get("/api/fx", (req, res, next) => {
  const add = String(req.query.add || "")
    .toUpperCase()
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Z]{3}$/.test(s))
    .slice(0, 8);
  require("./services/fxService").getRates(add)
    .then((payload) => { res.set("Cache-Control", "no-store"); res.json(payload); })
    .catch(next);
});
// One direct pair as Google quotes it (converter, for non-INR pairs)
app.get("/api/fx/pair", (req, res, next) => {
  const ok = (s) => /^[A-Z]{3}$/.test(s);
  const from = String(req.query.from || "").toUpperCase();
  const to = String(req.query.to || "").toUpperCase();
  if (!ok(from) || !ok(to)) return res.status(400).json({ error: "from/to must be 3-letter codes" });
  require("./services/fxService").getPair(from, to)
    .then((payload) => { res.set("Cache-Control", "no-store"); res.json(payload); })
    .catch(next);
});
// Human Resources (workers, attendance, leave, payroll + device punch ingest)
app.use("/api/hr", hrRoutes);
// API (protected, role-scoped)
app.use("/api", apiRoutes);

// Never cache the HTML shell, so bumped script ?v= URLs always take effect
// (browsers were reusing a stale index.html that still pointed at old JS).
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.set("Cache-Control", "no-store, must-revalidate");
  }
  next();
});

// Serve index.html with AUTOMATIC cache-busting: rewrite every
// js/*.js?v= and css/*.css?v= to the referenced file's mtime, so any
// edit is picked up on reload with no manual ?v= bump and no restart.
function serveIndex(req, res) {
  let html;
  try { html = fs.readFileSync(path.join(FRONTEND_DIR, "index.html"), "utf8"); }
  catch (e) { return res.status(500).send("index.html not found"); }
  html = html.replace(/(src|href)="((?:js|css)\/[^"?]+)(?:\?v=[^"]*)?"/g, (m, attr, rel) => {
    let v = "0";
    try { v = String(Math.floor(fs.statSync(path.join(FRONTEND_DIR, rel)).mtimeMs)); } catch {}
    return `${attr}="${rel}?v=${v}"`;
  });
  res.set("Cache-Control", "no-store, must-revalidate");
  res.type("html").send(html);
}
app.get(["/", "/index.html"], serveIndex);

// Static frontend (index disabled — the route above owns the HTML shell)
app.use(express.static(FRONTEND_DIR, { index: false }));

// Central error handler. Log full stacks server-side; never leak an internal
// 500 message (e.g. a raw SQLite error) to the client — only intended 4xx
// messages are returned.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error("[api error]", err.stack || err.message);
  else console.warn("[api]", status, req.method, req.path, "—", err.message);
  const out = { error: status >= 500 ? "Internal server error" : (err.message || "Error") };
  /* A material shortage is a 409 the FORM has to act on — it shows what is
     short and offers to raise the order with a pending balance — so that
     detail travels with the message rather than being flattened away. */
  if (status < 500 && err.shortage) {
    out.shortage = err.shortage;
    if (err.canMake != null) out.canMake = err.canMake;
    if (err.pendingQty != null) out.pendingQty = err.pendingQty;
  }
  /* Coating refusing to close until it says where the coated roll was put
     down is the same shape of answer: the form should open the store picker,
     not merely print the sentence. */
  if (status < 500 && err.needsWipWh) out.needsWipWh = true;
  res.status(status).json(out);
});

/* ⚠ THE DATABASE IS OPENED BEFORE ANYTHING IS SEEDED OR SERVED.
   SQLite would create its file on demand, so a broken configuration simply
   never came up. A server can be unreachable, refuse the password, or be
   missing the schema, and each of those used to surface as the first request
   of the day failing in front of somebody. init() connects, applies the
   schema and runs the migrations; if it throws, the process stops here with
   the reason printed, which is the only honest thing to do. */
async function boot() {
  await initDb();

  // ensure default accounts exist on first run
  let seedInfo = { seeded: false };
  try { seedInfo = await authService.seedDefaultUsers(); } catch (e) { console.error("[user seed]", e.message); }

  // Accounts are no longer flagged for a forced password change. Clear any
  // flag left behind by an earlier build so nobody is prompted again.
  try { const fp = await authService.clearPasswordChangeFlags(); if (fp.cleared) console.log("  ├─ Security : cleared " + fp.cleared + " leftover forced-password-change flag(s)"); }
  catch (e) { console.error("[pw flag]", e.message); }

  // ensure the multi-stage routing model is applied to existing data (idempotent)
  try { const m = await erpService.ensureStageModel(); if (m.changed) console.log("  ├─ Stages   : migrated data to multi-stage routing"); }
  catch (e) { console.error("[stage migration]", e.message); }

  // restore the CRM pipeline if this DB was seeded before the CRM module existed
  try { const c = await erpService.ensureCrm(); if (c.changed) console.log("  ├─ CRM      : restored " + c.count + " sales leads"); }
  catch (e) { console.error("[crm restore]", e.message); }

  // seed demo HR data (workers + leave types + recent attendance) on first run
  try {
    const hr = await hrService.ensureHr();
    if (hr.changed) console.log("  ├─ HR       : seeded " + hr.workers + " workers + attendance");
    if (hr.moved) console.log("  ├─ HR       : moved " + hr.moved + " daily-wage worker(s) to monthly pay");
    if (hr.leaveMoved) console.log("  ├─ HR       : leave types are now Paid / Unpaid (" + hr.leaveMoved + " old type(s)/record(s) moved)");
  } catch (e) { console.error("[hr seed]", e.message); }

  // seed demo transport agencies (dispatch directory) on first run
  try { const dp = await erpService.ensureDispatch(); if (dp.changed) console.log("  ├─ Dispatch : seeded " + dp.count + " transport agencies"); }
  catch (e) { console.error("[dispatch seed]", e.message); }

  // seed the two invoice billing entities (Cable Material / International) on first run
  try { const co = await erpService.ensureCompanies(); if (co.changed) console.log("  ├─ Invoice  : seeded " + co.count + " billing companies"); }
  catch (e) { console.error("[company seed]", e.message); }

  // seed the lab-reports product master (finished-goods list) on first run
  try { const lp = await labService.ensureLab(); if (lp.changed) console.log("  ├─ Lab      : seeded " + lp.products + " lab products"); }
  catch (e) { console.error("[lab seed]", e.message); }

  /* Give every purchasable material a real incoming-test parameter list, worked
     out from what the material is (grnTestService.classify). Non-destructive —
     a material somebody has already configured is skipped — so it can run on
     every boot and simply covers anything newly added. */
  try { const qc = await grnTestService.ensureItemQc(); if (qc.changed) console.log("  ├─ Incoming : QC parameters set on " + qc.changed + " of " + qc.items + " materials"); }
  catch (e) { console.error("[incoming qc seed]", e.message); }
  /* a complete reading with no limit to grade it by reads "Recorded", not
     "Pending" — bring the reports filed before that rule into line */
  try { const n = await grnTestService.regradeUngraded(); if (n) console.log("  ├─ Incoming : " + n + " ungradable test report" + (n === 1 ? "" : "s") + " now read Recorded"); }
  catch (e) { console.error("[incoming qc regrade]", e.message); }

  console.log(`\n  Chhaperia ERP`);
  console.log(`  ├─ API      : http://localhost:${PORT}/api`);
  console.log(`  ├─ Frontend : http://localhost:${PORT}/`);
  const cfg = readConfig();
  console.log(`  ├─ Database : MySQL ${cfg.host}:${cfg.port}/${cfg.database}` +
    (cfg.ssl ? " (TLS)" : ""));
  if (seedInfo.seeded) {
    console.log(`  └─ Users    : seeded ${seedInfo.count} default accounts (admin/admin@123)\n`);
  } else {
    console.log(`  └─ Users    : ${seedInfo.count || "existing"} accounts\n`);
  }
  return true;
}

const server = app.listen(PORT);

/* Exported so the tests can wait for the schema, the migrations and the seed
   to be in place before they ask the API for anything. A failure here is
   fatal: there is no useful half-running state for an ERP that cannot reach
   its database, and pretending otherwise only moves the error to the first
   person who tries to use it. */
const ready = boot().catch((e) => {
  console.error("\n  Chhaperia ERP could not start:\n  " + (e && e.message) + "\n");
  process.exit(1);
});

// Graceful shutdown: stop accepting connections, close the DB handle, exit.
function shutdown(sig) {
  console.log(`\n[${sig}] shutting down…`);
  server.close(async () => { try { await closeDb(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref(); // hard-stop if close hangs
}
["SIGINT", "SIGTERM"].forEach((s) => process.on(s, () => shutdown(s)));
// Last-resort safety nets so one bad request can't silently take the server down.
process.on("unhandledRejection", (r) => console.error("[unhandledRejection]", r));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e.stack || e));

module.exports = { app, server, ready };
