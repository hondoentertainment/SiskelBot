/**
 * SiskelBot Edge Worker
 *
 * Handles read-only operations at Cloudflare edge locations:
 *   - GET /health/live           (instant response, no origin)
 *   - GET /config                (cached from origin, ~30s)
 *   - GET /api/v1/knowledge/search (cached, ~60s)
 *   - GET /api/v1/recipes        (cached, ~60s)
 *   - GET /api/docs/openapi.json (cached, ~1h)
 *   - GET /metrics               (proxied to origin, no cache)
 *
 * All write operations (POST/PUT/PATCH/DELETE) and unrecognised routes
 * passthrough to the origin without caching. Authenticated requests
 * (Authorization, x-api-key, Cookie) are never cached.
 */

const ORIGIN_URL = "https://api.siskelbot.example.com";

const CACHE_CONFIG = {
  "/config": { ttl: 30, vary: [] },
  "/api/v1/knowledge/search": { ttl: 60, vary: ["q", "workspace"] },
  "/api/v1/recipes": { ttl: 60, vary: ["workspace"] },
  "/api/docs/openapi.json": { ttl: 3600, vary: [] },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = (env && env.ORIGIN_URL) || ORIGIN_URL;

    // Instant response for health check
    if (url.pathname === "/health/live") {
      return new Response(JSON.stringify({ status: "ok", edge: "cloudflare" }), {
        headers: {
          "Content-Type": "application/json",
          "X-Edge": "cloudflare",
          "X-Edge-Cache": "BYPASS",
        },
      });
    }

    // Only cache GET/HEAD requests; everything else passes through.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return passthrough(request, origin, url);
    }

    // Authenticated requests bypass the cache to avoid leaking responses.
    if (hasAuth(request)) {
      const upstream = await passthrough(request, origin, url);
      return addEdgeHeaders(upstream, "BYPASS");
    }

    // Check cache config
    const config = getCacheConfig(url.pathname);
    if (!config) {
      const upstream = await passthrough(request, origin, url);
      return addEdgeHeaders(upstream, "BYPASS");
    }

    // Build cache key (normalised)
    const cacheKey = buildCacheKey(url, config);
    const cache = caches.default;

    // Check cache
    let response = await cache.match(cacheKey);
    if (response) {
      return addEdgeHeaders(response, "HIT");
    }

    // Fetch from origin
    response = await fetch(`${origin}${url.pathname}${url.search}`, {
      method: request.method,
      headers: filterRequestHeaders(request.headers),
      redirect: "follow",
    });

    // Cache only successful 200 responses
    if (response.status === 200) {
      response = new Response(response.body, response);
      response.headers.set("Cache-Control", `public, max-age=${config.ttl}`);
      response.headers.set("X-Edge-TTL", String(config.ttl));
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return addEdgeHeaders(response, "MISS");
  },
};

/**
 * Look up cache config for a request path. Returns null when the path is
 * not configured for edge caching.
 */
export function getCacheConfig(pathname) {
  if (!pathname || typeof pathname !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(CACHE_CONFIG, pathname)) {
    return CACHE_CONFIG[pathname];
  }
  // Allow path prefixes (e.g. /api/v1/recipes/foo) when the prefix is configured
  for (const prefix of Object.keys(CACHE_CONFIG)) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return CACHE_CONFIG[prefix];
    }
  }
  return null;
}

/**
 * Build a deterministic cache key URL using only the configured vary params.
 * The cache key is a string URL so it works as both `Request` (for cache.match)
 * and as a stable identifier in tests.
 */
export function buildCacheKey(url, config) {
  const u = typeof url === "string" ? new URL(url) : new URL(url.toString());
  const params = new URLSearchParams();
  if (config && Array.isArray(config.vary)) {
    const sorted = [...config.vary].sort();
    for (const key of sorted) {
      const val = u.searchParams.get(key);
      if (val != null) params.set(key, val);
    }
  }
  const search = params.toString();
  const normalised = `${u.origin}${u.pathname}${search ? `?${search}` : ""}`;
  return new Request(normalised, { method: "GET" });
}

/**
 * Append observability headers to a Response. Returns a new Response so the
 * underlying body stream is preserved correctly.
 */
export function addEdgeHeaders(response, cacheStatus) {
  const headers = new Headers(response.headers);
  headers.set("X-Edge", "cloudflare");
  headers.set("X-Edge-Cache", cacheStatus);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function hasAuth(request) {
  const h = request.headers;
  return Boolean(
    h.get("authorization") || h.get("x-api-key") || h.get("cookie")
  );
}

function passthrough(request, origin, url) {
  return fetch(`${origin}${url.pathname}${url.search}`, {
    method: request.method,
    headers: filterRequestHeaders(request.headers),
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "manual",
  });
}

function filterRequestHeaders(headers) {
  const out = new Headers();
  for (const [k, v] of headers.entries()) {
    const lower = k.toLowerCase();
    // Hop-by-hop headers should not be forwarded
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "keep-alive" ||
      lower === "proxy-authenticate" ||
      lower === "proxy-authorization" ||
      lower === "te" ||
      lower === "trailers" ||
      lower === "transfer-encoding" ||
      lower === "upgrade"
    ) {
      continue;
    }
    out.set(k, v);
  }
  return out;
}

// Re-export constants so tests can introspect them.
export { CACHE_CONFIG, ORIGIN_URL };
