/* ============================================================
   CHHAPERIA ERP — exchange rates, from Google and only Google

   The office checks the dashboard against a Google search, so the
   published number IS Google's number. There is deliberately no
   second feed: no median, no blend, no fallback to another
   provider. If Google cannot be read for a pair, that pair is
   reported unavailable and the card shows "—". Showing a number
   from somewhere else — even a good one — is what this module
   exists to prevent.

   What we read is the headline figure Google PRINTS on the quote
   page (div.N6SYTe), not the tail of the embedded history series.
   Those two disagree: on 2026-08-11 the history tail gave
   95.42235 while Google displayed 95.4276, i.e. ₹95.42 against
   Google's ₹95.43. The displayed digits are kept verbatim as a
   string so the dashboard can render exactly what Google renders
   instead of re-rounding it.

   Guard: with a single source there is no cross-check, so a
   mis-parse is caught by plausibility instead — a quote is
   rejected if it is not a positive finite number or if it has
   moved more than JUMP_LIMIT from the last accepted Google value
   for that pair within the last hour. A rejected quote makes the
   pair unavailable; it never substitutes another source.

   Rates are quoted as the target currency per 1 unit of the base,
   matching Google's own "FROM-TO" page orientation.
   ============================================================ */
"use strict";

const CACHE_MS = 60 * 1000;        // payload cache, aligned to the dashboard poll
const QUOTE_MS = 60 * 1000;        // per-pair cache (~162 KB gzipped per fetch)
const JUMP_LIMIT = 0.10;           // >10% intraday move = bad parse, not a market move
const JUMP_WINDOW_MS = 60 * 60 * 1000;

// Fetched on every refresh: exactly the currencies the dashboard lists.
// Anything else (converter picks) is fetched lazily and then kept warm.
const BASE_CODES = ["USD", "EUR", "GBP", "AED", "CNY", "JPY"];

// Google serves the full quote page only to something that looks like a browser.
const UA_BROWSER = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
};

let cache = null;        // { at, payload }
let inflight = null;     // dedupe concurrent refreshes
const quotes = new Map(); // "USD-INR" -> { at, rate, shown, asOf, asOfMs, change }
const accepted = new Map(); // "USD-INR" -> { rate, at }  last trusted value, for the jump guard
const wanted = new Set(); // extra pairs requested by the converter, kept warm afterwards

/* ---- parsing -------------------------------------------------------------
   Exported for tests: this is pure, so it can be checked against a saved
   fixture without touching the network. */
function parseQuote(html) {
  // Headline price: the figure Google displays, inside div.N6SYTe.
  // Anchored on the div (the class name also appears in the page's CSS).
  const price = html.match(/<div class="N6SYTe">.*?<span>([\d,]+\.?\d*)<\/span>/s);
  if (!price) return null;
  const shown = price[1];
  const rate = Number(shown.replace(/,/g, ""));
  if (!(rate > 0) || !isFinite(rate)) return null;

  // "Aug 11, 6:36:00 AM UTC" — Google's own as-of line, shown verbatim so the
  // dashboard's freshness claim is Google's claim rather than our fetch time.
  const asOfM = html.match(/<div class="jZZ2de">([^<]{0,60})<\/div>/);
  // "+0.03%" — today's move, for the row's up/down arrow.
  const chgM = html.match(/jsname="vY9t3b"[^>]*>.*?<span[^>]*>([+\-−][\d.]+%)<\/span>/s);

  return {
    rate,
    shown,
    asOf: asOfM ? asOfM[1].trim() : null,
    change: chgM ? chgM[1].replace("−", "-") : null,
  };
}

/* one pair straight from Google, e.g. googleQuote("USD","INR") */
async function googleQuote(from, to) {
  const key = `${from}-${to}`;
  const hit = quotes.get(key);
  if (hit && Date.now() - hit.at < QUOTE_MS) return hit;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  let html;
  try {
    const res = await fetch(`https://www.google.com/finance/quote/${key}`, {
      headers: UA_BROWSER,
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from google finance ${key}`);
    html = await res.text();
  } finally {
    clearTimeout(t);
  }

  const q = parseQuote(html);
  if (!q) {
    // Google restyled the page: the card will show "—" rather than a wrong or
    // second-hand number, so say so here or the breakage is invisible.
    console.error(
      `[fx] could not read Google's printed rate for ${key} — the quote page markup has ` +
        `probably changed; update parseQuote() in backend/src/services/fxService.js`
    );
    throw new Error(`could not read google's quote for ${key}`);
  }

  // Plausibility guard — the only defence available to a single-source feed.
  const prev = accepted.get(key);
  if (prev && Date.now() - prev.at < JUMP_WINDOW_MS) {
    const move = Math.abs(q.rate / prev.rate - 1);
    if (move > JUMP_LIMIT) {
      throw new Error(
        `google quote for ${key} moved ${(move * 100).toFixed(1)}% since ${new Date(prev.at).toISOString()} — treating as a bad parse`
      );
    }
  }

  const rec = { at: Date.now(), ...q };
  quotes.set(key, rec);
  accepted.set(key, { rate: q.rate, at: rec.at });
  return rec;
}

async function buildRates(extra) {
  extra.forEach((c) => wanted.add(c));
  const codes = [...new Set([...BASE_CODES, ...wanted])].filter((c) => c && c !== "INR");

  const settled = await Promise.allSettled(codes.map((c) => googleQuote(c, "INR")));

  const rates = { INR: 1 };
  const shown = { INR: "1" };
  const asOf = {};
  const change = {};
  const unavailable = [];

  settled.forEach((r, i) => {
    const c = codes[i];
    if (r.status !== "fulfilled") {
      unavailable.push(c);
      return;
    }
    rates[c] = r.value.rate;
    shown[c] = r.value.shown;
    if (r.value.asOf) asOf[c] = r.value.asOf;
    if (r.value.change) change[c] = r.value.change;
  });

  if (Object.keys(rates).length === 1) throw new Error("google finance unreachable");

  return {
    base: "INR",
    source: "google",
    rates,        // numeric, INR per 1 unit — for arithmetic
    shown,        // Google's exact printed digits — for display
    asOf,         // Google's own as-of line, verbatim
    change,
    unavailable,
    googleCount: Object.keys(rates).length - 1,
    fetchedAt: Date.now(),
  };
}

async function getRates(extra = []) {
  const missing = extra.filter((c) => c && c !== "INR" && !wanted.has(c) && !BASE_CODES.includes(c));
  if (cache && !missing.length && Date.now() - cache.at < CACHE_MS) return cache.payload;
  if (!inflight || missing.length) {
    inflight = buildRates(extra)
      .then((payload) => {
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (e) {
    // Serve the last good Google payload rather than a number from elsewhere.
    if (cache) return Object.assign({}, cache.payload, { stale: true });
    throw e;
  }
}

/* Direct pair for the converter — Google's own quote for FROM-TO, so a
   USD→EUR conversion shows Google's USD/EUR rate rather than one we derived
   by dividing two INR quotes (which would not match Google's page). */
async function getPair(from, to) {
  if (from === to) return { rate: 1, shown: "1", asOf: null, change: null };
  const q = await googleQuote(from, to);
  return { rate: q.rate, shown: q.shown, asOf: q.asOf, change: q.change };
}

module.exports = { getRates, getPair, parseQuote, BASE_CODES };
