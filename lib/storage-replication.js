/**
 * Phase 47: Storage replication manager.
 * Syncs storage writes to other regions via HTTP.
 * Conflict resolution: last-write-wins with simple vector clocks.
 */

const REGION_ID = process.env.REGION_ID || "default";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "";
const ENABLE_REPLICATION = process.env.ENABLE_REPLICATION === "1";
const REPLICATION_TIMEOUT_MS = parseInt(process.env.REPLICATION_TIMEOUT_MS, 10) || 5_000;

export class ReplicationManager {
  constructor() {
    /** @type {Map<string, string>} regionId -> endpoint */
    this._regions = new Map();
    /** @type {Map<string, object>} key -> { clock: { [regionId]: number }, value: any, updatedAt: string } */
    this._vectorClocks = new Map();
    this._parseEnv();
  }

  /**
   * Parse REGIONS env and register peers (same format as region-health).
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
      if (regionId && endpoint && regionId !== REGION_ID) {
        this._regions.set(regionId, endpoint.replace(/\/+$/, ""));
      }
    }
  }

  /**
   * Check if replication is enabled and configured.
   * @returns {boolean}
   */
  isEnabled() {
    return ENABLE_REPLICATION && this._regions.size > 0 && !!INTERNAL_SECRET;
  }

  /**
   * Replicate a key-value write to all other regions.
   * @param {string} key - Storage key
   * @param {*} value - Storage value
   * @param {string} [sourceRegion] - Origin region (default: this region)
   * @returns {Promise<{ sent: number, failed: number, errors: string[] }>}
   */
  async replicate(key, value, sourceRegion) {
    if (!this.isEnabled()) return { sent: 0, failed: 0, errors: [] };

    const source = sourceRegion || REGION_ID;
    const clock = this._incrementClock(key, source);
    const payload = {
      key,
      value,
      sourceRegion: source,
      clock,
      timestamp: new Date().toISOString(),
    };

    let sent = 0;
    let failed = 0;
    const errors = [];

    const promises = [];
    for (const [regionId, endpoint] of this._regions) {
      if (regionId === source) continue;
      promises.push(
        this._sendToRegion(regionId, endpoint, payload)
          .then(() => { sent++; })
          .catch((e) => {
            failed++;
            errors.push(`${regionId}: ${e.message}`);
          })
      );
    }
    await Promise.allSettled(promises);

    return { sent, failed, errors };
  }

  /**
   * Receive replicated data from another region.
   * Returns { accepted: boolean, reason?: string }.
   * @param {object} payload - { key, value, sourceRegion, clock, timestamp }
   * @returns {{ accepted: boolean, reason?: string }}
   */
  receive(payload) {
    if (!payload || !payload.key) {
      return { accepted: false, reason: "missing_key" };
    }

    const { key, clock: incomingClock } = payload;
    const existing = this._vectorClocks.get(key);

    if (existing && existing.clock) {
      // Last-write-wins: compare vector clock sums
      const existingSum = Object.values(existing.clock).reduce((a, b) => a + b, 0);
      const incomingSum = incomingClock
        ? Object.values(incomingClock).reduce((a, b) => a + b, 0)
        : 0;

      if (incomingSum <= existingSum) {
        // Also check timestamp as tiebreaker
        const existingTs = new Date(existing.updatedAt || 0).getTime();
        const incomingTs = new Date(payload.timestamp || 0).getTime();
        if (incomingSum < existingSum || incomingTs <= existingTs) {
          return { accepted: false, reason: "stale_clock" };
        }
      }
    }

    // Accept the write — merge clocks
    const mergedClock = { ...(existing?.clock || {}), ...(incomingClock || {}) };
    for (const r of Object.keys(mergedClock)) {
      mergedClock[r] = Math.max(mergedClock[r] || 0, (incomingClock || {})[r] || 0);
    }

    this._vectorClocks.set(key, {
      clock: mergedClock,
      value: payload.value,
      updatedAt: payload.timestamp || new Date().toISOString(),
    });

    return { accepted: true };
  }

  /**
   * Get current vector clock for a key.
   * @param {string} key
   * @returns {object|null}
   */
  getClockForKey(key) {
    const entry = this._vectorClocks.get(key);
    return entry ? { ...entry.clock } : null;
  }

  // --- Internal ---

  _incrementClock(key, regionId) {
    const existing = this._vectorClocks.get(key);
    const clock = existing?.clock ? { ...existing.clock } : {};
    clock[regionId] = (clock[regionId] || 0) + 1;
    this._vectorClocks.set(key, {
      clock,
      value: null, // will be updated by the caller
      updatedAt: new Date().toISOString(),
    });
    return clock;
  }

  async _sendToRegion(regionId, endpoint, payload) {
    const url = `${endpoint}/api/internal/sync`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REPLICATION_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${INTERNAL_SECRET}`,
          "X-Source-Region": REGION_ID,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Clean up.
   */
  destroy() {
    this._regions.clear();
    this._vectorClocks.clear();
  }
}

/** Singleton */
let _instance = null;

/**
 * Get or create the global ReplicationManager.
 * @returns {ReplicationManager}
 */
export function getReplicationManager() {
  if (!_instance) {
    _instance = new ReplicationManager();
  }
  return _instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetReplicationManager() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}

/**
 * Express middleware to authenticate internal sync requests.
 */
export function internalAuth(req, res, next) {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) {
    return res.status(503).json({ error: "internal_sync_not_configured" });
  }
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
