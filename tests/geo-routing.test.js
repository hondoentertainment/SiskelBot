/**
 * Phase 40.2: Geo-routing tests.
 *
 * Covers:
 *   - parseClientIP from various headers
 *   - calculateDistance (Haversine, known points)
 *   - findNearestRegion / rankRegionsByDistance
 *   - geoRoutingMiddleware sets req.preferredRegion
 *   - User region preference override
 *   - geolocateIP fallback uses injected fetch
 *   - parseRegionsConfig parses GEO_REGIONS
 *   - getRegionStats aggregates request counts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-geo-"));
process.env.STORAGE_PATH = tempDir;

const {
  parseClientIP,
  calculateDistance,
  findNearestRegion,
  rankRegionsByDistance,
  parseRegionsConfig,
  geolocateIP,
  routeToRegion,
  geoRoutingMiddleware,
  setUserRegionPreference,
  getUserRegionPreference,
  recordRegionRequest,
  getRegionStats,
  resetRegionStats,
  isPrivateIP,
  _setFetchImpl,
  _resetGeoState,
} = await import("../lib/geo-routing.js");

test.after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ----------------------- IP parsing ----------------------- */

test("parseClientIP - reads CF-Connecting-IP", () => {
  const ip = parseClientIP({ headers: { "cf-connecting-ip": "203.0.113.5" } });
  assert.equal(ip, "203.0.113.5");
});

test("parseClientIP - reads X-Forwarded-For first entry", () => {
  const ip = parseClientIP({
    headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1, 172.16.0.5" },
  });
  assert.equal(ip, "198.51.100.7");
});

test("parseClientIP - reads X-Real-IP", () => {
  const ip = parseClientIP({ headers: { "x-real-ip": "192.0.2.42" } });
  assert.equal(ip, "192.0.2.42");
});

test("parseClientIP - prefers Cloudflare over X-Forwarded-For", () => {
  const ip = parseClientIP({
    headers: {
      "cf-connecting-ip": "203.0.113.99",
      "x-forwarded-for": "198.51.100.1",
    },
  });
  assert.equal(ip, "203.0.113.99");
});

test("parseClientIP - parses RFC 7239 Forwarded header", () => {
  const ip = parseClientIP({ headers: { forwarded: 'for=192.0.2.60;proto=https' } });
  assert.equal(ip, "192.0.2.60");
});

test("parseClientIP - falls back to req.ip", () => {
  const ip = parseClientIP({ headers: {}, ip: "203.0.113.10" });
  assert.equal(ip, "203.0.113.10");
});

test("parseClientIP - falls back to socket.remoteAddress", () => {
  const ip = parseClientIP({ headers: {}, socket: { remoteAddress: "203.0.113.20" } });
  assert.equal(ip, "203.0.113.20");
});

test("parseClientIP - strips ::ffff: IPv4-mapped prefix", () => {
  const ip = parseClientIP({ headers: { "x-real-ip": "::ffff:192.0.2.1" } });
  assert.equal(ip, "192.0.2.1");
});

test("parseClientIP - returns null for empty headers and no socket", () => {
  const ip = parseClientIP({ headers: {} });
  assert.equal(ip, null);
});

test("parseClientIP - rejects invalid header values", () => {
  const ip = parseClientIP({ headers: { "x-real-ip": "not-an-ip" } });
  assert.equal(ip, null);
});

test("isPrivateIP - identifies loopback and RFC1918 ranges", () => {
  assert.equal(isPrivateIP("127.0.0.1"), true);
  assert.equal(isPrivateIP("10.1.2.3"), true);
  assert.equal(isPrivateIP("192.168.1.1"), true);
  assert.equal(isPrivateIP("172.20.0.1"), true);
  assert.equal(isPrivateIP("169.254.1.1"), true);
  assert.equal(isPrivateIP("::1"), true);
  assert.equal(isPrivateIP("203.0.113.1"), false);
  assert.equal(isPrivateIP("8.8.8.8"), false);
});

/* ----------------------- Distance calculation ----------------------- */

test("calculateDistance - same point is zero", () => {
  assert.equal(calculateDistance(40.7128, -74.0060, 40.7128, -74.0060), 0);
});

test("calculateDistance - NYC to London (~5570 km)", () => {
  // New York: 40.7128, -74.0060; London: 51.5074, -0.1278
  const d = calculateDistance(40.7128, -74.0060, 51.5074, -0.1278);
  assert.ok(Math.abs(d - 5570) < 50, `expected ~5570 km, got ${d.toFixed(0)}`);
});

test("calculateDistance - SF to Tokyo (~8270 km)", () => {
  // San Francisco: 37.7749, -122.4194; Tokyo: 35.6762, 139.6503
  const d = calculateDistance(37.7749, -122.4194, 35.6762, 139.6503);
  assert.ok(Math.abs(d - 8270) < 100, `expected ~8270 km, got ${d.toFixed(0)}`);
});

test("calculateDistance - returns Infinity for non-finite inputs", () => {
  assert.equal(calculateDistance(NaN, 0, 0, 0), Number.POSITIVE_INFINITY);
});

/* ----------------------- Region selection ----------------------- */

const SAMPLE_REGIONS = [
  { regionId: "us-east", latitude: 38.13, longitude: -78.45, url: "https://us-east.example.com" },
  { regionId: "us-west", latitude: 45.84, longitude: -119.7, url: "https://us-west.example.com" },
  { regionId: "eu-west", latitude: 53.34, longitude: -6.26, url: "https://eu-west.example.com" },
  { regionId: "ap-tokyo", latitude: 35.41, longitude: 139.42, url: "https://ap-tokyo.example.com" },
];

test("findNearestRegion - NYC -> us-east", () => {
  const r = findNearestRegion(40.7128, -74.0060, SAMPLE_REGIONS);
  assert.ok(r);
  assert.equal(r.regionId, "us-east");
});

test("findNearestRegion - London -> eu-west", () => {
  const r = findNearestRegion(51.5074, -0.1278, SAMPLE_REGIONS);
  assert.ok(r);
  assert.equal(r.regionId, "eu-west");
});

test("findNearestRegion - Tokyo -> ap-tokyo", () => {
  const r = findNearestRegion(35.6762, 139.6503, SAMPLE_REGIONS);
  assert.ok(r);
  assert.equal(r.regionId, "ap-tokyo");
});

test("findNearestRegion - SF -> us-west", () => {
  const r = findNearestRegion(37.7749, -122.4194, SAMPLE_REGIONS);
  assert.ok(r);
  assert.equal(r.regionId, "us-west");
});

test("findNearestRegion - returns null for empty regions", () => {
  assert.equal(findNearestRegion(0, 0, []), null);
  assert.equal(findNearestRegion(0, 0, null), null);
});

test("rankRegionsByDistance - returns sorted list", () => {
  const ranked = rankRegionsByDistance(40.7128, -74.0060, SAMPLE_REGIONS);
  assert.equal(ranked.length, 4);
  // Each item should have a non-decreasing distance
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i].distance >= ranked[i - 1].distance);
  }
  assert.equal(ranked[0].regionId, "us-east");
});

/* ----------------------- Region config parsing ----------------------- */

test("parseRegionsConfig - parses standard format", () => {
  const raw = "us-east:38.13,-78.45:https://us-east.example.com,eu-west:53.34,-6.26:https://eu-west.example.com";
  const regions = parseRegionsConfig(raw);
  assert.equal(regions.length, 2);
  assert.equal(regions[0].regionId, "us-east");
  assert.equal(regions[0].latitude, 38.13);
  assert.equal(regions[0].longitude, -78.45);
  assert.equal(regions[0].url, "https://us-east.example.com");
  assert.equal(regions[1].regionId, "eu-west");
  assert.equal(regions[1].url, "https://eu-west.example.com");
});

test("parseRegionsConfig - allows entries without URL", () => {
  const regions = parseRegionsConfig("us-east:38.13,-78.45");
  assert.equal(regions.length, 1);
  assert.equal(regions[0].regionId, "us-east");
  assert.equal(regions[0].url, undefined);
});

test("parseRegionsConfig - returns empty for invalid input", () => {
  assert.deepEqual(parseRegionsConfig(""), []);
  assert.deepEqual(parseRegionsConfig("garbage"), []);
});

/* ----------------------- Geolocation (with mocked fetch) ----------------------- */

test("geolocateIP - returns null for private IPs", async () => {
  _resetGeoState();
  assert.equal(await geolocateIP("127.0.0.1"), null);
  assert.equal(await geolocateIP("10.0.0.1"), null);
});

test("geolocateIP - returns null for invalid IPs", async () => {
  _resetGeoState();
  assert.equal(await geolocateIP("not-an-ip"), null);
  assert.equal(await geolocateIP(""), null);
  assert.equal(await geolocateIP(null), null);
});

test("geolocateIP - uses injected fetch for fallback API", async () => {
  _resetGeoState();
  let called = 0;
  _setFetchImpl(async (url) => {
    called++;
    assert.ok(url.includes("8.8.8.8"));
    return {
      ok: true,
      async json() {
        return {
          ip: "8.8.8.8",
          country_name: "United States",
          country_code: "US",
          continent_code: "NA",
          latitude: 37.751,
          longitude: -97.822,
          city: "Mountain View",
          asn: "AS15169",
        };
      },
    };
  });
  const loc = await geolocateIP("8.8.8.8");
  assert.equal(called, 1);
  assert.ok(loc);
  assert.equal(loc.countryCode, "US");
  assert.equal(loc.continent, "NA");
  assert.equal(loc.latitude, 37.751);
  _resetGeoState();
});

test("geolocateIP - caches results", async () => {
  _resetGeoState();
  let called = 0;
  _setFetchImpl(async () => {
    called++;
    return {
      ok: true,
      async json() {
        return { latitude: 1.23, longitude: 4.56, country_code: "ZZ" };
      },
    };
  });
  await geolocateIP("1.1.1.1");
  await geolocateIP("1.1.1.1");
  await geolocateIP("1.1.1.1");
  assert.equal(called, 1, "second/third calls should hit cache");
  _resetGeoState();
});

test("geolocateIP - returns null when fallback API fails", async () => {
  _resetGeoState();
  _setFetchImpl(async () => ({ ok: false, async json() { return {}; } }));
  const loc = await geolocateIP("9.9.9.9");
  assert.equal(loc, null);
  _resetGeoState();
});

/* ----------------------- routeToRegion ----------------------- */

test("routeToRegion - routes a Tokyo client to ap-tokyo", async () => {
  _resetGeoState();
  _setFetchImpl(async () => ({
    ok: true,
    async json() {
      return { latitude: 35.6762, longitude: 139.6503, country_code: "JP" };
    },
  }));
  const req = { headers: { "cf-connecting-ip": "203.0.113.50" } };
  const result = await routeToRegion(req, SAMPLE_REGIONS);
  assert.equal(result.regionId, "ap-tokyo");
  assert.equal(result.url, "https://ap-tokyo.example.com");
  assert.ok(result.distance != null);
  _resetGeoState();
});

test("routeToRegion - returns null region when geolocation fails", async () => {
  _resetGeoState();
  _setFetchImpl(async () => ({ ok: false, async json() { return {}; } }));
  const req = { headers: { "cf-connecting-ip": "203.0.113.51" } };
  const result = await routeToRegion(req, SAMPLE_REGIONS);
  assert.equal(result.regionId, null);
  _resetGeoState();
});

/* ----------------------- Express middleware ----------------------- */

test("geoRoutingMiddleware - sets req.preferredRegion based on geolocation", async () => {
  _resetGeoState();
  resetRegionStats();
  _setFetchImpl(async () => ({
    ok: true,
    async json() {
      return { latitude: 51.5074, longitude: -0.1278, country_code: "GB" };
    },
  }));
  const mw = geoRoutingMiddleware({ regions: SAMPLE_REGIONS, redirect: false });
  const req = { headers: { "cf-connecting-ip": "203.0.113.99" }, path: "/api/v1/chat/completions" };
  let nextCalled = false;
  const res = {};
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.preferredRegion, "eu-west");
  _resetGeoState();
});

test("geoRoutingMiddleware - skips configured paths", async () => {
  _resetGeoState();
  resetRegionStats();
  let fetchCalled = false;
  _setFetchImpl(async () => { fetchCalled = true; return { ok: true, async json() { return {}; } }; });
  const mw = geoRoutingMiddleware({ regions: SAMPLE_REGIONS, redirect: false });
  const req = { headers: { "cf-connecting-ip": "203.0.113.99" }, path: "/health/ready" };
  let nextCalled = false;
  await mw(req, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(fetchCalled, false, "skipped paths should not call fetch");
  assert.equal(req.preferredRegion, undefined);
  _resetGeoState();
});

test("geoRoutingMiddleware - is a no-op when no regions configured", async () => {
  _resetGeoState();
  const mw = geoRoutingMiddleware({ regions: [] });
  const req = { headers: { "cf-connecting-ip": "203.0.113.99" }, path: "/api/v1/x" };
  let nextCalled = false;
  await mw(req, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.preferredRegion, undefined);
});

test("geoRoutingMiddleware - never blocks the request on errors", async () => {
  _resetGeoState();
  _setFetchImpl(async () => { throw new Error("network exploded"); });
  const mw = geoRoutingMiddleware({ regions: SAMPLE_REGIONS });
  const req = { headers: { "cf-connecting-ip": "203.0.113.99" }, path: "/api/v1/x" };
  let nextCalled = false;
  await mw(req, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  _resetGeoState();
});

test("geoRoutingMiddleware - redirects when redirect=true and region differs", async () => {
  _resetGeoState();
  _setFetchImpl(async () => ({
    ok: true,
    async json() {
      return { latitude: 35.6762, longitude: 139.6503, country_code: "JP" };
    },
  }));
  const mw = geoRoutingMiddleware({
    regions: SAMPLE_REGIONS,
    redirect: true,
    currentRegion: "us-east",
  });
  let redirected = null;
  const req = {
    headers: { "cf-connecting-ip": "203.0.113.50" },
    path: "/api/v1/chat",
    originalUrl: "/api/v1/chat?x=1",
  };
  const res = {
    setHeader() {},
    redirect(code, target) { redirected = { code, target }; },
  };
  await mw(req, res, () => {});
  assert.ok(redirected, "should redirect");
  assert.equal(redirected.code, 307);
  assert.ok(redirected.target.startsWith("https://ap-tokyo.example.com"));
  _resetGeoState();
});

/* ----------------------- User region preference override ----------------------- */

test("setUserRegionPreference / getUserRegionPreference - round-trip", async () => {
  await setUserRegionPreference("user-1", "eu-west");
  const got = await getUserRegionPreference("user-1");
  assert.equal(got, "eu-west");
});

test("setUserRegionPreference - updates existing preference", async () => {
  await setUserRegionPreference("user-2", "us-east");
  await setUserRegionPreference("user-2", "ap-tokyo");
  assert.equal(await getUserRegionPreference("user-2"), "ap-tokyo");
});

test("getUserRegionPreference - returns null for unknown users", async () => {
  assert.equal(await getUserRegionPreference("nonexistent-user"), null);
});

test("setUserRegionPreference - throws for empty userId", async () => {
  await assert.rejects(() => setUserRegionPreference("", "us-east"));
});

test("geoRoutingMiddleware - honors user region preference override", async () => {
  _resetGeoState();
  resetRegionStats();
  await setUserRegionPreference("user-override", "ap-tokyo");

  // Even though geolocation would return London (eu-west), the override wins
  _setFetchImpl(async () => ({
    ok: true,
    async json() {
      return { latitude: 51.5074, longitude: -0.1278, country_code: "GB" };
    },
  }));

  const mw = geoRoutingMiddleware({
    regions: SAMPLE_REGIONS,
    redirect: false,
    userIdResolver: () => "user-override",
  });
  const req = { headers: { "cf-connecting-ip": "203.0.113.99" }, path: "/api/v1/chat" };
  await mw(req, {}, () => {});
  assert.equal(req.preferredRegion, "ap-tokyo");
  _resetGeoState();
});

/* ----------------------- Region stats ----------------------- */

test("getRegionStats - aggregates request counts and latencies", async () => {
  resetRegionStats();
  recordRegionRequest("us-east", "u1", 100);
  recordRegionRequest("us-east", "u1", 200);
  recordRegionRequest("us-east", "u2", 300);
  recordRegionRequest("eu-west", "u3", 50);

  const stats = await getRegionStats();
  assert.ok(stats["us-east"]);
  assert.equal(stats["us-east"].requests, 3);
  assert.equal(stats["us-east"].users, 2);
  assert.equal(stats["us-east"].avgLatency, 200); // (100+200+300)/3
  assert.equal(stats["eu-west"].requests, 1);
  assert.equal(stats["eu-west"].avgLatency, 50);
  resetRegionStats();
});

test("getRegionStats - returns empty object when nothing recorded", async () => {
  resetRegionStats();
  const stats = await getRegionStats();
  assert.deepEqual(stats, {});
});
