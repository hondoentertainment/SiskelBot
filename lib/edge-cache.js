/**
 * Phase 35.5: Edge cache invalidation client.
 *
 * Supports purging Cloudflare and Fastly caches via their HTTP APIs.
 *
 * Provider selection:
 *   EDGE_PROVIDER=cloudflare    (default if CLOUDFLARE_API_TOKEN is set)
 *   EDGE_PROVIDER=fastly        (default if FASTLY_API_TOKEN is set)
 *   EDGE_PROVIDER=none|""       (no-op — useful in dev/CI)
 *
 * Cloudflare envs:
 *   CLOUDFLARE_API_TOKEN         API token with "Cache Purge" permission
 *   CLOUDFLARE_ZONE_ID           Zone ID for the cached hostname
 *   CLOUDFLARE_HOSTNAME          Hostname used to build full URLs (optional)
 *
 * Fastly envs:
 *   FASTLY_API_TOKEN             API token with "purge_all" / "purge_select"
 *   FASTLY_SERVICE_ID            Service ID
 */

export function getEdgeProvider() {
  const explicit = (process.env.EDGE_PROVIDER || "").toLowerCase().trim();
  if (explicit === "cloudflare" || explicit === "fastly" || explicit === "none") return explicit;
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID) return "cloudflare";
  if (process.env.FASTLY_API_TOKEN && process.env.FASTLY_SERVICE_ID) return "fastly";
  return "none";
}

export function listEdgeProviders() {
  return [
    {
      name: "cloudflare",
      configured: Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID),
      hostname: process.env.CLOUDFLARE_HOSTNAME || null,
    },
    {
      name: "fastly",
      configured: Boolean(process.env.FASTLY_API_TOKEN && process.env.FASTLY_SERVICE_ID),
      hostname: process.env.FASTLY_HOSTNAME || null,
    },
    {
      name: "active",
      configured: getEdgeProvider() !== "none",
      hostname: null,
      provider: getEdgeProvider(),
    },
  ];
}

/**
 * Build absolute URLs for a list of paths using the configured hostname.
 * Returns empty array if no hostname is configured.
 */
function buildAbsoluteUrls(paths, hostname) {
  if (!hostname) return [];
  const base = hostname.startsWith("http") ? hostname : `https://${hostname}`;
  return paths.map((p) => (p.startsWith("http") ? p : `${base}${p.startsWith("/") ? p : `/${p}`}`));
}

/**
 * Purge a list of paths and/or patterns from the configured edge provider.
 *
 * @param {{ paths?: string[], patterns?: string[], fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ok: boolean, provider: string, purged?: string[], patternsPurged?: string[], status?: number, code?: string, error?: string}>}
 */
export async function invalidateEdgeCache(opts = {}) {
  const paths = Array.isArray(opts.paths) ? opts.paths : [];
  const patterns = Array.isArray(opts.patterns) ? opts.patterns : [];
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const provider = opts.provider || getEdgeProvider();

  if (provider === "none") {
    return {
      ok: true,
      provider: "none",
      purged: paths,
      patternsPurged: patterns,
    };
  }

  if (typeof fetchImpl !== "function") {
    return { ok: false, status: 500, code: "EDGE_NO_FETCH", error: "fetch is not available in this runtime", provider };
  }

  if (provider === "cloudflare") {
    return purgeCloudflare({ paths, patterns, fetchImpl });
  }
  if (provider === "fastly") {
    return purgeFastly({ paths, patterns, fetchImpl });
  }

  return { ok: false, status: 400, code: "EDGE_UNKNOWN_PROVIDER", error: `Unknown edge provider: ${provider}`, provider };
}

async function purgeCloudflare({ paths, patterns, fetchImpl }) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const hostname = process.env.CLOUDFLARE_HOSTNAME || "";
  if (!token || !zoneId) {
    return {
      ok: false,
      status: 500,
      code: "EDGE_NOT_CONFIGURED",
      error: "Cloudflare credentials missing (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID).",
      provider: "cloudflare",
    };
  }

  const urls = buildAbsoluteUrls(paths, hostname);
  // If hostname is unset, send the raw paths under "files"; the Cloudflare
  // API requires absolute URLs but we'll surface a clearer error if it fails.
  const files = urls.length ? urls : paths;

  // patterns become tags in Cloudflare; otherwise we fall back to purge_everything.
  const body = {};
  if (files.length) body.files = files;
  if (patterns.length) body.tags = patterns;
  if (!files.length && !patterns.length) body.purge_everything = true;

  const res = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await safeJson(res);
  if (!res.ok || (data && data.success === false)) {
    return {
      ok: false,
      status: res.status,
      code: "EDGE_PURGE_FAILED",
      error: data && data.errors ? JSON.stringify(data.errors) : `HTTP ${res.status}`,
      provider: "cloudflare",
    };
  }
  return {
    ok: true,
    provider: "cloudflare",
    purged: paths,
    patternsPurged: patterns,
  };
}

async function purgeFastly({ paths, patterns, fetchImpl }) {
  const token = process.env.FASTLY_API_TOKEN;
  const serviceId = process.env.FASTLY_SERVICE_ID;
  const hostname = process.env.FASTLY_HOSTNAME || "";
  if (!token || !serviceId) {
    return {
      ok: false,
      status: 500,
      code: "EDGE_NOT_CONFIGURED",
      error: "Fastly credentials missing (FASTLY_API_TOKEN, FASTLY_SERVICE_ID).",
      provider: "fastly",
    };
  }

  const headers = {
    "Fastly-Key": token,
    Accept: "application/json",
  };

  // Per-path purge: PURGE method against the URL.
  for (const p of paths) {
    const url = p.startsWith("http") ? p : `https://${hostname}${p.startsWith("/") ? p : `/${p}`}`;
    if (!hostname && !p.startsWith("http")) {
      return {
        ok: false,
        status: 500,
        code: "EDGE_NOT_CONFIGURED",
        error: "FASTLY_HOSTNAME must be set for per-path purges.",
        provider: "fastly",
      };
    }
    const res = await fetchImpl(url, { method: "PURGE", headers });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        code: "EDGE_PURGE_FAILED",
        error: `Fastly PURGE failed for ${url}: HTTP ${res.status}`,
        provider: "fastly",
      };
    }
  }

  // Pattern purge: surrogate-key API.
  if (patterns.length) {
    const res = await fetchImpl(`https://api.fastly.com/service/${serviceId}/purge`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Surrogate-Key": patterns.join(" ") },
      body: JSON.stringify({ surrogate_keys: patterns }),
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        code: "EDGE_PURGE_FAILED",
        error: `Fastly surrogate-key purge failed: HTTP ${res.status}`,
        provider: "fastly",
      };
    }
  }

  return {
    ok: true,
    provider: "fastly",
    purged: paths,
    patternsPurged: patterns,
  };
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
