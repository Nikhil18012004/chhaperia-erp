/* ============================================================
   CHHAPERIA ERP — the signature picker follows the billing company
   (jsdom, live server)

   Drives the real New Sales Order, New Purchase Order and New Quotation
   forms against the server on :4000. Two billing companies each have a
   remembered signature; the picker must show the FIRST company's when
   the form opens, switch to the OTHER company's when the desk picks it,
   and stop following once a picture was chosen or removed by hand.
   Nothing is saved to the server except the two signatures in settings.

     node backend/test/ui-sig.js       (the ERP must be running on :4000)
   ============================================================ */
"use strict";
const { JSDOM, VirtualConsole } = require("jsdom");
const vc = new VirtualConsole();
const errors = [];
vc.on("jsdomError", (e) => { const m = String((e.detail && e.detail.stack) || e.message);
  if (!/getContext|canvas/i.test(m)) errors.push("jsdomError: " + m.split("\n").slice(0, 3).join("\n")); });
vc.on("error", (...a) => errors.push("console.error: " + a.map(String).join(" ")));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  — " + extra : "")); }
}
function section(t) { console.log("\n" + t); }

const SIG_A = "data:image/png;base64,iVBORw0KGgo=";
const SIG_B = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

(async () => {
  const dom = await JSDOM.fromURL("http://localhost:4000/", {
    resources: "usable", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      const jar = {};
      window.fetch = async (url, opts) => {
        opts = opts || {}; opts.headers = Object.assign({}, opts.headers);
        const ck = Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
        if (ck) opts.headers["Cookie"] = ck;
        const res = await fetch(new URL(url, "http://localhost:4000/").href, opts);
        for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
          const m = c.match(/^([^=]+)=([^;]*)/); if (m) jar[m[1]] = m[2];
        }
        return res;
      };
      window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      window.scrollTo = () => {};
      window.ResizeObserver = window.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
      window.addEventListener("error", (e) => errors.push("window.onerror: " +
        ((e.error && e.error.stack) || e.message).split("\n").slice(0, 4).join("\n")));
      window.addEventListener("unhandledrejection", (e) => errors.push("unhandledrejection: " +
        String((e.reason && e.reason.stack) || e.reason).split("\n").slice(0, 4).join("\n")));
    },
  });
  const w = dom.window, d = w.document;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  const pick = (sel, v) => { const el = d.querySelector(sel); el.value = v; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const val = (sel) => { const el = d.querySelector(sel); return el ? el.value : undefined; };
  const preview = (id) => { const im = d.querySelector(`.sig-pick[data-sig="${id}"] .sig-prev img`); return im ? im.getAttribute("src") : undefined; };
  const buttonByText = (re) => [...d.querySelectorAll("button")].find((b) => re.test(b.textContent || ""));
  const cancel = async () => { const b = buttonByText(/^\s*Cancel\s*$/); if (b) click(b); await sleep(300); };

  await sleep(3000);
  d.querySelector("#loginUser").value = "admin";
  d.querySelector("#loginPass").value = "admin@123";
  d.querySelector("#loginForm").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(6000);
  if (!w.App || !w.ENG || !w.ENG.data || !w.DB) { console.log("HARNESS FAIL: ERP not loaded"); process.exit(1); }

  const cos = ((w.ENG.data.org || {}).companies || []).map((c) => c.key);
  if (cos.length < 2) { console.log("HARNESS FAIL: fewer than two billing companies on file: " + JSON.stringify(cos)); process.exit(1); }
  const [CO1, CO2] = cos;
  const sigs = {}; sigs[CO1] = SIG_A; sigs[CO2] = SIG_B;
  await w.DB.saveSettings({ signatures: sigs });
  await w.App.reloadState();
  await sleep(500);
  ok("two companies each have a remembered signature", ((w.ENG.data.settings || {}).signatures || {})[CO2] === SIG_B);

  const runForm = async (label, open, sig, co) => {
    section(label);
    await open(); await sleep(900);
    const box = d.querySelector(`.sig-pick[data-sig="${sig.slice(1)}"]`);
    if (!box) { ok("the signature picker is on the form", false, "no .sig-pick for " + sig); return; }
    ok("the form opens with the first company's signature", val(sig) === SIG_A, val(sig));
    ok("…and shows it", preview(sig.slice(1)) === SIG_A, preview(sig.slice(1)));
    pick(co, CO2); await sleep(150);
    ok("picking the other company switches to ITS signature", val(sig) === SIG_B, val(sig));
    ok("…and the preview follows", preview(sig.slice(1)) === SIG_B, preview(sig.slice(1)));
    pick(co, CO1); await sleep(150);
    ok("switching back brings the first company's signature back", val(sig) === SIG_A, val(sig));
    const rm = box.querySelector("[data-sig-remove]");
    ok("a Remove button is offered while a picture is shown", !!rm && !rm.hidden);
    click(rm); await sleep(150);
    ok("Remove clears the picture", val(sig) === "", val(sig));
    pick(co, CO2); await sleep(150);
    ok("once removed by hand, a company change no longer fills it in", val(sig) === "", val(sig));
    await cancel();
  };

  await runForm("New Sales Order",
    async () => { w.App.go("sales"); await sleep(1200); click(buttonByText(/New Sales Order/)); }, "#so_sig", "#so_co");
  await runForm("New Purchase Order",
    async () => { w.App.go("purchase"); await sleep(1200); click(buttonByText(/New PO/)); }, "#po_sig", "#po_co");
  await runForm("New Quotation (the sales-order layout)",
    async () => { w._erpUtil.quoteFormTally(null, {}); }, "#q_sig", "#q_co");

  console.log("\n--- errors (" + errors.length + ") ---");
  errors.slice(0, 6).forEach((e) => console.log(e));
  console.log("\n" + (fail ? "FAIL" : "PASS") + " — " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("HARNESS FAIL:", e.stack.split("\n").slice(0, 4).join("\n")); process.exit(1); });
