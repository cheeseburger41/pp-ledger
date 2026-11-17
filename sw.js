// Ledger service worker: the app opens offline from its cache, and your bets come from GitHub whenever there's signal.
const CACHE = "ledger-v6";
const SHELL = ["./", "./index.html", "./config.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Same-site files: try the network for fresh code, fall back to the cache after 3 seconds or when offline.
function networkFirst(req) {
  return new Promise(resolve => {
    let done = false;
    const fromCache = () => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === "navigate" ? caches.match("./index.html") : null));
    const timer = setTimeout(() => fromCache().then(r => { if (r && !done) { done = true; resolve(r); } }), 3000);
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      if (!done) { done = true; clearTimeout(timer); resolve(res); }
    }).catch(() => fromCache().then(r => { if (!done) { done = true; clearTimeout(timer); resolve(r || Response.error()); } }));
  });
}
// Fonts: serve the cached copy straight away and refresh it in the background.
function staleWhileRevalidate(req) {
  return caches.open(CACHE).then(async c => {
    const hit = await c.match(req);
    const net = fetch(req).then(res => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => hit || Response.error());
    return hit || net;
  });
}
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "api.github.com") return; // your bets always come live from GitHub
  if (url.origin === self.location.origin) { e.respondWith(networkFirst(req)); return; }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") e.respondWith(staleWhileRevalidate(req));
});
