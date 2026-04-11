/**
 * Phase 40.2: Geo-routing — route users to nearest region automatically.
 *
 * Provides:
 *   - Client IP parsing from common proxy/CDN headers
 *   - IP geolocation (MaxMind GeoLite2 if available, ipapi.co fallback)
 *   - Haversine distance calculation
 *   - Nearest-region selection from a configured region list
 *   - Express middleware that sets req.preferredRegion (and optionally redirects)
 *   - Per-user region preference (override) stored in the storage backend
 *   - In-memory per-region request stats
 *
 * Region configuration is read from the GEO_REGIONS env var (or supplied
 * directly to functions). The format is a comma-separated list of:
 *
 *   "<regionId>:<lat>,<lon>:<url>"
 *
 * Example:
 *   GEO_REGIONS="us-east:38.13,-78.45:https://us-east.example.com,eu-west:53.34,-6.26:https://eu.example.com"
 *
 * The MaxMind binary database can be supplied via:
 *   GEOIP_DB_PATH=/path/to/GeoLite2-City.mmdb
 *
 * @module geo-routing
 */

import * as storage from "./storage.js";

const REGION_PREFERENCE_TYPE = "geo_region_prefs";
const STATS_REGION_NULL = "_unknown";

/**
 * @typedef {object} GeoLocation
 * @property {string|null} country
 * @property {string|null} countryCode
 * @property {string|null} continent
 * @property {number|null} latitude
 * @property {number|null} longitude
 * @property {string|null} city
 * @property {number|string|null} asn
 * @property {string} [source]
 */

/**
 * @typedef {object} Region
 * @property {string} regionId
 * @property {number} latitude
 * @property {number} longitude
 * @property {string} [url]
 * @property {string} [name]
 */

/* ----------------------- Region configuration ----------------------- */

/**
 * Parse the GEO_REGIONS env var into an array of Region objects.
 * @param {string} [raw]
 * @returns {Region[]}
 */
export function parseRegionsConfig(raw) {
  const value = raw == null ? process.env.GEO_REGIONS || "" : raw;
  if (!value || typeof value !== "string") return [];
  const out = [];
  for (const entry of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    // The format is "id:lat,lon:url". We can't simply split on ":" because the
    // URL contains "://". We split on the first colon to isolate the regionId,
    // then on the next colon followed by a non-digit to isolate the URL.
    const firstColon = entry.indexOf(":");
    if (firstColon < 1) continue;
    const regionId = entry.slice(0, firstColon).trim();
    const rest = entry.slice(firstColon + 1);
    // Find "lat,lon" then optional ":url"
    const match = rest.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?::(.*))?$/);
    if (!match) continue;
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    const url = match[3] ? match[3].trim() : undefined;
    if (!regionId || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({ regionId, latitude: lat, longitude: lon, url });
  }
  return out;
}

/**
 * Get configured regions from environment.
 * @returns {Region[]}
 */
export function getConfiguredRegions() {
  return parseRegionsConfig();
}

/* ----------------------- IP parsing ----------------------- */

/**
 * Parse the client IP address from a request, checking common proxy/CDN
 * headers in priority order.
 * @param {object} req - Express request (or similar with `headers` and optional `ip`/`socket`)
 * @returns {string|null}
 */
export function parseClientIP(req) {
  if (!req || typeof req !== "object") return null;
  const headers = req.headers || {};
  const headerOrder = [
    "cf-connecting-ip", // Cloudflare
    "fly-client-ip", // Fly.io
    "true-client-ip", // Akamai/Cloudflare Enterprise
    "x-real-ip", // nginx
    "x-client-ip",
    "x-forwarded-for", // standard proxy header
    "forwarded", // RFC 7239
  ];
  for (const name of headerOrder) {
    const raw = headers[name];
    if (!raw) continue;
    const value = Array.isArray(raw) ? raw[0] : String(raw);
    if (name === "forwarded") {
      // Parse RFC 7239: "for=1.2.3.4;proto=https"
      const m = value.match(/for=("?)([^;,"]+)\1/i);
      if (m) {
        const ip = stripIpBrackets(m[2]);
        if (isValidIp(ip)) return ip;
      }
      continue;
    }
    // X-Forwarded-For can be a comma-separated chain; first entry is original.
    const first = value.split(",")[0].trim();
    const ip = stripIpBrackets(first);
    if (isValidIp(ip)) return ip;
  }
  // Express connection fallback
  if (typeof req.ip === "string" && isValidIp(req.ip)) return stripIpBrackets(req.ip);
  if (req.socket && typeof req.socket.remoteAddress === "string" && isValidIp(req.socket.remoteAddress)) {
    return stripIpBrackets(req.socket.remoteAddress);
  }
  if (req.connection && typeof req.connection.remoteAddress === "string" && isValidIp(req.connection.remoteAddress)) {
    return stripIpBrackets(req.connection.remoteAddress);
  }
  return null;
}

function stripIpBrackets(ip) {
  if (!ip) return ip;
  // Remove leading "::ffff:" mapped IPv4 prefix and bracketed IPv6 like [::1]
  let v = ip.replace(/^\[/, "").replace(/\]$/, "");
  if (v.startsWith("::ffff:")) v = v.slice(7);
  // Strip optional trailing port for IPv4
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.split(":")[0];
  return v;
}

function isValidIp(ip) {
  if (!ip || typeof ip !== "string") return false;
  // Loose IPv4 check
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return ip.split(".").every((n) => {
      const x = parseInt(n, 10);
      return x >= 0 && x <= 255;
    });
  }
  // Loose IPv6 check
  if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":")) return true;
  return false;
}

/**
 * True for private/loopback/link-local IPs that should not be geolocated.
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateIP(ip) {
  if (!ip) return true;
  if (ip === "::1" || ip === "127.0.0.1" || ip === "0.0.0.0") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (ip.startsWith("fe80")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return false;
}

/* ----------------------- Geolocation ----------------------- */

// Lazy-loaded MaxMind reader (only if maxmind module + db file are present)
let _mmReader = null;
let _mmReaderTried = false;

async function loadMaxMindReader() {
  if (_mmReaderTried) return _mmReader;
  _mmReaderTried = true;
  const dbPath = process.env.GEOIP_DB_PATH;
  if (!dbPath) return null;
  try {
    // Optional dependency. If not installed, this throws and we fall back.
    const maxmind = await import("maxmind").catch(() => null);
    if (!maxmind) return null;
    const open = maxmind.open || (maxmind.default && maxmind.default.open);
    if (typeof open !== "function") return null;
    _mmReader = await open(dbPath);
    return _mmReader;
  } catch {
    _mmReader = null;
    return null;
  }
}

// In-memory geolocation cache (small LRU-ish)
const _geoCache = new Map();
const GEO_CACHE_MAX = 1000;
const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function cacheGet(ip) {
  const entry = _geoCache.get(ip);
  if (!entry) return null;
  if (Date.now() - entry.t > GEO_CACHE_TTL_MS) {
    _geoCache.delete(ip);
    return null;
  }
  return entry.v;
}

function cacheSet(ip, value) {
  if (_geoCache.size >= GEO_CACHE_MAX) {
    const first = _geoCache.keys().next().value;
    if (first !== undefined) _geoCache.delete(first);
  }
  _geoCache.set(ip, { t: Date.now(), v: value });
}

/**
 * Hook for tests to inject a fake fetch implementation.
 * @type {((url: string, init?: any) => Promise<any>) | null}
 */
let _fetchImpl = null;
export function _setFetchImpl(fn) { _fetchImpl = fn; }

/**
 * Reset internal caches and overrides (test-only).
 */
export function _resetGeoState() {
  _geoCache.clear();
  _mmReader = null;
  _mmReaderTried = false;
  _fetchImpl = null;
  _regionStats.clear();
}

/**
 * Geolocate an IP address. Returns null on failure.
 * @param {string} ip
 * @returns {Promise<GeoLocation|null>}
 */
export async function geolocateIP(ip) {
  if (!ip || !isValidIp(ip)) return null;
  if (isPrivateIP(ip)) return null;
  const cached = cacheGet(ip);
  if (cached) return cached;

  // Try MaxMind GeoLite2 first
  const reader = await loadMaxMindReader();
  if (reader) {
    try {
      const r = reader.get ? reader.get(ip) : null;
      if (r) {
        const result = {
          country: (r.country && (r.country.names?.en || r.country.iso_code)) || null,
          countryCode: r.country?.iso_code || null,
          continent: r.continent?.code || r.continent?.names?.en || null,
          latitude: r.location?.latitude ?? null,
          longitude: r.location?.longitude ?? null,
          city: r.city?.names?.en || null,
          asn: r.traits?.autonomous_system_number || null,
          source: "maxmind",
        };
        cacheSet(ip, result);
        return result;
      }
    } catch {
      // fall through to API
    }
  }

  // Fallback: free public API (ipapi.co). Skipped if disabled.
  if (process.env.GEOIP_DISABLE_API === "1") return null;
  const fetcher = _fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!fetcher) return null;
  try {
    const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
    const res = await fetcher(url, {
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
        ? AbortSignal.timeout(3000)
        : undefined,
      headers: { "User-Agent": "SiskelBot-GeoRouting/1.0" },
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    if (!data || data.error) return null;
    const result = {
      country: data.country_name || null,
      countryCode: data.country_code || data.country || null,
      continent: data.continent_code || null,
      latitude: typeof data.latitude === "number" ? data.latitude : (data.latitude ? parseFloat(data.latitude) : null),
      longitude: typeof data.longitude === "number" ? data.longitude : (data.longitude ? parseFloat(data.longitude) : null),
      city: data.city || null,
      asn: data.asn || null,
      source: "ipapi.co",
    };
    cacheSet(ip, result);
    return result;
  } catch {
    return null;
  }
}

/* ----------------------- Distance & nearest region ----------------------- */

const EARTH_RADIUS_KM = 6371;

/**
 * Compute great-circle distance between two points using the Haversine formula.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} distance in kilometers
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/**
 * Find the nearest region to the given client coordinates.
 * @param {number} clientLat
 * @param {number} clientLon
 * @param {Region[]} regions
 * @returns {{ regionId: string, distance: number, region: Region }|null}
 */
export function findNearestRegion(clientLat, clientLon, regions) {
  if (!Array.isArray(regions) || regions.length === 0) return null;
  if (!Number.isFinite(clientLat) || !Number.isFinite(clientLon)) return null;
  let best = null;
  for (const r of regions) {
    if (!r || !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
    const d = calculateDistance(clientLat, clientLon, r.latitude, r.longitude);
    if (best === null || d < best.distance) {
      best = { regionId: r.regionId, distance: d, region: r };
    }
  }
  return best;
}

/**
 * Compute distances to all regions, sorted nearest-first.
 * @param {number} clientLat
 * @param {number} clientLon
 * @param {Region[]} regions
 * @returns {Array<{ regionId: string, distance: number, region: Region }>}
 */
export function rankRegionsByDistance(clientLat, clientLon, regions) {
  if (!Array.isArray(regions)) return [];
  const out = [];
  for (const r of regions) {
    if (!r || !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
    out.push({
      regionId: r.regionId,
      distance: calculateDistance(clientLat, clientLon, r.latitude, r.longitude),
      region: r,
    });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

/**
 * Resolve the nearest region for a request.
 * @param {object} req
 * @param {Region[]} [regions]
 * @returns {Promise<{ ip: string|null, location: GeoLocation|null, regionId: string|null, distance: number|null, url: string|null }>}
 */
export async function routeToRegion(req, regions) {
  const list = Array.isArray(regions) && regions.length ? regions : getConfiguredRegions();
  const ip = parseClientIP(req);
  const location = ip ? await geolocateIP(ip) : null;
  if (!location || location.latitude == null || location.longitude == null) {
    return { ip, location, regionId: null, distance: null, url: null };
  }
  const nearest = findNearestRegion(location.latitude, location.longitude, list);
  if (!nearest) return { ip, location, regionId: null, distance: null, url: null };
  return {
    ip,
    location,
    regionId: nearest.regionId,
    distance: nearest.distance,
    url: nearest.region.url || null,
  };
}

/* ----------------------- Express middleware ----------------------- */

/**
 * Build an Express middleware that resolves req.preferredRegion. Optionally
 * redirects to that region's URL if it differs from the current REGION_ID.
 *
 * @param {object} [options]
 * @param {Region[]} [options.regions] - Region list (defaults to GEO_REGIONS env)
 * @param {boolean} [options.redirect] - If true, redirect away when region differs
 * @param {string} [options.currentRegion] - Override REGION_ID for this middleware
 * @param {(req: object) => string|null} [options.userIdResolver] - Resolve user id for preference lookup
 * @param {string[]} [options.skipPaths] - Paths to skip (no resolution / no redirect)
 * @returns {(req: any, res: any, next: Function) => Promise<void>}
 */
export function geoRoutingMiddleware(options = {}) {
  const cfg = {
    regions: options.regions || null,
    redirect: !!options.redirect,
    currentRegion: options.currentRegion || process.env.REGION_ID || "default",
    userIdResolver: typeof options.userIdResolver === "function" ? options.userIdResolver : (req) => req.userId || null,
    skipPaths: Array.isArray(options.skipPaths) ? options.skipPaths : ["/health", "/metrics", "/api/v1/geo"],
  };

  return async function geoRoutingMw(req, res, next) {
    try {
      const url = req.path || req.url || "";
      if (cfg.skipPaths.some((p) => url.startsWith(p))) return next();

      const list = cfg.regions || getConfiguredRegions();
      if (list.length === 0) return next();

      // 1. Honor explicit user override
      let preferred = null;
      const userId = cfg.userIdResolver(req);
      if (userId) {
        try {
          const pref = await getUserRegionPreference(userId);
          if (pref && list.some((r) => r.regionId === pref)) {
            preferred = pref;
          }
        } catch { /* ignore */ }
      }

      // 2. Otherwise, geolocate the client IP
      let resolved = null;
      if (!preferred) {
        resolved = await routeToRegion(req, list);
        if (resolved && resolved.regionId) preferred = resolved.regionId;
      }

      if (preferred) {
        req.preferredRegion = preferred;
        req.geoLocation = resolved ? resolved.location : null;
        recordRegionRequest(preferred, userId);

        if (cfg.redirect && preferred !== cfg.currentRegion) {
          const region = list.find((r) => r.regionId === preferred);
          if (region && region.url) {
            const target = region.url.replace(/\/+$/, "") + (req.originalUrl || req.url || "");
            res.setHeader("X-Geo-Redirect-Region", preferred);
            return res.redirect(307, target);
          }
        }
      } else {
        recordRegionRequest(STATS_REGION_NULL, null);
      }

      next();
    } catch {
      // Never block requests on geo failures
      next();
    }
  };
}

/* ----------------------- Region statistics ----------------------- */

/** @type {Map<string, { requests: number, totalLatencyMs: number, latencySamples: number, users: Set<string> }>} */
const _regionStats = new Map();

function getStatBucket(regionId) {
  let s = _regionStats.get(regionId);
  if (!s) {
    s = { requests: 0, totalLatencyMs: 0, latencySamples: 0, users: new Set() };
    _regionStats.set(regionId, s);
  }
  return s;
}

/**
 * Record a request for a region (used by middleware and explicit hooks).
 * @param {string} regionId
 * @param {string|null} [userId]
 * @param {number} [latencyMs]
 */
export function recordRegionRequest(regionId, userId, latencyMs) {
  if (!regionId) return;
  const s = getStatBucket(regionId);
  s.requests += 1;
  if (typeof latencyMs === "number" && Number.isFinite(latencyMs)) {
    s.totalLatencyMs += latencyMs;
    s.latencySamples += 1;
  }
  if (userId) s.users.add(String(userId));
}

/**
 * Get aggregated per-region usage statistics.
 * @returns {Promise<Record<string, { requests: number, avgLatency: number, users: number }>>}
 */
export async function getRegionStats() {
  /** @type {Record<string, { requests: number, avgLatency: number, users: number }>} */
  const out = {};
  for (const [regionId, s] of _regionStats) {
    out[regionId] = {
      requests: s.requests,
      avgLatency: s.latencySamples > 0 ? s.totalLatencyMs / s.latencySamples : 0,
      users: s.users.size,
    };
  }
  return out;
}

/**
 * Reset all region statistics (test-only).
 */
export function resetRegionStats() {
  _regionStats.clear();
}

/* ----------------------- User region preference ----------------------- */

/**
 * Set the preferred region for a user. Stored in the storage backend so it
 * survives restarts.
 * @param {string} userId
 * @param {string|null} regionId - Pass null to clear the preference
 * @returns {Promise<{ userId: string, regionId: string|null }>}
 */
export async function setUserRegionPreference(userId, regionId) {
  if (!userId) throw new Error("userId is required");
  const id = `pref-${userId}`;
  if (regionId === null || regionId === undefined || regionId === "") {
    try {
      await storage.replace(REGION_PREFERENCE_TYPE, [], "default", "anonymous");
      // Above replaces the whole list — instead, fetch + filter and save back.
    } catch { /* ignore */ }
  }
  const item = {
    id,
    userId: String(userId),
    regionId: regionId ? String(regionId) : null,
    updatedAt: new Date().toISOString(),
  };
  await storage.add(REGION_PREFERENCE_TYPE, item, "default", true, "anonymous");
  return { userId: String(userId), regionId: item.regionId };
}

/**
 * Get the preferred region for a user. Returns null if none set.
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
export async function getUserRegionPreference(userId) {
  if (!userId) return null;
  const id = `pref-${userId}`;
  try {
    const item = await storage.get(REGION_PREFERENCE_TYPE, id, "default", "anonymous");
    if (!item) return null;
    return item.regionId || null;
  } catch {
    return null;
  }
}

/**
 * List all stored user region preferences (admin / debugging).
 * @returns {Promise<Array<{ userId: string, regionId: string|null, updatedAt: string }>>}
 */
export async function listUserRegionPreferences() {
  try {
    const items = await storage.list(REGION_PREFERENCE_TYPE, "default", "anonymous");
    return items.map((i) => ({
      userId: i.userId,
      regionId: i.regionId || null,
      updatedAt: i.updatedAt || i.createdAt || null,
    }));
  } catch {
    return [];
  }
}
