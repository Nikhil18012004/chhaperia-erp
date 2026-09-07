/* ============================================================
   CHHAPERIA ERP — Label Studio character runs (no server, no DB)

   Word's "select a word and make just that bold", as a model:
   a text object carries `runs` that walk its text. These are the
   rules the editor, the ribbon and the printed sheet all rely on,
   tested on the model alone — labelstudio.js is loaded into a bare
   jsdom window with a stub UI, and LabelStudio.runs is driven
   directly.

     node backend/test/label-runs.js
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  — " + extra : "")); }
}
function section(t) { console.log("\n" + t); }
const J = (x) => JSON.stringify(x);

/* ---- load the studio into a bare window ---- */
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, runScripts: "outside-only" });
const w = dom.window;
w.UI = {
  h: (tag, attrs, kids) => { const e = w.document.createElement(tag); return e; },
  esc: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  toast() {}, modal() {}, confirm() {},
};
w.ENG = { data: { settings: {} } };
w.DB = { saveSettings: () => Promise.resolve() };
w.eval(fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "js", "labelstudio.js"), "utf8"));
const LS = w.LabelStudio;
const R = LS.runs;
ok("the studio exposes its run model", !!R && typeof R.apply === "function");

/* a text object the way newObject makes one */
const text = (t, extra) => Object.assign({
  id: "o_t1", type: "text", x: 2, y: 2, w: 60, h: 10, rot: 0,
  src: { kind: "fixed", prefix: "", suffix: "" },
  text: t, font: "arial", size: 4, bold: false, italic: false, underline: false, strike: false,
  align: "left", valign: "middle", color: "#000000", lineH: 1.25, shrink: true,
  tcase: "none", shade: "", indentL: 0, indentR: 0, wrap: true,
}, extra || {});

section("Apply: the letters picked out, and only those");
{
  const o = text("PVC Tape");
  R.apply(o, 4, 8, { b: true });
  ok("bold on 'Tape' makes two runs", J(o.runs) === J([{ n: 4 }, { n: 4, b: true }]), J(o.runs));
  ok("the whole text still reads as it did", o.text === "PVC Tape");
  R.apply(o, 0, 8, { b: true });
  ok("bolding the lot leaves one run that is all bold", J(o.runs) === J([{ n: 8, b: true }]), J(o.runs));
  R.apply(o, 0, 8, { b: false });
  ok("…and un-bolding it leaves no runs at all — plain is no runs", o.runs === undefined, J(o.runs));
  const p = text("PVC Tape");
  R.apply(p, 2, 6, { c: "#b02a2a", z: 6 });
  ok("colour and size land as overrides on the middle", J(p.runs) === J([{ n: 2 }, { n: 4, c: "#b02a2a", z: 6 }, { n: 2 }]), J(p.runs));
  R.apply(p, 2, 6, { c: null });
  ok("a null takes an override off and keeps the rest", J(p.runs) === J([{ n: 2 }, { n: 4, z: 6 }, { n: 2 }]), J(p.runs));
  R.apply(p, 0, 8, (f) => ({ z: f.size * 2 }));
  ok("a function patch sees each run's resolved format", J(p.runs) === J([{ n: 2, z: 8 }, { n: 4, z: 12 }, { n: 2, z: 8 }]), J(p.runs));
  const q = text("abc", { bold: true });
  R.apply(q, 1, 2, { b: false });
  ok("on a bold field, un-bolding one letter is an explicit b:false", J(q.runs) === J([{ n: 1 }, { n: 1, b: false }, { n: 1 }]), J(q.runs));
  R.apply(q, 1, 2, { b: true });
  ok("…and bolding it again matches the field: no runs", q.runs === undefined, J(q.runs));
}

section("Range: what the ribbon reads");
{
  const o = text("PVC Tape");
  R.apply(o, 4, 8, { b: true, i: true });
  let f = R.range(o, 4, 8);
  ok("a selection inside the bold word reads bold and italic", f.bold === true && f.italic === true, J(f));
  f = R.range(o, 0, 8);
  ok("a selection across plain and bold reads MIXED (null) for bold", f.bold === null && f.italic === null, J(f));
  ok("…but agrees on what did not change", f.font === "arial" && f.size === 4 && f.color === "#000000", J(f));
  f = R.range(o, 5, 5);
  ok("a caret reads the letter BEFORE it", f.bold === true, J(f));
  f = R.range(o, 0, 0);
  ok("a caret at the very start reads the first letter", f.bold === false, J(f));
  ok("an empty field reads the field itself", R.range(text(""), 0, 0).size === 4);
}

section("Splice: typing keeps the look of the letter before the join");
{
  const o = text("PVC Tape");
  R.apply(o, 4, 8, { b: true });
  R.splice(o, 8, 0, "s");
  ok("typing after the bold word is bold", o.text === "PVC Tapes" && J(o.runs) === J([{ n: 4 }, { n: 5, b: true }]), J(o.runs));
  R.splice(o, 4, 0, "X");
  ok("typing at the start of the bold word takes the plain letter before it", o.text === "PVC XTapes" && J(o.runs) === J([{ n: 5 }, { n: 5, b: true }]), J(o.runs));
  R.splice(o, 0, 0, "Z");
  ok("typing at the very start takes the first letter's look", o.text === "ZPVC XTapes" && o.runs[0].n === 6, J(o.runs));
  R.splice(o, 6, 5, "");
  ok("deleting the bold word removes its run", o.text === "ZPVC X" && o.runs === undefined, J(o.runs));
  const p = text("PVC Tape");
  R.apply(p, 4, 8, { b: true });
  R.splice(p, 2, 4, "-", { i: true });
  ok("a replacement across two runs wears the format it was given", p.text === "PV-pe" && J(p.runs) === J([{ n: 2 }, { n: 1, i: true }, { n: 2, b: true }]), J(p.runs));
  const e = text("");
  R.splice(e, 0, 0, "Hi", { b: true });
  ok("typing into an empty field with a pending bold", e.text === "Hi" && J(e.runs) === J([{ n: 2, b: true }]), J(e.runs));
  const nl = text("ab");
  R.apply(nl, 0, 2, { u: true });
  R.splice(nl, 1, 0, "\n");
  ok("a new line is a character like any other", nl.text === "a\nb" && J(nl.runs) === J([{ n: 3, u: true }]), J(nl.runs));
}

section("setText: the properties panel edits the words, not the look");
{
  const o = text("PVC Tape 18 mm");
  R.apply(o, 4, 8, { b: true });
  R.setText(o, "PVC Tape 25 mm");
  ok("changing the width leaves the bold word bold", J(o.runs) === J([{ n: 4 }, { n: 4, b: true }, { n: 6 }]), J(o.runs));
  R.setText(o, "Black PVC Tape 25 mm");
  ok("adding words before it keeps it bold", o.text === "Black PVC Tape 25 mm" && J(o.runs) === J([{ n: 10 }, { n: 4, b: true }, { n: 6 }]), J(o.runs));
  R.setText(o, "");
  ok("emptying the field leaves no runs", o.text === "" && o.runs === undefined, J(o.runs));
  const p = text("plain");
  R.setText(p, "still plain");
  ok("a field with no runs gets none", p.text === "still plain" && p.runs === undefined);
}

section("wordAt: Ctrl+B with the caret in a word");
{
  const t = "PVC Tape 18 mm";
  ok("inside a word: the word", J(R.wordAt(t, 6)) === J([4, 8]), J(R.wordAt(t, 6)));
  ok("at the end of a word: nothing — the format waits for the next letters typed", R.wordAt(t, 8) === null, J(R.wordAt(t, 8)));
  ok("at the start of a word (after a space): nothing to catch", R.wordAt(t, 4) === null);
  ok("at the very start: nothing", R.wordAt(t, 0) === null);
  ok("at the very end: nothing", R.wordAt(t, t.length) === null);
  ok("a hyphenated part is its own word", J(R.wordAt("CHN-TDM", 2)) === J([0, 3]), J(R.wordAt("CHN-TDM", 2)));
  ok("…and the hyphen is an edge", R.wordAt("CHN-TDM", 3) === null && R.wordAt("CHN-TDM", 4) === null);
}

section("Clean: what a file may say about runs");
{
  const d = LS.cleanDoc({ id: "d_x", w: 100, h: 60, objects: [
    Object.assign(text("PVC Tape"), { runs: [{ n: 4 }, { n: 4, b: true, c: "#B02A2A", z: 6, f: "hindi", v: "sup", h: "#ffff00", evil: 1, k: "yes" }] }),
    Object.assign(text("PVC Tape"), { id: "o_t2", runs: [{ n: 4, b: true }, { n: 3 }] }),
    Object.assign(text("PVC Tape"), { id: "o_t3", runs: [{ n: 8 }] }),
    Object.assign(text("PVC Tape"), { id: "o_t4", runs: [{ n: 8, b: true }], bold: true }),
    Object.assign(text("12", { src: { kind: "serial", start: 1, step: 1, pad: 2 } }), { id: "o_t5", runs: [{ n: 2, b: true }] }),
    Object.assign(text("PVC Tape"), { id: "o_t6", runs: [{ n: 4, b: true }, { n: 4, b: true }] }),
  ] });
  const r1 = d.objects[0].runs;
  ok("well-formed runs survive with every override", J(r1) === J([{ n: 4 }, { n: 4, b: true, v: "sup", c: "#b02a2a", h: "#ffff00", z: 6, f: "hindi" }]), J(r1));
  ok("runs that do not cover the text are dropped whole", d.objects[1].runs === undefined, J(d.objects[1].runs));
  ok("runs that say nothing are dropped", d.objects[2].runs === undefined, J(d.objects[2].runs));
  ok("runs that only repeat the field are dropped", d.objects[3].runs === undefined, J(d.objects[3].runs));
  ok("a serial cannot carry runs", d.objects[4].runs === undefined, J(d.objects[4].runs));
  ok("neighbours that agree are merged", J(d.objects[5].runs) === J([{ n: 8, b: true }]), J(d.objects[5].runs));
}

section("Render: the canvas and the printed sheet are one generator");
{
  const o = text("PVC Tape");
  R.apply(o, 4, 8, { b: true, c: "#b02a2a" });
  const d = LS.cleanDoc({ id: "d_r", w: 100, h: 60, objects: [o] });
  const html = LS.oneHtml(d, { index: 0, now: new Date(), prompts: {} });
  ok("the printed label carries the bold red span", /<span style="font-weight:700;color:#b02a2a;">Tape<\/span>/.test(html), html.slice(0, 400));
  ok("…and the plain part in a plain span", /<span>PVC <\/span>/.test(html));
  const u = text("PVC Tape", { underline: true });
  R.apply(u, 4, 8, { u: false });
  const uh = LS.oneHtml(LS.cleanDoc({ id: "d_u", w: 100, h: 60, objects: [u] }), { index: 0, now: new Date(), prompts: {} });
  ok("with runs, the box carries no underline of its own (a span could not take it off)",
    !/text-decoration:underline;white-space/.test(uh) && /<span style="text-decoration:underline;">PVC <\/span><span>Tape<\/span>/.test(uh), uh.slice(0, 500));
  const s = text("m2");
  R.apply(s, 1, 2, { v: "sup" });
  const sh = LS.oneHtml(LS.cleanDoc({ id: "d_s", w: 100, h: 60, objects: [s] }), { index: 0, now: new Date(), prompts: {} });
  ok("superscript is raised and set at 65%", /vertical-align:super;font-size:2\.60mm;" data-z="2\.60">2<\/span>/.test(sh), sh.slice(0, 500));
  const pre = text("18", { src: { kind: "fixed", prefix: "Width ", suffix: " mm" } });
  R.apply(pre, 0, 2, { b: true });
  const ph = LS.oneHtml(LS.cleanDoc({ id: "d_p", w: 100, h: 60, objects: [pre] }), { index: 0, now: new Date(), prompts: {} });
  ok("the prefix and suffix print plain around the dressed value", /<span>Width <\/span><span style="font-weight:700;">18<\/span><span> mm<\/span>/.test(ph), ph.slice(0, 500));
  const plain = text("PVC Tape");
  const plh = LS.oneHtml(LS.cleanDoc({ id: "d_pl", w: 100, h: 60, objects: [plain] }), { index: 0, now: new Date(), prompts: {} });
  ok("a field with no runs prints exactly as before — no spans", /">PVC Tape<\/div><\/div>/.test(plh) && !/<span/.test(plh), plh.slice(0, 400));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
