/* ============================================================
   CHHAPERIA ERP — service worker

   What this is FOR: making the app installable on the floor tablets and
   phones, and making it load fast over the factory Wi-Fi. It is NOT an
   offline mode. This is a live ERP — stock figures, work orders and lab
   readings are only ever true as of the last time the server was asked,
   so a cached answer to "how much is in the store" would be worse than
   no answer at all.

   THE ONE RULE THAT MATTERS

   /api/* is NEVER cached, never intercepted, never served from a cache.
   Every request for data goes to the server or it fails honestly. If you
   are ever tempted to add a cache here to smooth over a flaky link, put
   the retry in the UI instead.

   WHY STATIC ASSETS *ARE* SAFE TO CACHE HARD

   The server rewrites every js/ and css/ URL in index.html to carry
   ?v=<file mtime>. So a changed file is a changed URL: cache-first can
   never serve yesterday's app, because yesterday's URL is not the one
   the page asks for. That property is what this file leans on — if the
   ?v= rewrite in server.js is ever removed, the CACHE_FIRST branch below
   has to go with it.
   ============================================================ */
"use strict";

/* Bump to force every client to drop its caches on the next load. */
const VERSION = "chhaperia-v1";
const SHELL = VERSION + "-shell";
const ASSETS = VERSION + "-assets";

/* The minimum needed to draw something when the network is gone. */
const OFFLINE_URL = "./offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const c = await caches.open(SHELL);
    /* reload: bypass the HTTP cache so a reinstall really refetches */
    await c.addAll([new Request(OFFLINE_URL, { cache: "reload" })]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, ASSETS]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* An asset whose URL carries its own version, so its content can never
   change under a URL we have already stored. */
const isVersionedAsset = (url) =>
  url.searchParams.has("v") && /\.(?:js|css)$/i.test(url.pathname);

/* Images and fonts shipped with the app. Same origin only. */
const isStaticAsset = (url) =>
  /\.(?:png|jpe?g|svg|webp|ico|woff2?|ttf)$/i.test(url.pathname);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                       // writes always go to the server

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // let cross-origin be
  if (url.pathname.startsWith("/api/")) return;           // ⚠ data is never cached

  /* Navigations: always try the network, so a new build is picked up the
     moment it is deployed. Only if the network is genuinely unreachable
     do we show the offline card. */
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        return (await caches.match(OFFLINE_URL, { ignoreSearch: false }))
          || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
      }
    })());
    return;
  }

  /* Versioned js/css: cache-first is safe (see the header note) and is
     what makes a reload on a slow tablet feel instant. */
  if (isVersionedAsset(url)) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) (await caches.open(ASSETS)).put(req, res.clone());
      return res;
    })());
    return;
  }

  /* Images and fonts: serve what we have, refresh it in the background. */
  if (isStaticAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSETS);
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    })());
    return;
  }

  /* Everything else — the manifest, anything unversioned — network first,
     with whatever we last saw as a fallback. */
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) (await caches.open(ASSETS)).put(req, res.clone());
      return res;
    } catch {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw new Error("offline and not cached: " + url.pathname);
    }
  })());
});

/* Lets the page tell a waiting worker to take over immediately. */
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});
