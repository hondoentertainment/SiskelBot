/**
 * Offline-first request queue.
 * Uses an AsyncStorage-compatible interface:
 *   { getItem(key), setItem(key, value), removeItem(key) }
 *
 * This interface matches React Native's @react-native-async-storage/async-storage
 * and can be trivially wrapped around window.localStorage for web.
 */
const STORAGE_KEY = '@siskelbot/offline-queue';

/**
 * In-memory fallback storage (used if no storage is provided).
 */
class MemoryStorage {
  constructor() {
    this._data = new Map();
  }
  async getItem(key) {
    return this._data.has(key) ? this._data.get(key) : null;
  }
  async setItem(key, value) {
    this._data.set(key, value);
  }
  async removeItem(key) {
    this._data.delete(key);
  }
}

export class OfflineQueue {
  /**
   * @param {object} storage - AsyncStorage-like interface. If not provided,
   *   tries window.localStorage, then falls back to in-memory.
   */
  constructor(storage) {
    this.storage = storage || OfflineQueue._defaultStorage();
    this._items = [];
    this._loaded = false;
    this._flushing = false;
    this._handler = null;
  }

  static _defaultStorage() {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      const ls = globalThis.localStorage;
      return {
        async getItem(key) {
          return ls.getItem(key);
        },
        async setItem(key, value) {
          ls.setItem(key, value);
        },
        async removeItem(key) {
          ls.removeItem(key);
        },
      };
    }
    return new MemoryStorage();
  }

  async _load() {
    if (this._loaded) return;
    try {
      const raw = await this.storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this._items = parsed;
        }
      }
    } catch {
      this._items = [];
    }
    this._loaded = true;
  }

  async _persist() {
    try {
      await this.storage.setItem(STORAGE_KEY, JSON.stringify(this._items));
    } catch {
      // Ignore persistence errors (storage might be full)
    }
  }

  /**
   * Register a handler function that will be invoked with each queued request
   * during flush. Must return a promise that resolves on success, rejects on
   * failure (retryable).
   */
  setHandler(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('handler must be a function');
    }
    this._handler = fn;
  }

  /**
   * Add a request to the queue.
   */
  async enqueue(request) {
    await this._load();
    const item = {
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      createdAt: new Date().toISOString(),
      attempts: 0,
      request,
    };
    this._items.push(item);
    await this._persist();
    return item.id;
  }

  /**
   * Number of queued items.
   */
  async size() {
    await this._load();
    return this._items.length;
  }

  /**
   * Return a shallow copy of the queued items.
   */
  async list() {
    await this._load();
    return this._items.slice();
  }

  /**
   * Drain the queue by calling the handler on each item. Items that succeed
   * are removed; items that fail stay queued for retry.
   */
  async flush() {
    await this._load();
    if (this._flushing) return { processed: 0, remaining: this._items.length };
    if (!this._handler) {
      throw new Error('No handler set for OfflineQueue; call setHandler() first');
    }
    this._flushing = true;
    let processed = 0;
    const failures = [];
    try {
      const items = this._items.slice();
      for (const item of items) {
        try {
          item.attempts += 1;
          await this._handler(item.request, item);
          // Success: remove from queue
          const idx = this._items.findIndex((q) => q.id === item.id);
          if (idx !== -1) this._items.splice(idx, 1);
          processed += 1;
        } catch (err) {
          failures.push({ id: item.id, error: err && err.message });
        }
      }
      await this._persist();
    } finally {
      this._flushing = false;
    }
    return {
      processed,
      failures,
      remaining: this._items.length,
    };
  }

  async clear() {
    this._items = [];
    await this._load();
    this._items = [];
    await this.storage.removeItem(STORAGE_KEY);
  }
}
