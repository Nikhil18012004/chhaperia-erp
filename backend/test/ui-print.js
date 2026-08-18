"use strict";
const { JSDOM, VirtualConsole } = require("jsdom");
const vc = new VirtualConsole();
const errors = [];
vc.on("jsdomError", (e) => { const m = String((e.detail && e.detail.stack) || e.message);
  if (!/getContext|canvas/i.test(m)) errors.push("jsdomError: " + m.split("\n").slice(0, 3).join("\n")); });
vc.on("error", (...a) => errors.push("console.error: " + a.map(String).join(" ")));

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
  const q = (sel) => d.querySelectorAll(sel).length;

  await sleep(3000);
  d.querySelector("#loginUser").value = "admin";
  d.querySelector("#loginPass").value = "admin@123";
  d.querySelector("#loginForm").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(6000);

  const navBtn = [...d.querySelectorAll("[data-view],[data-mod],.nav-item,button,a")]
    .find((el) => /label\s*studio/i.test(el.textContent || ""));
  if (!navBtn) { console.log("NAV NOT FOUND"); process.exit(1); }
  click(navBtn); await sleep(2500);

  const pbtn = d.querySelector(".ls-gal-print");
  if (!pbtn) { console.log("no .ls-gal-print"); process.exit(1); }
  click(pbtn); await sleep(1500);

  console.log("dialog open:", !!d.querySelector(".ls-pp"));
  const modalEl=d.querySelector(".modal");
  console.log("modal is full:", !!(modalEl&&modalEl.className.includes("full")),
    "| inline width:", modalEl?modalEl.getAttribute("style"):"");
  console.log("cards at open (expect 1):", q(".ls-pp-card"));
  const footTexts=[...d.querySelectorAll(".modal .btn,.modal-foot .btn,[class*=modal] .btn")]
    .map(b=>b.textContent.trim()).filter(t=>/Print|Preview|Cancel|Back/.test(t));
  console.log("footer buttons:", JSON.stringify([...new Set(footTexts)]));
  /* layout geometry: is the sticker beside the sheet, and does the strip exist */
  const row=d.querySelector(".ls-pp-prevrow");
  console.log("preview row present:", !!row, "| cols:", d.querySelectorAll(".ls-pp-prevcol").length);
  const ifr=[...d.querySelectorAll(".ls-pp-prevcol iframe")].map(f=>f.getAttribute("style")||"");
  console.log("preview iframes:", ifr.length);
  const frames=[...d.querySelectorAll(".ls-pp-prevcol .wz-frame")].map(f=>{
    const st=f.getAttribute("style")||""; return st.replace(/s+/g,"");});
  console.log("frame boxes:", JSON.stringify(frames));
  const thumbs=[...d.querySelectorAll(".ls-pp-pgc .wz-frame")].map(f=>(f.getAttribute("style")||"").replace(/s+/g,""));
  console.log("thumb box:", JSON.stringify(thumbs.slice(0,1)));
  /* the label name must be shown in full, never clipped */
  const nameEl=d.querySelector(".ls-pp-dn");
  if(nameEl){
    const cs=w.getComputedStyle(nameEl);
    console.log("name text:", JSON.stringify(nameEl.textContent),
      "| white-space:", cs.whiteSpace, "| overflow:", cs.overflow||"(visible)",
      "| text-overflow:", cs.textOverflow||"(clip)");
  }
  const add = d.querySelector(".ls-pp-addlbl");
  console.log("add button:", add ? JSON.stringify(add.textContent.trim()) : "MISSING");
  click(add); await sleep(900);

  const menuRows = [...d.querySelectorAll(".ls-pp-addrow")].map((b) => b.textContent.trim());
  console.log("chooser rows:", JSON.stringify(menuRows));

  const existing = [...d.querySelectorAll(".ls-pp-addrow:not(.new):not(.quiet)")][0];
  if (existing) {
    click(existing); await sleep(900);
    console.log("after adding existing: cards =", q(".ls-pp-card"));
    const rm = d.querySelector(".ls-pp-rmlbl");
    console.log("remove x present on added card:", !!rm);
    if (rm) { click(rm); await sleep(900); }
    console.log("after remove: cards =", q(".ls-pp-card"));
  } else {
    console.log("no existing same-size design offered (chooser had only New)");
  }

  /* now the create-new path, through the chooser */
  const add2 = d.querySelector(".ls-pp-addlbl");
  if (add2) { click(add2); await sleep(700); }
  const newRow = d.querySelector(".ls-pp-addrow.new");
  console.log("New-label row present:", !!newRow);
  if (newRow) { click(newRow); await sleep(1400); }
  console.log("dialog closed:", !d.querySelector(".ls-pp"));
  console.log("designer open:", !!d.querySelector(".ls-canvas"));
  const tabs = [...d.querySelectorAll(".ls-tabn")].map((t) => t.textContent.trim());
  console.log("open doc tabs:", JSON.stringify(tabs));

  console.log("--- errors (" + errors.length + ") ---");
  errors.slice(0, 6).forEach((e) => console.log(e));
  process.exit(0);
})().catch((e) => { console.log("HARNESS FAIL:", e.stack.split("\n").slice(0, 4).join("\n")); process.exit(1); });
