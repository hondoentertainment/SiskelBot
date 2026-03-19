const CACHE_NAME = "siskelbot-v1";
const CONVOS_CACHE_NAME = "siskelbot-convos-v1";
const CONVOS_PATH = "/__siskelbot-offline-convos__";
const APP_ASSETS = [
  "/",
  "/index.html",
  "/app.webmanifest",
  "/icon.svg",
  "/icon-maskable.svg"
];
const CDN_ASSETS = [
  "https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js",
  "https://cdn.jsdelivr.net/npm/marked/marked.min.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_ASSETS);
    await Promise.all(CDN_ASSETS.map(async (url) => {
      try {
        const request = new Request(url, { mode: "no-cors" });
        const response = await fetch(request);
        await cache.put(request, response);
      } catch (_) {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const keep = [CACHE_NAME, CONVOS_CACHE_NAME];
    await Promise.all(keys.filter((key) => !keep.includes(key)).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const { data, ports } = event;
  if (!data || data.type !== "CACHE_CONVOS") return;
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CONVOS_CACHE_NAME);
      const body = JSON.stringify(data.payload || {});
      const req = new Request(self.location.origin + CONVOS_PATH);
      await cache.put(req, new Response(body, { headers: { "Content-Type": "application/json" } }));
      if (ports && ports[0]) ports[0].postMessage({ ok: true });
    } catch (_) {
      if (ports && ports[0]) ports[0].postMessage({ ok: false });
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method === "GET" && new URL(request.url).pathname === CONVOS_PATH) {
    event.respondWith(caches.match(request).then((r) => r || new Response("{}", { headers: { "Content-Type": "application/json" } })));
    return;
  }
  if (request.method !== "GET") return;

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (request.url.startsWith(self.location.origin)) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const fallback = await caches.match("/");
      if (fallback) return fallback;
      throw error;
    }
  })());
});
