/* ============================================================
   CHHAPERIA ERP — Label Studio, typing Word's way (jsdom, live server)

   Drives the real studio on the real page against the server on
   :4000: opens a label, edits a text field in place, picks out
   letters and formats them from the ribbon and the keyboard, and
   checks that what lands on the canvas is what the printer will
   get. Nothing is saved to the server.

     node backend/test/ui-text.js       (the ERP must be running on :4000)
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
  const mouse = (el, type, x, y, extra) => el.dispatchEvent(new w.MouseEvent(type, Object.assign(
    { bubbles: true, cancelable: true, clientX: x || 0, clientY: y || 0 }, extra || {})));
  const key = (el, k, extra) => el.dispatchEvent(new w.KeyboardEvent("keydown", Object.assign(
    { key: k, bubbles: true, cancelable: true }, extra || {})));
  const ctrl = (el, k, extra) => key(el, k, Object.assign({ ctrlKey: true }, extra || {}));

  await sleep(3000);
  d.querySelector("#loginUser").value = "admin";
  d.querySelector("#loginPass").value = "admin@123";
  d.querySelector("#loginForm").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(6000);
  if (!w.LabelStudio || !w.ENG || !w.ENG.data) { console.log("HARNESS FAIL: studio or ERP data not loaded"); process.exit(1); }

  /* ---- a label of our own, mounted on a host of our own: nothing here is
     saved, so nothing here touches the plant's templates ---- */
  const text = (id, y, t) => ({ id, type: "text", x: 5, y, w: 80, h: 10, text: t,
    src: { kind: "fixed" }, font: "arial", size: 4 });
  w.ENG.data.settings = Object.assign({}, w.ENG.data.settings, { labelDocs: [
    { id: "d_uitxt", name: "Typing test", w: 100, h: 60, objects: [
      text("o_a", 5, "PVC Tape 18 mm"), text("o_b", 20, "Second line") ] } ] });
  const host = d.createElement("div");
  d.body.appendChild(host);
  w.LabelStudio.mount(host, {});
  await sleep(200);
  const card = host.querySelector(".ls-gal-card");
  ok("the gallery shows the label", !!card);
  click(card); await sleep(300);
  ok("the designer opens on it", !!host.querySelector(".ls-canvas") && host.querySelectorAll(".ls-hit").length === 2,
    host.querySelectorAll(".ls-hit").length);

  const hit = (id) => host.querySelector('.ls-hit[data-oid="' + id + '"]');
  const layer = (id) => { const n = host.querySelector('.ls-layer [data-i="' + id + '"]'); return n ? n.outerHTML : ""; };
  const ed = () => host.querySelector(".ls-edit.ls-rich");
  const spans = () => [...ed().querySelectorAll("span")].map((s) => ({ t: s.textContent, s: s.getAttribute("style") || "" }));
  const select = (a, b) => {
    /* offsets into the editor's text, walked over its spans */
    let pos = 0, A = null, B = null;
    for (const sp of ed().querySelectorAll("span")) {
      const tn = sp.firstChild; if (!tn) continue;
      const n = tn.nodeValue.length;
      if (!A && a <= pos + n) A = { node: tn, off: a - pos };
      if (!B && b <= pos + n) B = { node: tn, off: b - pos };
      pos += n;
    }
    const r = d.createRange(); r.setStart(A.node, A.off); r.setEnd(B.node, B.off);
    const s = w.getSelection(); s.removeAllRanges(); s.addRange(r);
  };
  const rib = (sel) => host.querySelector(".ls-ribbon " + sel);
  /* the browser types: a letter goes in at the caret, the caret moves past
     it, and an input event says so — exactly the three things Chrome does */
  const type = (ch) => {
    const s = w.getSelection(); const r = s.getRangeAt(0);
    if (!r.collapsed) r.deleteContents();          // typing over a selection replaces it
    let node = r.startContainer, off = r.startOffset;
    if (node.nodeType !== 3) {
      const child = node.childNodes[off - 1] || node.childNodes[off];
      if (child && child.nodeType === 3) { node = child; off = child.nodeValue.length; }
      else { const tn = d.createTextNode(""); node.insertBefore(tn, node.childNodes[off] || null); node = tn; off = 0; }
    }
    node.insertData(off, ch);
    const nr = d.createRange(); nr.setStart(node, off + ch.length); nr.setEnd(node, off + ch.length);
    s.removeAllRanges(); s.addRange(nr);
    ed().dispatchEvent(new w.InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
  };
  /* a click on bare label, then on an object: select it without typing on it */
  const pick = async (id) => {
    const cv = host.querySelector(".ls-canvas");
    mouse(cv, "pointerdown", 1, 1); mouse(d, "pointerup", 1, 1); await sleep(30);
    mouse(hit(id), "pointerdown", 10, 10); mouse(d, "pointerup", 10, 10); await sleep(50);
  };

  section("Editing in place");
  mouse(hit("o_a"), "dblclick", 10, 10);
  await sleep(50);
  ok("double-click opens the Word-style editor", !!ed() && ed().getAttribute("contenteditable") === "true");
  ok("it shows the text in one plain span", spans().length === 1 && spans()[0].t === "PVC Tape 18 mm", JSON.stringify(spans()));
  ok("the canvas stops drawing the field while it is edited", layer("o_a") === "");
  ok("the editor has the keyboard", d.activeElement === ed());

  section("Select letters, press Bold — only those letters");
  select(4, 8);
  click(rib(".ls-fx-b"));
  await sleep(60);
  let sp = spans();
  ok("'Tape' alone is bold", sp.length === 3 && sp[1].t === "Tape" && /font-weight:\s*700/.test(sp[1].s) && !/font-weight/.test(sp[0].s), JSON.stringify(sp));
  ok("the editor is still open — the ribbon did not throw us out", !!ed());
  ok("the selection is still on the word", w.getSelection().toString() === "Tape", JSON.stringify(w.getSelection().toString()));
  ok("the ribbon's Bold lights up for it", !!rib(".ls-fx-b.on"));
  ok("…and the panel's Bold button agrees", !host.querySelector(".ls-props .ls-fx-b") || !!host.querySelector(".ls-props .ls-fx-b.on"));

  section("Word's keys in the editor");
  ctrl(ed(), "i");
  await sleep(30);
  sp = spans();
  ok("Ctrl+I makes the selection italic too", /font-style:\s*italic/.test(sp[1].s) && /font-weight:\s*700/.test(sp[1].s), JSON.stringify(sp[1]));
  ctrl(ed(), "]");
  await sleep(30);
  sp = spans();
  ok("Ctrl+] grows the selected letters one step (4 → 4.5 mm)", /font-size:\s*17\.0\dpx/.test(sp[1].s), JSON.stringify(sp[1]));
  ctrl(ed(), "[");
  await sleep(30);
  sp = spans();
  ok("Ctrl+[ brings them back (4 mm = the field's own, so no size on the span)", !/font-size/.test(sp[1].s), JSON.stringify(sp[1]));
  ctrl(ed(), "e");
  await sleep(30);
  ok("Ctrl+E centres the paragraph — on the field, with the editor still open",
    /text-align:\s*center/.test(ed().getAttribute("style") || "") && !!ed(), ed().getAttribute("style"));
  ctrl(ed(), "l"); await sleep(30);

  section("The caret in a word: the word");
  select(1, 1);                                   // inside "PVC"
  ctrl(ed(), "u");
  await sleep(30);
  sp = spans();
  ok("Ctrl+U with the caret in 'PVC' underlines the word", sp[0].t === "PVC" && /underline/.test(sp[0].s), JSON.stringify(sp));

  section("Nothing selected: the next letters typed");
  const end = ed().textContent.length;
  select(end, end);
  ctrl(ed(), "b");
  await sleep(40);
  ok("nothing changes yet — the caret is at the end of 'mm', not inside it", !/700/.test(spans()[spans().length - 1].s), JSON.stringify(spans()));
  ok("but the ribbon already shows Bold, as Word does", !!rib(".ls-fx-b.on"));
  {
    type("X");
    await sleep(30);
    sp = spans();
    const lastSp = sp[sp.length - 1];
    ok("the letter typed next is bold", lastSp.t === "X" && /font-weight:\s*700/.test(lastSp.s), JSON.stringify(sp));
    ok("…and 'mm' before it is not", sp[sp.length - 2].t === " 18 mm" && !/700/.test(sp[sp.length - 2].s), JSON.stringify(sp));
    ok("the text reads as typed", ed().textContent === "PVC Tape 18 mmX", ed().textContent);
    type("Z");
    await sleep(30);
    sp = spans();
    ok("the letter after that is bold too — it follows the one before it", sp[sp.length - 1].t === "XZ" && /700/.test(sp[sp.length - 1].s), JSON.stringify(sp));
    key(ed(), "Backspace"); /* the browser deletes the letter before the caret: */
    { const s = w.getSelection(); const r = s.getRangeAt(0);
      const n = r.startContainer, at = r.startOffset - 1;   // read BEFORE the edit: the range is live
      n.deleteData(at, 1);
      const nr = d.createRange(); nr.setStart(n, at); nr.collapse(true); s.removeAllRanges(); s.addRange(nr);
      ed().dispatchEvent(new w.InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" })); }
    await sleep(30);
    ok("Backspace is read back like anything else", ed().textContent === "PVC Tape 18 mmX", ed().textContent);
  }

  section("Enter, paste and the editor's own undo");
  key(ed(), "Enter");
  await sleep(30);
  ok("Enter makes a new line and keeps the editor open", ed().textContent === "PVC Tape 18 mmX\n" && !!ed().querySelector("br[data-e]"), JSON.stringify(ed().textContent));
  {
    const ev = new w.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { getData: (t) => t === "text/plain" ? "from <b>Word</b>\r\nline 2" : "" } });
    ed().dispatchEvent(ev);
    await sleep(30);
    ok("paste lands as plain words, with Windows line ends put right", ed().textContent === "PVC Tape 18 mmX\nfrom <b>Word</b>\nline 2", JSON.stringify(ed().textContent));
  }
  ctrl(ed(), "z"); await sleep(30);
  ok("Ctrl+Z undoes the paste", ed().textContent === "PVC Tape 18 mmX\n", JSON.stringify(ed().textContent));
  ctrl(ed(), "z"); await sleep(30);
  ok("…and again the new line", ed().textContent === "PVC Tape 18 mmX", JSON.stringify(ed().textContent));
  ctrl(ed(), "y"); await sleep(30);
  ok("Ctrl+Y brings the new line back", ed().textContent === "PVC Tape 18 mmX\n", JSON.stringify(ed().textContent));
  ctrl(ed(), "z"); await sleep(30);

  section("A letter the browser put nowhere in particular");
  {
    ed().appendChild(d.createTextNode("Y"));
    ed().dispatchEvent(new w.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Y" }));
    await sleep(30);
    ok("it is read back wearing the look of the letter before it, and put in a span",
      ed().textContent === "PVC Tape 18 mmXY" && [...ed().childNodes].every((n) => n.nodeType === 1), JSON.stringify(spans()));
    const sp2 = spans();
    ok("…bold, like the X", sp2[sp2.length - 1].t === "XY" && /700/.test(sp2[sp2.length - 1].s), JSON.stringify(sp2));
  }

  section("Commit: the canvas and the printer get the runs");
  ctrl(ed(), "Enter");
  await sleep(50);
  ok("Ctrl+Enter closes the editor", !ed());
  const html = layer("o_a");
  ok("the field is drawn again, by the same generator the printer uses", html.length > 0);
  ok("'Tape' is bold and italic on the label", /<span style="font-weight:700;font-style:italic;">Tape<\/span>/.test(html), html.slice(0, 600));
  ok("'PVC' is underlined", /<span style="text-decoration:underline;">PVC<\/span>/.test(html), html.slice(0, 600));
  ok("the typed 'XY' is bold", /<span style="font-weight:700;">XY<\/span>/.test(html), html.slice(0, 600));
  ok("the paragraph is back to the left", /text-align:left/.test(html));
  ok("the ribbon is back to the whole field: Bold not lit (only part of it is bold)", !rib(".ls-fx-b.on"));

  section("Escape walks out with nothing changed");
  mouse(hit("o_b"), "dblclick", 10, 30); await sleep(50);
  select(0, 6); click(rib(".ls-fx-b")); await sleep(30);
  ok("'Second' is bold in the editor", /700/.test(spans()[0].s), JSON.stringify(spans()));
  key(ed(), "Escape"); await sleep(50);
  ok("Escape closes it", !ed());
  ok("…and the field is as it was", !/<span/.test(layer("o_b")), layer("o_b").slice(0, 300));

  section("The whole field, and Format Painter");
  await pick("o_b");
  ok("o_b is selected, and not being typed on", hit("o_b").classList.contains("on") && !ed());
  ctrl(d.body, "b"); await sleep(30);
  ok("Ctrl+B on the selected field makes the whole field bold", /font:normal 700/.test(layer("o_b")), layer("o_b").slice(0, 200));
  ok("…and the ribbon's Bold is lit", !!rib(".ls-fx-b.on"));
  ctrl(d.body, "c", { shiftKey: true }); await sleep(30);
  ok("Ctrl+Shift+C loads Format Painter", !!host.querySelector(".ls-canvas.ls-painting") && /Format Painter/.test(host.querySelector(".ls-read").textContent));
  mouse(hit("o_a"), "pointerdown", 10, 10); await sleep(50);
  ok("clicking another field paints the look onto it — bold, and its own runs gone",
    /font:normal 700/.test(layer("o_a")) && !/<span/.test(layer("o_a")), layer("o_a").slice(0, 300));
  ok("the brush is put away after one click", !host.querySelector(".ls-canvas.ls-painting"));
  ctrl(d.body, "z"); await sleep(30);
  ok("Ctrl+Z on the label undoes the painting: the runs are back", /<span style="font-weight:700;font-style:italic;">Tape<\/span>/.test(layer("o_a")), layer("o_a").slice(0, 300));

  section("Text from outside lands as a new field");
  {
    const before = host.querySelectorAll(".ls-hit").length;
    const ev = new w.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { getData: (t) => t === "text/plain" ? "Pasted from Word\r\nsecond line" : "" } });
    d.body.dispatchEvent(ev);
    await sleep(50);
    ok("a paste with words the studio did not copy makes a new text field", host.querySelectorAll(".ls-hit").length === before + 1);
    ok("…that says them, on two lines", /Pasted from Word\nsecond line/.test(host.querySelector(".ls-layer").innerHTML));
  }

  section("Format Painter inside the editor, letter to letter");
  {
    mouse(hit("o_a"), "dblclick", 10, 10); await sleep(50);
    select(4, 8);                               // "Tape": bold italic
    ctrl(ed(), "c", { shiftKey: true }); await sleep(30);
    ok("Ctrl+Shift+C picks up the look of the selected letters and keeps the editor open",
      !!ed() && !!host.querySelector(".ls-canvas.ls-painting"));
    select(0, 3);                               // "PVC": underlined
    ctrl(ed(), "v", { shiftKey: true }); await sleep(30);
    const s0 = spans()[0];
    ok("Ctrl+Shift+V puts it on 'PVC': bold italic, the underline gone",
      s0.t === "PVC" && /700/.test(s0.s) && /italic/.test(s0.s) && !/underline/.test(s0.s), JSON.stringify(spans()));
    ok("the brush is put away", !host.querySelector(".ls-canvas.ls-painting"));
    key(ed(), "Escape"); await sleep(50);
    ok("Escape: none of that stuck", /<span style="text-decoration:underline;">PVC<\/span>/.test(layer("o_a")));
  }

  section("The toolbar's Undo is the editor's while it is open");
  {
    mouse(hit("o_a"), "dblclick", 10, 10); await sleep(50);
    const was = ed().textContent;
    select(was.length, was.length); type("Q"); await sleep(30);
    ok("a letter was typed", ed().textContent === was + "Q", ed().textContent);
    const ub = host.querySelector('[data-act="undo"]');
    ok("the toolbar's Undo is live even though the label has history of its own", !!ub && !ub.disabled);
    click(ub); await sleep(30);
    ok("clicking it undoes the typing and leaves the editor open", !!ed() && ed().textContent === was, JSON.stringify(ed().textContent));
    key(ed(), "Escape"); await sleep(50);
  }

  section("Print while typing: the words go with it");
  {
    mouse(hit("o_b"), "dblclick", 10, 30); await sleep(50);
    const was = ed().textContent;
    select(was.length, was.length); type("!"); await sleep(30);
    const pb = [...host.querySelectorAll(".ls-b")].find((b) => /^Print/.test(b.getAttribute("title") || ""));
    ok("there is a Print button", !!pb);
    click(pb); await sleep(600);
    ok("the edit is committed before the dialog reads the label", !ed() && new RegExp(was + "!").test(layer("o_b")), layer("o_b").slice(0, 300));
    ok("…and the print dialog is open", !!d.querySelector(".ls-pp"));
    const cancel = [...d.querySelectorAll(".modal .btn, .modal-foot .btn, [class*=modal] .btn")].find((b) => /Cancel/.test(b.textContent));
    if (cancel) { click(cancel); await sleep(300); }
    ok("the dialog closes again", !d.querySelector(".ls-pp"));
    /* put the field back for the checks below */
    mouse(hit("o_b"), "dblclick", 10, 30); await sleep(50);
    select(0, ed().textContent.length); type(was); await sleep(30);
    ctrl(ed(), "Enter"); await sleep(50);
    ok("the field reads as it did", new RegExp(">" + was + "<").test(layer("o_b")), layer("o_b").slice(0, 300));
  }

  section("Copy puts the words on the system clipboard too");
  {
    await pick("o_b");
    let got = null;
    const ev = new w.Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { setData: (t, v) => { got = [t, v]; } } });
    d.body.dispatchEvent(ev);
    await sleep(20);
    ok("the copy event carries the field's words out", !!got && got[0] === "text/plain" && got[1] === "Second line", JSON.stringify(got));
    ok("…and the object is on the studio's own clipboard (Paste is live)", !rib(".ls-bb.off") || ![...host.querySelectorAll(".ls-ribbon .ls-bb")].some((b) => /Paste/.test(b.textContent) && b.classList.contains("off")));
  }

  /* the dashboard's charts want a <canvas>, which jsdom does not draw — the
     same noise every UI test here prints; anything else is a real error */
  const real = errors.filter((e) => !/getContext|canvas|reading 'scale'/i.test(e));
  console.log("\n--- errors (" + real.length + " real, " + (errors.length - real.length) + " canvas noise) ---");
  real.slice(0, 6).forEach((e) => console.log(e));
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail || real.length ? 1 : 0);
})().catch((e) => { console.log("HARNESS FAIL:", e.stack.split("\n").slice(0, 6).join("\n")); process.exit(1); });
