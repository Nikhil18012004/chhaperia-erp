/* ============================================================
   CHHAPERIA ERP — INR exchange rates, shown as Google shows them
   The office compares the dashboard against a Google search, so
   for the main pairs the published rate IS the Google Finance
   quote. Every other source stays on as the cross-check:
     • Google Finance — the displayed rate (main pairs)
     • Yahoo Finance  — live market mid quotes (XXXINR=X)
     • frankfurter.dev — ECB daily reference rate
     • fawazahmed0 currency-api — daily aggregate
     • open.er-api.com — daily (tie-breaker; known to drift)
   A Google quote that disagrees with the daily consensus by >2.5%
   is a bad parse, not a market move — it is dropped and the
   median of the remaining sources stands, which is also what every
   currency without a Google page gets. Rates are INR per 1 unit
   of the foreign currency. Payload cached 60 s; the Google pages
   are ~1 MB each so their quotes are held for 5 min.
   ============================================================ */
"use strict";

const CACHE_MS = 60 * 1000;
const GOOGLE_MS = 5 * 60 * 1000;
const LIVE_SET = ["USD", "EUR", "GBP", "AED", "JPY", "CNY", "SGD", "AUD", "CAD", "CHF", "SAR", "HKD"];
const UA = { "User-Agent": "Mozilla/5.0 (ChhaperiaERP fx)" };
// Google serves the full page only to something that looks like a browser
const UA_BROWSER = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" };

let cache = null;          // { at, payload }
let inflight = null;       // dedupe concurrent refreshes

async function jget(url, timeoutMs = 4500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ac.signal });
    if (!res.ok) throw new Error("HTTP " + res.status + " from " + url);
    return await res.json();
  } finally { clearTimeout(t); }
}

/* one live Yahoo quote: INR per 1 unit of ccy */
async function yahooLive(ccy) {
  const j = await jget(`https://query1.finance.yahoo.com/v8/finance/chart/${ccy}INR=X?range=1d&interval=5m`);
  const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  const p = meta && meta.regularMarketPrice;
  if (!p || !isFinite(p) || p <= 0) throw new Error("no live price for " + ccy);
  return { rate: p, asOf: (meta.regularMarketTime || 0) * 1000 };
}

/* Google's own number for one pair, parsed off the Google Finance quote page.
   The page embeds the pair's history as [[y,m,d,hh,mm,...],[price,...]] points;
   the FINAL point is the figure Google itself displays. Quotes are cached for
   5 minutes so a dashboard refresh doesn't re-download a megabyte per pair. */
const gCache = new Map();   // ccy -> { at, rate, asOf }
async function googleQuote(ccy) {
  const hit = gCache.get(ccy);
  if (hit && Date.now() - hit.at < GOOGLE_MS) return { rate: hit.rate, asOf: hit.asOf };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  let html;
  try {
    const res = await fetch(`https://www.google.com/finance/quote/${ccy}-INR`, { headers: UA_BROWSER, signal: ac.signal });
    if (!res.ok) throw new Error("HTTP " + res.status + " from google finance " + ccy);
    html = await res.text();
  } finally { clearTimeout(t); }
  const re = /\[\[(\d{4}),(\d{1,2}),(\d{1,2}),(\d{1,2}),(\d{1,2}),null,null,\[\]\],\[([0-9.]+),/g;
  let m, last = null;
  while ((m = re.exec(html))) last = m;
  const rate = last ? +last[6] : NaN;
  if (!(rate > 0)) throw new Error("no google quote for " + ccy);
  const asOf = new Date(+last[1], +last[2] - 1, +last[3], +last[4], +last[5]).getTime();
  gCache.set(ccy, { at: Date.now(), rate, asOf });
  return { rate, asOf };
}

/* daily tables — all normalised to INR per 1 unit, keys UPPERCASE */
async function frankfurter() {
  const j = await jget("https://api.frankfurter.dev/v1/latest?base=INR");
  const out = {};
  Object.entries(j.rates || {}).forEach(([c, v]) => { if (v > 0) out[c.toUpperCase()] = 1 / v; });
  return out;
}
async function fawazahmed() {
  const j = await jget("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/inr.min.json");
  const out = {};
  Object.entries(j.inr || {}).forEach(([c, v]) => { if (v > 0) out[c.toUpperCase()] = 1 / v; });
  return out;
}
async function erapi() {
  const j = await jget("https://open.er-api.com/v6/latest/INR");
  if (j.result !== "success") throw new Error("er-api: " + (j["error-type"] || "bad response"));
  const out = {};
  Object.entries(j.rates || {}).forEach(([c, v]) => { if (v > 0) out[c.toUpperCase()] = 1 / v; });
  return out;
}

function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

async function buildRates() {
  const [frank, fawaz, er, ...rest] = await Promise.allSettled([
    frankfurter(), fawazahmed(), erapi(),
    ...LIVE_SET.map((c) => yahooLive(c)),
    ...LIVE_SET.map((c) => googleQuote(c)),
  ]);
  const live = rest.slice(0, LIVE_SET.length);
  const goog = rest.slice(LIVE_SET.length);

  const daily = [frank, fawaz, er].filter((r) => r.status === "fulfilled").map((r) => r.value);
  const dailyNames = ["frankfurter(ECB)", "fawazahmed", "er-api"].filter((_, i) => [frank, fawaz, er][i].status === "fulfilled");
  if (!daily.length && !live.some((r) => r.status === "fulfilled")) {
    throw new Error("all exchange-rate sources unavailable");
  }

  // union of currencies across daily sources; median across what each offers
  const rates = { INR: 1 };
  const meta = { INR: { src: "base" } };
  const codes = new Set();
  daily.forEach((t) => Object.keys(t).forEach((c) => codes.add(c)));
  codes.forEach((c) => {
    const vals = daily.map((t) => t[c]).filter((v) => v > 0);
    if (!vals.length) return;
    rates[c] = median(vals);
    meta[c] = { src: "daily-median", sources: vals.length };
  });

  // blend the live market quote INTO the daily consensus (never let one feed win)
  // The published rate is the median of ALL sources — daily references + the live
  // tick — so the number can't be dragged to a single feed's low/high edge. A live
  // tick that disagrees >2.5% with the daily consensus is treated as a bad/stale
  // tick and dropped, falling back to the daily median.
  LIVE_SET.forEach((c, i) => {
    const r = live[i];
    if (r.status !== "fulfilled") return;
    const { rate, asOf } = r.value;
    const dailyVals = daily.map((t) => t[c]).filter((v) => v > 0);
    const bench = dailyVals.length ? median(dailyVals) : null;
    if (bench && Math.abs(rate / bench - 1) > 0.025) {
      rates[c] = bench;
      meta[c] = { src: "daily-median", sources: dailyVals.length, liveRejected: rate };
      return;
    }
    const pool = dailyVals.concat([rate]);   // live tick is one vote among the sources
    rates[c] = median(pool);
    meta[c] = { src: "consensus", sources: pool.length, live: true, asOf };
  });

  /* Google override — the dashboard promises Google's own number, so where
     the Google Finance quote came through (and the cross-check above doesn't
     call it a bad parse) it replaces the consensus as the published rate. */
  let googleCount = 0;
  LIVE_SET.forEach((c, i) => {
    const g = goog[i];
    if (g.status !== "fulfilled") return;
    const { rate, asOf } = g.value;
    const dailyVals = daily.map((t) => t[c]).filter((v) => v > 0);
    const bench = dailyVals.length ? median(dailyVals) : null;
    if (bench && Math.abs(rate / bench - 1) > 0.025) {
      meta[c] = Object.assign(meta[c] || {}, { googleRejected: rate });
      return;
    }
    rates[c] = rate;
    meta[c] = { src: "google", asOf, checkedAgainst: dailyVals.length };
    googleCount++;
  });

  return {
    base: "INR",                 // rates = INR per 1 unit of the listed currency
    rates, meta,
    googleCount,
    liveCount: Object.keys(meta).filter((c) => meta[c].src === "consensus" && meta[c].live).length,
    dailySources: dailyNames,
    fetchedAt: Date.now(),
  };
}

async function getRates() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.payload;
  if (!inflight) {
    inflight = buildRates()
      .then((payload) => { cache = { at: Date.now(), payload }; return payload; })
      .finally(() => { inflight = null; });
  }
  try { return await inflight; }
  catch (e) {
    if (cache) return Object.assign({}, cache.payload, { stale: true }); // serve last good on upstream failure
    throw e;
  }
}

module.exports = { getRates };
