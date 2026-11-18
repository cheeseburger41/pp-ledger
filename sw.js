// Vici service worker: the app opens straight from its cache (online or offline), so the first thing on screen is the black V,
// never a white page waiting on the network. Your bets always come live from GitHub.
// Releases: every push bumps CACHE, and install lays down one complete copy of the app files in SHELL. Those files are only
// ever written by install, so an open never mixes two releases. launch.js checks for a release on each open and return, and
// moves onto it under the still V when it installs in time; otherwise it shows from the next open.
// A new file the app loads at start belongs in SHELL, or it is fetched (and kept) the first time it's asked for.
const CACHE = "ledger-v27";
const FONTS = "vici-fonts"; // not versioned, so an app update never makes a cold launch wait on Google Fonts
const SHELL = ["./", "./index.html", "./config.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png", "./vici-model.js", "./vici-data.js", "./vici-chat.js", "./vici-chat.css", "./vendor/anthropic-sdk.mjs"];
const abs = u => new URL(u, self.registration.scope).href;
const SHELL_URLS = new Set(SHELL.map(abs)), INDEX = abs("./index.html"), PAGES = new Set([abs("./"), INDEX]);

self.addEventListener("install", e => {
  // Fetch every file fresh (cache: "reload" skips the HTTP cache), then store them together, so a release is all or nothing.
  // A file that's gone from the site (404) is left out rather than blocking every future update; any other failure
  // (offline, a server error, the app closed mid-download) fails the install and the next open tries again.
  e.waitUntil(Promise.all(SHELL.map(u => fetch(new Request(u, { cache: "reload" })).then(res => {
    // Read a copy of each answer as it arrives: Chromium gives an installing worker only a few requests in flight and an
    // unread answer still counts, so waiting for all of them before reading any never finished there.
    if (res.ok && !res.redirected) return res.clone().arrayBuffer().then(() => [abs(u), res]);
    if (res.status === 404 && !PAGES.has(abs(u))) return null;
    throw new Error(u + " " + res.status);
  }))).then(files => caches.open(CACHE).then(c => Promise.all(files.filter(Boolean).map(([k, res]) => c.put(k, res)))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(async keys => {
    const fonts = await caches.open(FONTS);
    for (const k of keys) {
      if (k === CACHE || k === FONTS) continue;
      const old = await caches.open(k); // move fonts saved by older versions across before dropping the old cache
      for (const req of await old.keys()) { const h = new URL(req.url).hostname; if (h === "fonts.googleapis.com" || h === "fonts.gstatic.com") { const r = await old.match(req); if (r) await fonts.put(req, r); } }
      await caches.delete(k);
    }
  }).then(() => self.clients.claim()));
});

// Same-site files: answer from the cache at once. App files (SHELL) stay exactly as this release installed them; anything
// else (launch screens, extra pages) is refreshed in the background for next time. The network is only waited on for a
// file the cache doesn't have. Only a good, direct answer is kept, so an error page, a hotel Wi-Fi sign-in page or a
// redirect never replaces the app, and a failed page load falls back to the app.
function cacheFirst(e) {
  const req = e.request, nav = req.mode === "navigate";
  const u = new URL(req.url), key = u.origin + u.pathname; // one copy per file, whatever the query string
  let kept; e.waitUntil(new Promise(r => { kept = r; })); // keep the worker alive until a fresh copy is saved
  const fetchAndKeep = () => fetch(req).then(res => {
    if (res.ok && res.type === "basic" && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)).then(kept, kept); }
    else kept();
    return res;
  }, err => { kept(); throw err; });
  const index = () => caches.match(INDEX, { ignoreVary: true });
  return caches.match(key, { ignoreSearch: true, ignoreVary: true }).then(hit => {
    if (hit) { if (SHELL_URLS.has(key)) kept(); else fetchAndKeep().catch(() => {}); return hit; }
    return fetchAndKeep().then(
      res => (nav && !res.ok ? index().then(r => r || res) : res),
      () => (nav ? index() : Promise.resolve(null)).then(r => r || Response.error()));
  });
}
// Fonts: serve the cached copy straight away and refresh it in the background.
function staleWhileRevalidate(req) {
  return caches.open(FONTS).then(async c => {
    const hit = await c.match(req);
    const net = fetch(req).then(res => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => hit || Response.error());
    return hit || net;
  });
}
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "api.github.com") return; // your bets always come live from GitHub
  if (url.origin === self.location.origin) { e.respondWith(cacheFirst(e)); return; }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") e.respondWith(staleWhileRevalidate(req));
});
