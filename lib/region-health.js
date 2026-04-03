/**
 * Phase 46: Cross-region health monitoring.
 * Polls registered regions' /health/ready endpoints and tracks status.
 * Region config via REGIONS env var: "us-east:https://us.example.com,eu-west:https://eu.example.com"
 */

const REGION_ID = process.env.REGION_ID || "default";
const POLL_INTERVAL_MS = parseInt(process.env.REGION_POLL_INTERVAL_MS, 10) || 15_000;
const HEALTH_TIMEOUT_MS = parseInt(process.env.REGION_HEALTH_TIMEOUT_MS, 10) || 5_000;

export class RegionHealth {
  constructor() {
    /** @type {Map<string, { endpoint: string, status: string, lastChecked: string|null, latencyMs: number|null, error: string|null }>} */
    this._regions = new Map();
    this._pollInterval = null;
    this._parseEnv();
  }

  /**
   * Parse REGIONS env var and register regions.
   */
  _parseEnv() {
    const regionsStr = process.env.REGIONS || "";
    if (!regionsStr.trim()) return;
    const pairs = regionsStr.split(",").map((s) => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const colonIdx = pair.indexOf(":");
      if (colonIdx < 1) continue;
      const regionId = pair.slice(0, colonIdx).trim();
      const endpoint = pair.slice(colonIdx + 1).trim();
      if (regionId && endpoint) {
        this.registerRegion(regionId, endpoint);
      }
    }
  }

  /**
   * Register a region's health endpoint.
   * @param {string} regionId
   * @param {string} endpoint - Base URL (e.g. https://us.example.com)
   */
  registerRegion(regionId, endpoint) {
    // Don't re-register self
    if (regionId === REGION_ID) return;
    this._regions.set(regionId, {
      endpoint: endpoint.replace(/\/+$/, ""),
      status: "unknown",
      lastChecked: null,
      latencyMs: null,
      error: null,
    });
  }

  /**
   * Poll all registered regions' /health/ready endpoints.
   * @returns {Promise<Map<string, object>>}
   */
  async checkRegions() {
    const checks = [];
    for (const [regionId, info] of this._regions) {
      checks.push(this._checkOne(regionId, info));
    }
    await Promise.allSettled(checks);
    return this._regions;
  }

  async _checkOne(regionId, info) {
    const url = `${info.endpoint}/health/ready`;
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": `SiskelBot-RegionHealth/${REGION_ID}` },
      });
      clearTimeout(timeout);
      const latency = Date.now() - start;
      if (res.ok) {
        info.status = "healthy";
        info.latencyMs = latency;
        info.error = null;
      } else {
        info.status = "unhealthy";
        info.latencyMs = latency;
        info.error = `HTTP ${res.status}`;
      }
    } catch (e) {
      info.status = "unreachable";
      info.latencyMs = Date.now() - start;
      info.error = e.name === "AbortError" ? "timeout" : e.message;
    }
    info.lastChecked = new Date().toISOString();
  }

  /**
   * Return status of all regions (including self).
   * @returns {object[]}
   */
  getRegionStatus() {
    const result = [
      {
        regionId: REGION_ID,
        endpoint: "self",
        status: "healthy",
        lastChecked: new Date().toISOString(),
        latencyMs: 0,
        error: null,
        isSelf: true,
      },
    ];
    for (const [regionId, info] of this._regions) {
      result.push({
        regionId,
        endpoint: info.endpoint,
        status: info.status,
        lastChecked: info.lastChecked,
        latencyMs: info.latencyMs,
        error: info.error,
        isSelf: false,
      });
    }
    return result;
  }

  /**
   * Return regions that are healthy.
   * @returns {object[]}
   */
  getActiveRegions() {
    return this.getRegionStatus().filter((r) => r.status === "healthy");
  }

  /**
   * Start periodic health checking.
   */
  startPolling() {
    this.stopPolling();
    if (this._regions.size === 0) return;
    this._pollInterval = setInterval(() => {
      this.checkRegions().catch((e) =>
        console.warn("[region-health] Poll error:", e.message)
      );
    }, POLL_INTERVAL_MS);
    if (this._pollInterval.unref) this._pollInterval.unref();
    // Initial check
    this.checkRegions().catch(() => {});
  }

  /**
   * Stop periodic health checking.
   */
  stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  /**
   * Clean up.
   */
  destroy() {
    this.stopPolling();
    this._regions.clear();
  }
}

/** Singleton instance */
let _instance = null;

/**
 * Get or create the global RegionHealth instance.
 * @returns {RegionHealth}
 */
export function getRegionHealth() {
  if (!_instance) {
    _instance = new RegionHealth();
  }
  return _instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetRegionHealth() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}
