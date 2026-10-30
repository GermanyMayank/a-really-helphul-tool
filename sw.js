// sw.js: makes the app installable and lets it open without a connection.
//
// Only the app itself is cached here (HTML, scripts, styles, icons, font),
// never documents or anything from api.github.com: those requests are not
// touched at all. Opened documents have their own cache in blobs.js, which
// the lock button clears.
//
// scripts/build-site.sh fills in VERSION and the SHELL list on deploy. Every
// script and style URL carries ?v=<version>, so cache-first is always safe:
// a new release has new URLs. Pages are network-first, so an update shows up
// on the next visit; the cached copy is only used offline.

const VERSION = "__VERSION__";
const SHELL = [/*__SHELL__*/];
const CACHE = `helpful-shell-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("helpful-shell-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // GitHub API etc.: straight to the network

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put(url.pathname, res.clone());
        return res;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(url.pathname)) || (await cache.match("./")) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === "basic") cache.put(req, res.clone());
    return res;
  })());
});
