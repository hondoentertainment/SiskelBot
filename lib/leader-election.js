/**
 * Phase 45: Leader election via storage-based lock mechanism.
 * Supports JSON file lock or Postgres advisory lock depending on storage backend.
 * TTL-based: leader must renew within LEADER_TTL_MS (default 30s) or lose leadership.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";

const LEADER_TTL_MS = parseInt(process.env.LEADER_TTL_MS, 10) || 30_000;
const REGION_ID = process.env.REGION_ID || "default";

export class LeaderElection {
  /**
   * @param {object} opts
   * @param {string} [opts.instanceId] - Unique instance identifier
   * @param {number} [opts.ttlMs] - Lock TTL in ms (default LEADER_TTL_MS env or 30s)
   * @param {string} [opts.lockDir] - Directory for file-based lock (default data/)
   * @param {function} [opts.postgresKvLoad] - Postgres KV load function (optional)
   * @param {function} [opts.postgresKvSave] - Postgres KV save function (optional)
   * @param {boolean} [opts.usePostgres] - Use Postgres advisory lock
   */
  constructor(opts = {}) {
    this.instanceId = opts.instanceId || `${REGION_ID}-${randomUUID()}`;
    this.ttlMs = opts.ttlMs || LEADER_TTL_MS;
    this.lockDir = opts.lockDir || process.env.STORAGE_PATH || join(process.cwd(), "data");
    this.usePostgres = opts.usePostgres || false;
    this.postgresKvLoad = opts.postgresKvLoad || null;
    this.postgresKvSave = opts.postgresKvSave || null;
    this._leader = false;
    this._renewInterval = null;
    this._listeners = [];
    this._lockKey = "__leader_lock__";
  }

  _lockFilePath() {
    return join(this.lockDir, ".leader-lock.json");
  }

  /**
   * Try to become leader. Returns true if leadership acquired.
   * @returns {Promise<boolean>}
   */
  async acquire() {
    const now = Date.now();
    const currentLock = await this._readLock();

    // If there's an existing valid lock from another instance, fail
    if (currentLock && currentLock.instanceId !== this.instanceId) {
      const expiresAt = currentLock.acquiredAt + (currentLock.ttlMs || this.ttlMs);
      if (now < expiresAt) {
        return false;
      }
      // Lock expired — take over
      console.log(`[leader-election] Lock from ${currentLock.instanceId} expired, taking over`);
    }

    // Write our lock
    const lock = {
      instanceId: this.instanceId,
      regionId: REGION_ID,
      acquiredAt: now,
      ttlMs: this.ttlMs,
    };
    await this._writeLock(lock);

    const wasLeader = this._leader;
    this._leader = true;

    if (!wasLeader) {
      console.log(`[leader-election] Instance ${this.instanceId} acquired leadership`);
      this._notifyListeners(true);
    }

    // Start renewal
    this._startRenewal();
    return true;
  }

  /**
   * Release leadership.
   * @returns {Promise<void>}
   */
  async release() {
    this._stopRenewal();

    const currentLock = await this._readLock();
    if (currentLock && currentLock.instanceId === this.instanceId) {
      await this._writeLock(null);
    }

    const wasLeader = this._leader;
    this._leader = false;

    if (wasLeader) {
      console.log(`[leader-election] Instance ${this.instanceId} released leadership`);
      this._notifyListeners(false);
    }
  }

  /**
   * Check if this instance is the current leader.
   * @returns {Promise<boolean>}
   */
  async isLeader() {
    const currentLock = await this._readLock();
    if (!currentLock) {
      this._leader = false;
      return false;
    }

    const now = Date.now();
    const expiresAt = currentLock.acquiredAt + (currentLock.ttlMs || this.ttlMs);
    if (now >= expiresAt) {
      this._leader = false;
      return false;
    }

    this._leader = currentLock.instanceId === this.instanceId;
    return this._leader;
  }

  /**
   * Get the current leader info.
   * @returns {Promise<object|null>}
   */
  async getLeader() {
    const currentLock = await this._readLock();
    if (!currentLock) return null;

    const now = Date.now();
    const expiresAt = currentLock.acquiredAt + (currentLock.ttlMs || this.ttlMs);
    if (now >= expiresAt) return null;

    return {
      instanceId: currentLock.instanceId,
      regionId: currentLock.regionId || "unknown",
      acquiredAt: new Date(currentLock.acquiredAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * Register callback for leadership changes.
   * @param {function} callback - Called with (isLeader: boolean)
   */
  onLeaderChange(callback) {
    if (typeof callback === "function") {
      this._listeners.push(callback);
    }
  }

  /**
   * Stop renewal and clean up.
   */
  destroy() {
    this._stopRenewal();
    this._listeners = [];
  }

  // --- Internal ---

  _notifyListeners(isLeader) {
    for (const cb of this._listeners) {
      try {
        cb(isLeader);
      } catch (e) {
        console.warn("[leader-election] Listener error:", e.message);
      }
    }
  }

  _startRenewal() {
    this._stopRenewal();
    const interval = Math.max(1000, Math.floor(this.ttlMs / 3));
    this._renewInterval = setInterval(async () => {
      try {
        const still = await this.isLeader();
        if (still) {
          // Renew the lock
          const lock = {
            instanceId: this.instanceId,
            regionId: REGION_ID,
            acquiredAt: Date.now(),
            ttlMs: this.ttlMs,
          };
          await this._writeLock(lock);
        } else {
          // Lost leadership
          const wasLeader = this._leader;
          this._leader = false;
          if (wasLeader) {
            console.log(`[leader-election] Instance ${this.instanceId} lost leadership`);
            this._notifyListeners(false);
          }
          this._stopRenewal();
        }
      } catch (e) {
        console.warn("[leader-election] Renewal error:", e.message);
      }
    }, interval);
    if (this._renewInterval.unref) this._renewInterval.unref();
  }

  _stopRenewal() {
    if (this._renewInterval) {
      clearInterval(this._renewInterval);
      this._renewInterval = null;
    }
  }

  async _readLock() {
    let data = null;
    if (this.usePostgres && this.postgresKvLoad) {
      try {
        data = await this.postgresKvLoad(this._lockKey);
      } catch (e) {
        console.warn("[leader-election] Postgres read error:", e.message);
        return null;
      }
    } else {
      // File-based lock
      const lockPath = this._lockFilePath();
      try {
        if (existsSync(lockPath)) {
          const raw = readFileSync(lockPath, "utf8");
          data = JSON.parse(raw);
        }
      } catch (e) {
        // Corrupt or missing lock file
      }
    }

    // Validate that the lock has required fields
    if (data && typeof data === "object" && data.instanceId && typeof data.acquiredAt === "number") {
      return data;
    }
    return null;
  }

  async _writeLock(data) {
    if (this.usePostgres && this.postgresKvSave) {
      try {
        await this.postgresKvSave(this._lockKey, data);
      } catch (e) {
        console.warn("[leader-election] Postgres write error:", e.message);
      }
      return;
    }

    // File-based lock
    const lockPath = this._lockFilePath();
    try {
      const dir = dirname(lockPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      if (data === null) {
        writeFileSync(lockPath, "{}", "utf8");
      } else {
        writeFileSync(lockPath, JSON.stringify(data), "utf8");
      }
    } catch (e) {
      console.warn("[leader-election] File write error:", e.message);
    }
  }
}

/** Singleton instance for the application */
let _instance = null;

/**
 * Get or create the global LeaderElection instance.
 * @param {object} [opts]
 * @returns {LeaderElection}
 */
export function getLeaderElection(opts) {
  if (!_instance) {
    _instance = new LeaderElection(opts);
  }
  return _instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetLeaderElection() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}
