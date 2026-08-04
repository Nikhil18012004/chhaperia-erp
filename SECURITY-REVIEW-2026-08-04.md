# Chhaperia ERP — Security Review

**Scope:** full authentication/authorization model, all HTTP routes, the SQLite data layer, the vanilla-JS frontend, dependencies and deploy config.
**Date:** 2026-08-04 · **Commit:** `b42f46c` (detached HEAD, 5 uncommitted frontend files)

---

## 1. Bottom line

**Yes, you can keep running this for a ~10-person factory — but not as it is configured today.** The architecture is genuinely sound: every SQL statement is parameterised (I tried to break it and could not), passwords use scrypt with per-user salts and constant-time comparison, sessions are re-validated against the database on every single request so disabling an account kills it instantly, and role filtering is a real allowlist rather than a UI hide. Dependencies are two packages deep and current. This is better than most internal ERPs I see.

**The single worst thing is that the seeded default passwords are still live on your real database.** I read `data/chhaperia.db` and re-ran the hashing: seven of the eight seeded accounts still authenticate with `<username>@123` — including **`office`**, which is admin-equivalent for data. Anyone who knows the pattern (it is written in your source, printed to your boot log, and every shop-floor supervisor already types their own `coating1@123` every day) can log in as `office` and read all costing, pricing, customer, supplier and payroll data, and overwrite the entire dataset with one `PUT /api/state`. Only `admin` has been changed. Right behind it: two **stored cross-site-scripting bugs** let a supervisor or an office user plant a snippet of HTML that runs inside an *admin's* browser, which converts any low-privilege login into a full admin takeover. And if you ever deploy the shipped `Dockerfile` (which `DEPLOY.md` recommends as the way to get persistent data), the app boots on a signing secret that is committed to the repo — anyone who has seen the source can forge an admin session without a password.

---

## 2. Findings by severity

### 🔴 CRITICAL

---

#### C1. Hardcoded token-signing secret makes the documented Docker deploy a free admin login

**`backend/src/services/authService.js:21-30`** (also reported under websec and supply-chain — same root cause)

```js
const IS_PROD = process.env.NODE_ENV === "production";              // :21
if (IS_PROD && !process.env.AUTH_SECRET) { throw new Error(...) }   // :22  <- only fires in prod
const SECRET = process.env.AUTH_SECRET ||
  "chhaperia-dev-secret-change-me-in-production-8f2a1c";            // :29-30
```

**What's wrong.** Session tokens are signed with an HMAC key. If `AUTH_SECRET` is unset, the code falls back to a literal string that is in the repo, in every clone, and in every CI log. The safety check that refuses to start without a real secret only runs when `NODE_ENV === "production"`. `render.yaml` sets both variables, so **Render is safe**. The `Dockerfile` sets *neither* (only `CHHAPERIA_DATA_DIR` and `PORT`) — and `DEPLOY.md` Option B points you at exactly that image as the way to get a persistent disk, which is the upgrade path you would take when the free Render plan's disk-wipe becomes annoying.

**The attack, in plain English.** No password, no login, no lockout. Someone who has seen the source builds a fake session token that says "I am U-ADMIN, role admin", signs it with the published string, and sends it as an `Authorization: Bearer` header. I booted the app exactly the way the Dockerfile does and confirmed it live: `GET /api/auth/me` → 200 as admin, `GET /api/auth/users` → 200 with all 8 accounts, `GET /api/state` → 200 with all 26 collections. From there they reset any password, replace your whole dataset, or wipe it. A control token signed with a different key was correctly rejected, so the *only* thing standing between an anonymous stranger and your books is a string in your git repo.

**The fix.** Remove the fallback and make the check unconditional — a missing secret must never resolve to a constant. Replace lines 21-33 with:

```js
const SECRET = process.env.AUTH_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error("AUTH_SECRET must be set to a long random value (openssl rand -hex 32)");
}
```

For local dev convenience, generate an ephemeral one (`crypto.randomBytes(32).toString("hex")`) so restarts invalidate dev tokens instead of making them portable. Separately add `ENV NODE_ENV=production` to the `Dockerfile` and document `-e AUTH_SECRET=$(openssl rand -hex 32)` in DEPLOY.md Option B. **Rotate the secret** on anything that has ever run without `AUTH_SECRET` — every token minted there is forgeable forever.

---

#### C2. Seeded default passwords are still live, nothing ever forces a change, and they come back after every restart

**`backend/src/services/authService.js:189-208`**

```js
for (const du of DEFAULT_USERS) {
  users.createUser({ ...du, pass: hashPassword(du.username + "@123") });  // :204
}
```

**What's wrong.** Three separate problems compose into a standing bypass:

1. **The passwords are the usernames.** Eight accounts are seeded — `admin`, `office`, `lab`, `coating1`, `coating2`, `slitting1`, `slitting2`, `fiberglass` — each with password `<username>@123`. I verified against your **real** `data/chhaperia.db`: `admin` has been changed (tokenVersion 20), but **the other seven still work**, including `office`.
2. **Nothing forces a change.** The comment at `:187` says "Admin must change these", but the `mustChangePassword` flag is never set to `true` anywhere in the codebase — a repo-wide grep finds only the three places that *clear* it — and `server.js:100` actively wipes the flag on every boot. `login()` never consults it. The control described in the comment does not exist.
3. **The credential is printed to your logs** at `server.js:132`: `seeded 8 default accounts (admin/admin@123)`.
4. **They regenerate.** Seeding is skipped only when `countUsers() > 0`. `render.yaml` pins `plan: free`, which has no persistent disk — every cold start (the instance sleeps after ~15 min idle) starts from an empty DB and re-seeds `admin/admin@123`, silently undoing any password change.

**The attack.** One HTTP request: `POST /api/auth/login {"username":"office","password":"office@123"}` → 200 with a valid session cookie. The 5-attempt lockout never fires because the first guess is correct. That session reaches: every customer and supplier record, all costing and pricing, your GSTINs, `PATCH /api/org` (bank details), all HR payroll and payslips, `GET /api/hr/config` (which returns the biometric device key in plaintext), and `PUT /api/state`, which deletes and reinserts 13 tables in one transaction. A coating supervisor whose own view deliberately strips every price and cost field simply types `office`/`office@123` and gets all of it.

**The fix.** Two parts, both needed.

*Immediately (today):* change the passwords on all seven remaining accounts via the Users screen. Use something long and unrelated to the username.

*In code:* stop seeding a usable password. Either seed only `admin` from a required `ADMIN_INITIAL_PASSWORD` env var and refuse to seed without it, or generate `crypto.randomBytes(12).toString("base64url")` per account, print it once, and set `mustChangePassword: true`. Then re-introduce enforcement: have `login()` return the flag and have `requireAuth` (`routes/auth.js:50`) reject every route except `/api/auth/change-password` and `/api/auth/me` while `req.user.mustChangePassword` is true. Delete the `clearPasswordChangeFlags()` call at `server.js:100` and remove the credential from the log line at `server.js:132`. Separately, **move off the diskless free plan** so the database — and any password you set — survives a restart.

---

### 🟠 HIGH

---

#### H1. Stored XSS in every detail modal — `MW.dl()` renders values as raw HTML

**`frontend/js/mod-common.js:152`** (sink), **`frontend/js/mod-lab-reports.js:402-403`** (worst caller)

```js
// mod-common.js:152 — the shared detail-row helper used by every detail modal
h("div",{...}, v instanceof Node ? v : h("span",{html:String(v==null?"—":v)}))
//                                              ^^^^ html: is a raw innerHTML assignment (ui.js:17)
```

**What's wrong.** `dl()` builds every "label / value" row in the app. If the value is a plain string it is written straight into `innerHTML` with no escaping. The Lab Reports detail modal passes four raw free-text fields through it — `assignee`, `testedBy`, `woId`, `remarks` — and the server stores all four verbatim (`labService.js:286-289` does only `String(...).trim()`). There is no Content-Security-Policy anywhere to blunt it (I grepped: zero hits for CSP, helmet, or any sanitizer in the whole repo).

**The attack.** A shop-floor supervisor on the shared `coating1` login opens a coating job's lab-reading sheet and types into the **Remarks** box — a plain textbox the UI already offers at `mod-supervisor.js:514` — something like `<img src=x onerror="...">`. The server stores it byte-for-byte (I confirmed the round-trip live: posted as `lab`, read back identical as `admin`). When an admin later clicks that certificate in Lab Reports, the browser parses the tag and the script runs inside the admin's session. The session cookie is `httpOnly` so it cannot be stolen — but it does not need to be: the script runs same-origin and there is **no CSRF token anywhere in this app**, so it simply calls `POST /api/auth/users` and creates itself a second admin account, or `POST /api/reset` to wipe the dataset, or `PUT /api/lab/products/:id/spec` to rewrite the hidden QC Pass/Fail thresholds — all admin-only endpoints the supervisor could never touch directly.

The `lab` role can do the same through `POST /api/lab/reports`. The same sink is reached by ~15 other call sites: `mod-trade.js:176,178,659` (supplier name, ref/quote, customer), `mod-crm.js:305-317` (lead contact/city/source/owner), `mod-dispatch.js:95-104`, `mod-hr.js:188-193,406-409` (worker details, leave reason), `mod-inventory.js:130-138`, `mod-production.js:902`.

**The fix.** One line closes all of them:

```js
// mod-common.js:152
h("div",{style:"..."}, v instanceof Node ? v : h("span",{ text: String(v==null?"—":v) }))
```

The `v instanceof Node` branch already exists, so the handful of callers that genuinely want markup (`badge()` / `meter()` values at `mod-trade.js:177,191,671`) should pass a node instead: `["Status", UI.h("span",{html:badge(...)})]`. Grep for `MW.dl(` and audit the ~15 call sites once after the change. Then add a CSP in `backend/src/server.js` (`default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'`) so the next missed sink is not immediately session-fatal.

---

#### H2. Stored XSS in the Stock Items table — `hsn`, item `id` and `uom` are not escaped

**`frontend/js/mod-inventory.js:67-70`**

```js
{key:"name",label:"Item",render:r=>`<div class="cell-main">${esc(r.it.name)}</div>`
  +`<div class="cell-sub">${r.it.id}</div>`          // no esc()
  +`<div class="cell-sub">${catName(r.it.cat)}</div>` // no esc()
  +`<div class="cell-sub">HSN ${r.it.hsn||"—"}</div>`,sort:r=>r.it.name},  // no esc()
```

**What's wrong.** The name is escaped; the id, category and HSN code are not. The string returned by a `render` callback goes straight to `td.innerHTML` (`ui.js:198-200`). HSN is a free-text box on the item form (`mod-inventory.js:182`), saved with no validation, and the server does not sanitize it either — `erpService.upsertItem` coerces only the numeric columns.

**The attack.** An `office` user — a role that specifically **cannot** manage users, edit lab specs, reset the dataset or change settings — creates or edits any stock item with the HSN field set to an `<img src=x onerror="...">` payload. I confirmed the round-trip: `POST /api/items` as office → 201, and `GET /api/state` as admin returns the payload verbatim. Then **any admin or lab user who opens Inventory → Stock Items** executes it. This is zero-click for the victim: `draw()` renders every row on section load, and the app polls `/api/state` every 15 seconds and re-renders, so the payload re-arms itself continuously. With no CSP and no CSRF token, that script calls `POST /api/auth/users` and mints the attacker a permanent admin account.

Same missing-`esc()` pattern at `mod-inventory.js:73` (`uom`), `:541` (`itemId`), `:543` (warehouse name), `:545` (`uom`), and `mod-trade.js:224` (supplier name in the Smart Reorder wizard).

**The fix.** Wrap every interpolated value:

```js
+`<div class="cell-sub">${esc(r.it.id)}</div>`
+`<div class="cell-sub">${esc(catName(r.it.cat))}</div>`
+`<div class="cell-sub">HSN ${esc(r.it.hsn||"—")}</div>`
```

…and the same at `:73`, `:541`, `:543`, `:545` and `mod-trade.js:224`. Then sweep every `render:` callback across `frontend/js/mod-*.js` for a `${` that is not inside `esc(`. The durable fix is to stop returning HTML strings from `render` at all — return a Node and let `ui.js:199` `appendChild` it.

---

### 🟡 MEDIUM

---

#### M1. `office` can read and rewrite the hidden lab Pass/Fail thresholds

**`backend/src/routes/api.js:226`**

Your code deliberately makes the QC spec admin-only for writes (`api.js:233`, commented *"Spec is sensitive (hidden from the entry form) — admin only"*) and redacts it for reads (`viewService.js:40-46,57-61`, commented *"the people entering reports must not be able to read it — otherwise a measured value can be tuned until it passes"*). Both controls are defeated by the sibling route one line above, which is open to `admin, office`.

**The attack (verified live).** As `office`: `PUT /api/lab/products/LP-001/spec` → 403 and `GET /api/state` shows `spec: {}` — both controls look intact. Then `PATCH /api/lab/products/LP-001` with an **empty body `{}`** → 200, and the response contains the complete unredacted spec for that product. One no-op PATCH per product dumps every threshold. Worse, `PATCH` with `{"spec":{"tensile":{"min":0,"max":99999}}}` → 200 and the stored spec is replaced — the office user rewrites the yardstick itself, so failing product grades Pass and the coating/finished-stock QC gates change shape. `lab` and `supervisor` correctly get 403; this is specifically an office→admin bypass. Your live DB has 102 lab products, all with populated specs.

**The fix.** Make `spec` an admin-only *field*, not just an admin-only *route*. In `labService.updateProduct`/`createProduct`, take the acting user and force `merged.spec = existing.spec` (`{}` on create) unless `user.role === "admin"`. Independently, redact the response: have the handler at `api.js:223-231` return `viewService.redactSpec(result)` for any caller who is not admin — the same transform `/api/state` already applies.

---

#### M2. The `lab` role can overwrite and forge the production floor's independent QC readings

**`backend/src/services/labService.js:233`**

Your code states the invariant explicitly at `:241-243` — *"A supervisor can never overwrite the lab's reading, and the lab can never overwrite the floor's"* — and enforces it at `:249-251`. But the guard only inspects the `prodValues` key, while two lines earlier the target set is chosen from caller-controlled input: `const target = body.source === "production" || body.source === "lab" ? body.source : (owned || "lab");`.

**The attack (verified live).** As `lab`: `PATCH /api/lab/reports/LR-0001` with `{"prodValues":{"tensile":1}}` → **403**, guard holds. The same request re-spelled as `{"source":"production","values":{...}}` → **200**, and the stored record now shows the floor's readings replaced with junk, `prodResult` flipped Pass → Fail, and still signed `prodBy: "coating1"` — the supervisor's name is left on the forgery. A fresh `POST` with `source:"production"` and a chosen `prodBy` creates a fully fabricated *passing* floor certificate for a batch the floor never measured. These are QC test certificates for fire-survival cable tape that ship with the goods.

**The fix.** Do not let the request body pick the measurement set for a role that owns only one. At `labService.js:233`:

```js
const owned = sourceForUser(user);
const target = owned ? owned
  : (body.source === "production" || body.source === "lab" ? body.source : "lab");
```

so `source` is honoured only for admin/office (the roles `sourceForUser` returns `null` for). Also ignore caller-supplied `prodBy`/`labBy` for lab and supervisor writers — stamp `user.username` on the set they own and carry the other forward from `base`.

---

#### M3. Biometric device key is handed to every supervisor and lab session via `GET /api/state`

**`backend/src/services/viewService.js:304` and `:326`**

The supervisor payload is a carefully hand-built allowlist ("Strips: prices, costs, customers, suppliers, sales, money") — and then it ends with `settings: d.settings || {}`, the entire raw settings document. `stateForLab` does the same. `hrService.setConfig` writes the biometric `deviceKey` into that same document.

**The attack (verified live).** Admin sets a device key through the normal HR settings form. Then with the seeded `coating1` login: `GET /api/hr/config` → **403 as designed**, but `GET /api/state` → `settings.hr.deviceKey == "S3CRET-DEVICE-KEY"`. Identical for the `lab` account. With that key, **no session is needed at all**: `POST /api/hr/punch?key=...` → 201, and the punch immediately recomputes that worker's muster row, which is exactly what payroll pays from. Unrate-limited, un-revocable (it is not tied to any account), and `/punch/batch` loops the array with no length cap.

*Currently latent:* your live database has no `deviceKey` set, and neither `render.yaml` nor the `Dockerfile` sets `CHHAPERIA_DEVICE_KEY`, so today `punchAuth` falls through to requiring an office session. This arms itself the day you wire up the biometric terminal — which is the intended workflow.

**The fix.** Stop shipping the raw settings doc to low-privilege roles. At both `viewService.js:304` and `:326`:

```js
settings: (({theme, accent, autoAccent, lowStockOnly}) =>
  ({theme, accent, autoAccent, lowStockOnly}))(d.settings || {}),
```

Separately, keep the device key out of the UI settings document entirely (own row, or env var only), redact it from `GET /api/hr/config` responses, and compare it with `crypto.timingSafeEqual`. Rotate it if you have ever set one.

---

#### M4. Unauthenticated 25 MB request bodies are buffered and parsed *before* any login check

**`backend/src/server.js:28-30`**

```js
app.use("/api/lab",   express.json({ limit: "25mb" }));
app.use("/api/state", express.json({ limit: "25mb" }));
app.use(              express.json({ limit: "1mb"  }));
```

These are **prefix mounts at the very top of the stack**, so they fire for any method and any path under `/api/lab` — including paths that have no route at all — and the body is fully buffered and `JSON.parse`d (synchronously, on the single Node thread) *before* the request ever reaches a `requireAuth`.

**The attack.** No account, no credentials, just the URL. Six concurrent `POST /api/lab/zzz` requests of 22 MB each: server RSS climbed from 74 MB to 532 MB, all six returned 404 (no credential was ever required), and an unrelated `GET /api/health` went from 14 ms to 166 ms because the loop was blocked. A 5 MB body of *invalid* JSON returned `400 {"error":"Expected double-quoted property name in JSON at position 5242888"}` — proving the parser consumed all 5 MB before auth. `render.yaml` pins `plan: free` (512 MB RAM) with `healthCheckPath: /api/health`, so that is an OOM kill plus a failed health check, repeatable for 132 MB of upload.

The 25 MB allowance is also unjustified: the comment says "Lab test-certificate uploads carry embedded images", but `labService.buildReport` builds a fixed-shape object of scalars and there is no image or attachment field anywhere in the app.

**The fix.** Put authentication in front of the oversized parsers and drop the limits to what the payloads actually need:

```js
const { requireAuth } = require("./routes/auth");
// requireAuth never touches req.body, so it can reject an anonymous
// upload after reading zero bytes of it.
app.use("/api/lab",   requireAuth, express.json({ limit: "2mb" }));
app.use("/api/state", requireAuth, express.json({ limit: "8mb" }));
```

Also add an `/api` catch-all JSON 404 after `app.use("/api", apiRoutes)` so unknown API paths short-circuit instead of falling through to `express.static`.

---

#### M5. `POST /api/hr/punch/batch` — one sub-1 MB request freezes the whole server for minutes

**`backend/src/routes/hr.js:33-39`**

```js
const list = (req.body && req.body.punches) || [];
const out = list.map((p) => { try { return hr.ingestPunch(p); } catch (e) { ... } });
```

No length cap. Each punch does a settings read, a worker lookup, an INSERT, and — when the device id matches a real worker — `recomputeAttendance`, which calls `SELECT * FROM hr_punches WHERE ts LIKE ?`. I ran `EXPLAIN QUERY PLAN` on that statement: it is a **full scan**, so punch *k* re-reads all *k* rows already inserted that day. The loop is **quadratic**, and every step is a synchronous SQLite call on the single Node thread.

**Measured.** 500 / 1000 / 2000 / 4000 same-day punches = 0.4 s / 2.1 s / 10.7 s / 43.5 s — cost doubles as N doubles. A minimal punch is 14 bytes, so ~70,000 fit inside the 1 MB cap: roughly an hour of a totally frozen server (API, frontend, health check, `SIGTERM` shutdown — nothing responds) from one fire-and-forget request. I confirmed live that a health check on a separate connection during a 3,000-punch batch did not merely queue, it failed outright.

**Reachable by:** an admin/office session today, or — once you configure a biometric device key — anyone holding that shared key, which `punchAuth` also accepts as a `?key=` **URL query parameter** (so it lands in proxy, CDN and browser-history logs) and which no route rate-limits.

**The fix.** Three changes, all needed:
1. Cap the batch before the loop: `if (list.length > 500) throw err("Batch too large", 413);`
2. Remove the quadratic term: collect distinct `workerId|date` pairs during the loop and call `recomputeAttendance` **once per pair** afterwards, not once per punch.
3. Wrap the whole ingest in `db.transaction(...)` so N inserts are one fsync.

Additionally, give the date filter a usable index — store a `day` column and query `WHERE day = ?` instead of `ts LIKE ?` — and apply the login rate limiter to `/api/hr/punch*`.

---

#### M6. Login lockout is a remote account-denial-of-service, made worse by unset `trust proxy`

**`backend/src/routes/auth.js:79-82`**

The limiter keys on `req.ip + "|" + username`. But `app.set("trust proxy", ...)` is **never called anywhere** — I grepped, and Express's default is `false`. Behind Render's edge that makes `req.ip` the proxy address, identical for every client on earth, so the key degenerates to `<constant>|<username>`: **the attacker and your employees share one bucket.**

**The attack (verified live).** Five wrong-password requests for `office`, then the real user posting the **correct** password gets `429 Too many failed attempts. Try again in about 15 min.` Changing network or spoofing `X-Forwarded-For` does not help — the header is ignored because trust proxy is off. Once the lock lapses, five more failures re-arm it, so ~5 requests every 15 minutes per account (about 480/day, trivially scriptable) keeps every login locked out indefinitely from a single host with no authentication. Your account list is a fixed 8 names hardcoded in the source, so ~40 requests per cycle locks the whole factory out. The accidental version is more likely: shared shop-floor logins from many machines all land in one bucket, so one operator mistyping `coating1` five times locks that login floor-wide.

*Mitigating:* the failure map is in-process memory, so a restart clears it; already-signed-in users keep working because the sliding session renews them.

**The fix.** Two changes. (1) Add `app.set("trust proxy", 1)` in `backend/src/server.js` before the routers so `req.ip` reflects the real client — set the hop count to your actual proxy depth, **do not use `true`**, which lets a client spoof its own address and evade the limiter entirely. (2) Never reject a request that presents the **correct** password on the strength of someone else's failures: track failures per-IP as the primary key, and for the per-account counter use exponential backoff with a cap rather than a hard 429.

---

#### M7. Attribute-injection in `selectHTML()` — `value="${o.v}"` has no `esc()`

**`frontend/js/mod-inventory.js:768`**

```js
function selectHTML(id,opts,sel){ return `<select class="select" id="${id}">`
  + opts.map(o=>`<option value="${o.v}" ${o.v===sel?"selected":""}>${esc(o.l)}</option>`)...
```

The label is escaped; the **value** is not, and it sits inside a double-quoted attribute with nothing stopping a `"` from closing it. The result goes to `innerHTML` via `field()`. `o.v` is frequently a client-chosen item id (`:328` Add Stock, `:556` Stock Adjustment; also warehouse, transporter and worker ids in `mod-calendar`, `mod-hr`, `mod-trade`, `mod-production`), and `erpService.upsertItem` validates only that `item.id` is truthy — no character check. The newer `searchSelect` helper (`:831-841`) *does* escape its value, so this is a straightforward inconsistency.

**The attack.** An `office` user POSTs an item whose `id` breaks out of the attribute, closes the `<select>` (needed to escape the browser's "in select" parsing mode) and injects an `<img onerror=...>`. I confirmed the server stores it byte-for-byte, and confirmed in real headless Chrome that the payload executes when the markup is inserted. When an admin opens Inventory → Add Stock or Stock Adjustment, the script runs in their session and reaches `POST /api/auth/users`, `POST /api/reset` and the admin-only lab spec route.

**The fix.**
```js
`<option value="${esc(o.v)}"${o.v===sel?" selected":""}>${esc(o.l)}</option>`
```
and `id="${esc(id)}"`. Better still, build selects with `UI.h("option",{value:o.v},o.l)` (as `MW.select` already does at `mod-common.js:108-112`), which sets the attribute through the DOM API and cannot break out. Also add a character-class check on item ids server-side.

---

#### M8. An unbounded leave date range writes millions of attendance rows and permanently kills `/api/state`

**`backend/src/services/hrService.js:208-209, 225-231`**

`applyLeave` validates only that the end date is not before the start date — a string comparison, no maximum span. `decideLeave` then expands the entire range with a bare `while (d <= end)` loop and writes one attendance row per day, synchronously, with no transaction.

**The attack (measured).** `applyLeave({fromDate:"2000-01-01", toDate:"2400-12-31"})` was accepted: 146,463 days. Approving it blocked the server for 55 seconds and inserted 146,463 rows. Afterwards `GET /api/state` returned a **24.8 MB** JSON body (against 522 KB normally) and every client drags that through a full-table read every 15 seconds. Push `toDate` to `9999-12-31` and it is ~2.9 M days: roughly 15+ minutes of frozen server, then a permanently poisoned dataset. **There is no in-app way to undo it** — `deleteLeave` removes the leave record but not the attendance rows, `hr_attendance` is not in the `saveState` wipe list so `PUT /api/state` and `POST /api/reset` do not clear it, and there is no cascade from deleting the worker. Recovery requires direct SQLite surgery.

The realistic trigger is not an attacker — it is a mistyped year in the two-field leave form, which passes both the client check (`mod-hr.js:431`) and the server check.

**The fix.** Bound the span at entry, in `applyLeave`, before persisting:

```js
if (daysBetween(l.fromDate, l.toDate) > 366) throw err("Leave cannot exceed one year", 400);
```

Validate both dates against `/^\d{4}-\d{2}-\d{2}$/` with a sane year window; add a defensive throw inside `eachDate` past ~1000 iterations; wrap the `decideLeave` write loop in `db.transaction(...)`. Separately, `getState()` should stop pulling the entire `hr_attendance` table on every `/api/state` — scope it to the current and previous payroll period, which is all any view renders.

---

#### M9. The live SQLite database is still recoverable from git history

**`.gitignore:8`**

`.gitignore` now excludes `*.db` and `git ls-files` confirms the file is untracked — but it **was** committed (added in `4c044fe`, updated across several commits, untracked in `30c8ac7`). Untracking does not purge history.

**The attack.** From any clone: `git show 3f0f236:data/chhaperia.db > hist.db` extracts the intact 630,784-byte SQLite file. I did this and opened it: 25 tables including every stored password hash, customer/supplier records with contacts, five transporters with GSTINs, eight HR workers with payroll and payslips, and 102 BOMs and 102 lab products (your TDS specs). The repo is private today, so the blast radius is anyone with repo access — but a leaked clone, a future visibility flip, or a departing collaborator exposes the whole historical dataset.

*Two honest qualifiers:* every password hash in the historical blob is a seeded default (`username@123`), which is already in your source, so cracking them reveals nothing new; and the org record in that snapshot carries a placeholder GSTIN, not your real ones (those were added later and live in `erpService.ensureCompanies` at HEAD anyway).

**The fix.** Purge the file from history — `git filter-repo --path data/chhaperia.db --invert-paths` (or BFG) — force-push, and have every collaborator re-clone. Rotate any real (non-default) account password whose hash is in those blobs. The forward-looking `.gitignore` rule is correct but does nothing for commits already pushed.

---

### 🔵 LOW

| # | Issue | File:line | What it means | Fix |
|---|---|---|---|---|
| L1 | **Login timing oracle enumerates valid usernames** | `authService.js:99` | `login()` returns immediately for an unknown/disabled account but pays ~45 ms of scrypt for a real one. Measured: `admin` 34 ms vs `nosuchuser` 1 ms — a 30× gap. The lockout does not help because it is keyed per-username, so each name gets a fresh budget. Low impact today because your eight usernames are hardcoded in the source anyway; it matters the moment you add real staff logins like `firstname.lastname`. | Hash unconditionally against a fixed dummy record: hoist `const DUMMY_HASH = hashPassword(crypto.randomBytes(32).toString("hex"))` and do `verifyPassword(password, (u && u.active) ? u.pass : DUMMY_HASH)` before returning. Add an IP-only rate limit in front of `/api/auth/login`. |
| L2 | **Sessions renew forever — no absolute lifetime** | `authService.js:111-116` | Every request past half the 12 h life re-issues the token with the same session id and a later expiry, so 12 h is an *idle* timeout, not a session lifetime. A stolen token stays alive indefinitely by pinging `/api/auth/me`. The victim's own logout only kills the session id of the device that clicked it. | Add `iat: Date.now()` to `issueToken`, carry it through renewal, and return null in `renewedToken` when `Date.now() - payload.iat > ABSOLUTE_TTL_MS` (7 days, or 24 h for admin/office). *Note:* an admin can already kill any session instantly with the Disable toggle on the Users screen — that is your emergency lever today. |
| L3 | **Admin-set passwords need only 4 characters** | `authService.js:222, :241` | Self-service change requires 8 characters; the two admin paths require 4, and the UI actively advertises "min 4 chars" (`mod-users.js:83,127`). Since nothing ever forces a change, a password an admin picks is the password the account keeps forever. `2024` or `1111` on a supervisor account falls to unattended guessing in ~3 weeks at the throttled rate. | Change both `< 4` to `< 12` and update the two `mod-users.js` placeholders. Better: have `createUserAccount` generate `crypto.randomBytes(12).toString("base64url")`, show it once, and set `mustChangePassword: true`. |
| L4 | **QC gate bypass: supervisors book unmeasured finished goods via `POST /api/production/return`** | `productionService.js:1017-1040` | `produceFinished` enforces "nothing enters a store unmeasured" (`:739`). `returnStock` — same role, same warehouses — has no gate, no link to any prior issue, and accepts finished goods. Verified: `POST /api/production/finished` → 409 "Enter the batch / lot number…", then the same session's `POST /api/production/return` → 201 and on-hand went 555 → 1055. The 500 kg of never-measured tape is then netted into new work orders and sellable. Fully attributed (`type:"RET"`, `by: username`) so it is auditable, not covert. | Apply the same gate: when `item.cat` is `FG` or `WIP`, run `LAB.finishedStockGate(...)` and 409 on failure, exactly as `produceFinished` does at `:739`. Better still, make a return prove it is a return — require a `ref`/`woId` for material actually issued, and cap the quantity at the outstanding issued amount. |
| L5 | **One malformed cookie makes every API call return 500** | `routes/auth.js:29` | The hand-rolled cookie parser runs `decodeURIComponent` on **every** cookie on the request, not just its own, with no try/catch. A stray `%` in any unrelated cookie throws, and the error handler turns it into a 500. Verified: `Cookie: other_app=100%; chh_token=<valid>` → 500 on every authenticated route, including logout, with nothing in the UI explaining why or letting the user clear it. Fires accidentally whenever any co-hosted app writes a `%` into a cookie value. | Wrap the decode: `try { val = decodeURIComponent(raw); } catch { val = raw; }` in `parseCookies`. |
| L6 | **Stored XSS in the supervisor job card** | `mod-supervisor.js:1060`, called at `:380` | The supervisor panel's own `fact()` helper repeats the `MW.dl` mistake, and one caller passes the raw customer name. An office user renames a customer to an HTML payload; the slitting supervisor's job card executes it. Downward (office → supervisor), not an escalation, but it does let office forge stage advances that only supervisors are allowed to make, stamped with the supervisor's username. | `mod-supervisor.js:1060` → `UI.h("span", { text: String(val) })`. |
| L7 | **Session cookie lacks `Secure` on any non-production deploy** | `routes/auth.js:42` | `secure: auth.IS_PROD`, and `IS_PROD` is `NODE_ENV === "production"`. On the Docker path (which sets no `NODE_ENV`) the token travels over plain HTTP. Largely subsumed by C1 — on that same deploy an attacker can forge a token offline without touching the network — and the login response body returns the token in plaintext anyway. | Set `secure: true` unconditionally (or key it off an explicit env flag), and add `ENV NODE_ENV=production` to the Dockerfile. Fixing C1 fixes this. |
| L8 | **No HTTP security headers at all** | `server.js:47` | No `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` or HSTS; helmet is not installed; `X-Powered-By: Express` is advertised. Clickjacking is already blunted by the `sameSite=strict` cookie, and there is no file-upload path to abuse MIME sniffing — but the **missing CSP is what turns H1/H2 from "a bug" into "full admin takeover"**, and `index.html` does pull CSS and fonts from Google's servers with no allowlist. | Add helmet or set headers manually: `Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'` (plus `style-src`/`font-src` for Google Fonts), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, HSTS on HTTPS. Also `app.disable('x-powered-by')`. All 23 scripts are external files and there is only one inline event handler, so `script-src 'self'` is achievable today. |
| L9 | **Device key compared with `===` and stored/rendered in plaintext** | `routes/hr.js:21`, `mod-hr.js:1090` | The shared biometric secret is compared with a plain string equality rather than `crypto.timingSafeEqual`, and is echoed back in plaintext into the HR settings form. **Default state is safe** — with no key configured, `punchAuth` falls through to requiring an office session (verified: unauthenticated punch → 401). The timing half is theoretical; the real issue is the plaintext exposure covered in M3. | Compare with `crypto.timingSafeEqual` over fixed-length buffers; prefer the `CHHAPERIA_DEVICE_KEY` env var over a DB-stored value; make the UI field write-only so it is never re-emitted. |

---

## 3. Prioritised fix list

### Do today — before anything else (≈ 1 hour total)

| # | Action | Effort | Why first |
|---|---|---|---|
| 1 | **Change the seven remaining default passwords** (`office`, `lab`, `coating1`, `coating2`, `slitting1`, `slitting2`, `fiberglass`) via the Users screen. Use long, unrelated passwords. | 15 min | This is live on your real database right now. `office/office@123` gets someone your entire commercial and payroll dataset in one request. Everything else is theoretical by comparison. |
| 2 | **Do not deploy the shipped `Dockerfile`** until C1 is fixed. If any container has ever run from it, treat every token it issued as forged and rotate. | 5 min (decision) | Free unauthenticated admin. |
| 3 | **Move off the Render free plan** (or accept that the DB — and your new passwords — are wiped on every cold start). | 20 min + cost | Otherwise fix #1 undoes itself the next time the instance sleeps. |

### This week (≈ 1 day of coding)

| # | Action | Effort | Covers |
|---|---|---|---|
| 4 | **Fix the XSS sinks.** One-line change at `mod-common.js:152` (`html:` → `text:`), then `esc()` the six interpolations in `mod-inventory.js` (`:68,69,70,73,541,543,545`), `mod-trade.js:224`, `mod-inventory.js:768` (`esc(o.v)`), and `mod-supervisor.js:380`. Then re-check the ~15 `MW.dl(` callers that legitimately want markup and pass them Nodes. | 3-4 h | H1, H2, M7, L6 |
| 5 | **Add a Content-Security-Policy** in `server.js` (plus `nosniff`, `Referrer-Policy`, `X-Frame-Options`, `app.disable('x-powered-by')`). | 1 h | L8 — and it is the safety net for any XSS sink you or I missed |
| 6 | **Kill the hardcoded secret.** Make `AUTH_SECRET` mandatory unconditionally, delete the literal, add `ENV NODE_ENV=production` to the Dockerfile, document the env var in DEPLOY.md. | 1 h | C1, L7 |
| 7 | **Re-introduce forced password change.** Seed with random passwords + `mustChangePassword: true`, have `requireAuth` block everything except change-password while the flag is set, delete the `clearPasswordChangeFlags()` call at `server.js:100`, remove the credential from the boot log. Raise the admin password floor from 4 to 12 (`authService.js:222,241` and the two `mod-users.js` placeholders). | 2-3 h | C2, L3 |

### Next sprint (≈ 1 day)

| # | Action | Effort | Covers |
|---|---|---|---|
| 8 | **Bound the DoS inputs.** Cap `punches.length` at 500 and de-duplicate the attendance recompute; cap the leave span at 366 days and validate the date format; wrap both loops in transactions. | 3 h | M5, M8 |
| 9 | **Move auth in front of the 25 MB parsers** and drop the limits to 2 MB / 8 MB; add an `/api` JSON 404 handler. | 1 h | M4 |
| 10 | **Fix the two authorization bypasses.** Strip `spec` from the product PATCH (and redact it in the response) unless the caller is admin; derive the lab-report target set from the role, not from `body.source`, and stop trusting caller-supplied `prodBy`/`labBy`. | 2-3 h | M1, M2 |
| 11 | **Stop leaking the settings doc.** Allowlist the four UI keys at `viewService.js:304` and `:326`. Do this **before** you configure a biometric device key. | 30 min | M3 |
| 12 | `app.set("trust proxy", 1)` and stop letting a lock reject a correct password. | 1 h | M6 |
| 13 | **Purge the DB from git history** (`git filter-repo`), force-push, everyone re-clones. | 1-2 h incl. coordination | M9 |

### Backlog (cheap, low urgency)

14. Gate `returnStock` behind `finishedStockGate` for FG/WIP (`productionService.js:1017`) — 1 h — **L4**
15. Constant-work login failure path (dummy hash) — 30 min — **L1**
16. Add `iat` + absolute session cap — 1 h — **L2**
17. `try/catch` around the cookie decode — 5 min — **L5**
18. `crypto.timingSafeEqual` for the device key + write-only UI field — 30 min — **L9**
19. `crypto.timingSafeEqual` for the token signature at `authService.js:86`; raise scrypt cost to `{N:131072,r:8,p:1,maxmem:256MB}` and move login hashing to async `crypto.scrypt` — 2 h — hygiene
20. `npm audit fix` to move body-parser 1.20.5 → 1.20.6 so future audits are clean — 5 min

---

## 4. What I checked and found sound

This is the part that should reassure you — a lot of this codebase is genuinely well built, and I verified these by running them, not by reading them.

**No SQL injection anywhere.** I read all 763 lines of `backend/src/db/repository.js` and all 97 of `userRepository.js`, plus every other `getDb()` caller. Every value that reaches SQL goes through a bound parameter — no request value is ever concatenated into a statement. The only two places a template literal touches SQL are `DELETE FROM ${t}` (`repository.js:145`), where `t` iterates a hardcoded array declared two lines above, and `PRAGMA table_info(${t})` (`connection.js:23`), whose only caller passes the literal `"boms"`. I fired `' OR 1=1--`, `"; DROP TABLE users;--` and `%` through usernames, item ids, PO/SO ids, BOM ids, HR periods and dates: every one round-tripped verbatim as data, the `users` table survived, and `findByUsername("admin' --")` returned null. better-sqlite3 also refuses multi-statement SQL, so even a hypothetical identifier injection could not stack a second statement. **Nothing to do here.**

**Password storage is done properly.** `crypto.scryptSync` with a fresh 16-byte random salt per user, 64-byte output, stored as `<salt>:<hash>`. Verification is length-checked then `crypto.timingSafeEqual` — genuinely constant-time. The only critique is cost: Node's defaults (N=16384) are below current OWASP guidance, so if the database file leaked, offline cracking is ~8× cheaper than it should be. Worth raising eventually (backlog #19), not urgent.

**Sessions are validated against the database on every single request.** `userFromToken` re-reads the account fresh and rejects on `!u.active` and on a `tokenVersion` mismatch. I verified it live: a `lab` session returning 200 from `/api/auth/me` returned **401 on the very next call** after an admin flipped `active:false`. The role is also never read from the token — `requireAuth` sets `req.user` to the freshly-loaded DB row — so a demoted user loses access on their next request without needing an explicit revoke. Password changes and admin resets both bump `tokenVersion`, which kills every session for that account. **Your emergency lever works.**

**Prototype pollution does not work.** `hrService.deepMerge` (fed directly by `PATCH /api/hr/config`) is the textbook vulnerable shape — recursive `for...in` with no `__proto__` filter. I executed it rather than assuming: after `deepMerge(HR_DEFAULTS, JSON.parse('{"__proto__":{"polluted":"YES"}}'))`, both `({}).polluted` and `Object.prototype.polluted` are `undefined`. It is safe because the merge always builds a *fresh* object, so the `__proto__` setter only re-points that throwaway object. Worth adding a one-line key filter as insurance (the safety is incidental and a future refactor to an in-place merge would silently break it), but there is no bug today.

**Dependencies are clean.** Exactly two direct dependencies (`express`, `better-sqlite3`), resolving to express 4.22.2 and better-sqlite3 12.11.1 — both current — with every security-relevant transitive on a patched version (cookie 0.7.2, path-to-regexp 0.1.13, send 0.19.2, qs 6.15.2). `npm audit --omit=dev` returns exactly one **low** hit, body-parser GHSA-v422-hmwv-36x6, which is **not reachable here** because it requires a malformed `limit` value and your three parsers pass only hardcoded well-formed strings (`"25mb"`, `"25mb"`, `"1mb"`) — I confirmed the 1 MB cap genuinely enforces with a 413. The one vendored library, `xlsx.full.min.js`, self-identifies as SheetJS **0.20.3**, which post-dates both known SheetJS CVEs. There is also no `new RegExp` anywhere in the backend, so no user-controlled ReDoS surface. **Do not worry about your supply chain.**

**Your data files are not exposed.** Only `frontend/` is served by `express.static`, with directory listing off. The SQLite database and its eight backups live in `data/` at the repo root, outside the served tree. There is no file-upload path anywhere in the backend — no multer, no `writeFileSync` into the served directory — so nothing attacker-controlled can ever become a served file.

**Things that looked bad and are not:**

- **Token signature compared with `!==` instead of `timingSafeEqual`** (`authService.js:86`). Real hygiene defect, no practical attack — it would require resolving nanosecond differences inside V8's string comparison across network jitter 3-6 orders of magnitude larger, and each probe re-computes a full HMAC that dominates the timing anyway. Fix it for tidiness (backlog #19), not out of fear.
- **The `/api/fx` currency endpoint is unauthenticated and fans out to four third-party APIs.** No SSRF is possible — every URL is built from a hardcoded currency list. The 60-second cache and in-flight de-duplication genuinely hold under load (100 concurrent requests → 15 outbound calls; 19,761 serial requests with a warm cache → zero). The one gap: failures are not cached, so if all upstreams are unreachable (an offline factory deployment, or after Yahoo rate-limits you), each request re-launches a 15-way fan-out. Worth a one-line negative-cache in the `catch`, but not a security hole.
- **Verbose JSON parse errors are returned to the client.** True — a malformed body gets back V8's diagnostic message. It only echoes the attacker's own bytes back at them and leaks no paths, stack traces or config, and your server already advertises `X-Powered-By: Express` and returns Express's default HTML 404 for unknown API paths, both of which give away strictly more. Cosmetic.
- **The hidden lab spec thresholds are in git history.** They are also in `frontend/assets/docs/tds-brochure.pdf` — a tracked, **unauthenticated-downloadable** file (I confirmed: `curl` with no cookie → 200, 2.5 MB PDF) whose tables contain the same 80 tolerance pairs. The `redactSpec` control withholds numbers your own server publishes to anyone who asks. Fix M1 anyway (rewriting the spec is the real problem), but do not lose sleep over the reading half.

---

### Two closing notes

**Your ERP has no CSRF protection of any kind** — no token, no double-submit, no Origin/Referer check. Today the `sameSite: "strict"` cookie covers you, which is why this is not a standalone finding. But it is *why* the two XSS bugs escalate straight to admin takeover: injected script runs same-origin, so there is nothing left to stop it calling `POST /api/auth/users`. That is the argument for treating fix #4 and #5 as one job.

**The `office` role is effectively a second admin for data.** It reaches all costing, pricing, customers, suppliers, GSTINs, bank details, payroll and `PUT /api/state` (a 13-table delete-and-reinsert). Several findings above are "office can also do X" — worth remembering that `office` is already very powerful, and worth deciding deliberately who gets that login rather than treating it as a general desk account.

---

## Appendix — coverage gaps flagged by the completeness critic

GAPS (business-logic / data-integrity surface the six dimensions did not cover)

**1. `PUT /api/state` is a full-table-wipe primitive that accepts a two-key payload**
Read `backend/src/services/erpService.js:76-92` with `backend/src/db/repository.js:138-146`.
Validation only requires `items[]` and `movements[]` to be *present*; `repo.saveState` then `DELETE`s 14 tables (movements, work_orders, sales_orders, purchase_orders, boms, items, suppliers, customers, warehouses, categories, leads, org, settings, meta) and reinserts only what was sent. Question: does `PUT /api/state {"items":[{"id":"X","name":"X"}],"movements":[]}` from any office session destroy every PO, SO, WO, customer, supplier, the company GSTIN document and the settings row (incl. `hr.deviceKey`) in one request — with no backup, no confirmation and no audit row? If so, each of the four confirmed stored-XSS findings is a one-request total-data-destruction bug, not just a session-theft bug.

**2. Backup restore takes an untrusted JSON file with a truthiness check, and a stale tab silently clobbers the DB**
Read `frontend/js/mod-reports.js:210-215` and `frontend/js/app.js:297-305`.
`restore()` does `JSON.parse(file)` → `if(!d.items||!d.movements) throw` → `DB.save(d)` (= the wipe above), with no confirm dialog (unlike Reset, which confirms). Question (a): can a hostile "backup" file replace the org identity used on tax invoices and inject arbitrary keys into every `doc` blob? Question (b): `App.persistAndRefresh()` PUTs the *entire* `ENG.data` the tab happens to hold — does toggling the theme in a tab open since morning silently revert every edit other users made since that tab loaded?

**3. `createAdhocProduction` has no area check and no stock check — unlike every neighbouring path**
Read `backend/src/services/productionService.js:1054-1113`, compare with `createWorkOrder`'s `assertMaterialsAvailable` (`:335-352`) and `recordExcessMaterial`'s per-line availability guard (`:940-941`).
It accepts any `supervisor` (role checked, `user.area` never consulted), creates a work order for any FG item and posts negative `ISSUE` movements for its whole BOM with no on-hand test. Question: can `slitting1` post ad-hoc production of a coating product and drive raw-material on-hand arbitrarily negative? Same missing area check on `produceFinished` (`:696-698`) and `returnStock` (`:1017-1019`), and `dispatchSalesOrder` (`erpService.js:279-295`) posts SALE movements with no stock test either — is there a negative-stock invariant *anywhere* in the system?

**4. Punch ingestion accepts an arbitrary timestamp, which is the payroll input**
Read `backend/src/services/hrService.js:145-160` and `recomputeAttendance:129-141`.
`ts` is only checked with `isNaN(new Date(ts))` — any past or future date is accepted, there is no dedupe, and hours are derived as `last − first` with `ot = hours − standardDayHours`. Question: does posting two punches at `T00:01` and `T23:59` for a `deviceUid` yield a ~24 h day with ~16 h OT that flows straight into `computeSlip`, and can it be backdated into a period whose pay run already exists? Note the writer needs only the device key — which the audit already showed leaks to every supervisor and lab session. Also: `recomputeAttendance` writes `source:"device"` over a row an HR clerk manually corrected — is a correction re-writable by a later punch?

**5. The `lab` role receives the entire commercial book**
Read `backend/src/services/viewService.js:321-354` next to the deliberately money-free `stateForSupervisor:83-…`.
`stateForLab()` returns `items` (with `cost`/`price`), `suppliers`, `customers`, `purchaseorders`, `salesorders`, `movements` and `boms` unredacted. Question: is it intended that a QC technician login can read every purchase price, sale price, order value, supplier and customer, when a shop-floor supervisor deliberately cannot? (The confirmed device-key leak is in the same object, but the commercial exposure is separate and larger.)

**6. The QC gate tests completeness, not conformity — and the writer picks the parameter list**
Read `backend/src/services/labService.js:415-434` (`coatingGate`), `:102-105` (`setComplete`), `:224-233` (`flags` / `source` handling).
The gate passes if `prodComplete || labComplete`, and "complete" means only that `num(value) != null`. Question (a): does a supervisor clear the gate by submitting `0` for every parameter, and does a batch graded **Fail** still pass? Question (b): `paramsForProduct` falls back to `applicableParams(body.flags)` when a product has no `specKeys` — can a writer supply `flags:{mica:false,waterBlocking:false,semiConductive:false}` to shrink the required test set on such products? Question (c): `body.prodBy`/`labBy`/`testedBy` are free strings — can the lab role stamp the coating supervisor's name on a reading it took itself?

**7. `DELETE /api/items/:id` orphans movements and then wedges every full-state save**
Read `backend/src/db/repository.js:492-496` (delete items only), `backend/src/services/erpService.js:541-544` (no guard), against the referential check at `erpService.js:87-89`.
Deleting an item that has movements leaves them in place; the next `PUT /api/state` — which is what the theme toggle, backup restore and Excel import all use — then 400s with "Movement references unknown item". Question: does one item deletion permanently break those paths until someone hand-edits the movements table?

**8. Document deletes silently rewrite stock, with no audit trail**
Read `backend/src/db/repository.js:352-359`, `:388-396`, `:508-518`, plus `erpService.updatePurchaseOrder:241-247`.
Deleting a PO/SO/WO runs `DELETE FROM movements WHERE ref=?`, so removing a fully-received PO retroactively unbooks its GRN stock with no record that it existed. And `updatePurchaseOrder` is an `Object.assign` merge with no field allowlist — `lines[].recd`, `qty`, `rate` and `status` are all client-writable. Question: can `recd` be reset to 0 and the same PO received repeatedly, and is there any append-only log anywhere that would show either action after the fact?

Checked and found clean (no follow-up needed): CSV/XLSX import writes only through the fixed `ENTITIES` column registry, so no arbitrary-key or `__proto__` injection from a sheet (`frontend/js/csvio.js:329-408`); `labService.buildReport` returns an explicit allowlisted object with grades computed server-side (no mass assignment into lab reports); movement/stage attribution (`by`, `createdBy`, `doneBy`) is always taken from `user.username`, never from the body; `tools/` contains no credentials or secrets and is CLI-only with no HTTP reachability.