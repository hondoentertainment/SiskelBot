import { ChatClient } from './ChatClient.js';
import { KnowledgeClient } from './KnowledgeClient.js';
import { OfflineQueue } from './OfflineQueue.js';
import { AuthManager } from './AuthManager.js';
import { EventEmitter } from './EventEmitter.js';

/**
 * Main entry point for the SiskelBot Mobile SDK.
 *
 * Usage:
 *   const sdk = new SiskelBotSDK({
 *     baseUrl: 'https://your-siskelbot.com',
 *     apiKey: 'your-api-key',
 *     storage: AsyncStorage,   // optional: AsyncStorage-like object
 *     onError: (err) => {},    // optional
 *     userAgent: 'MyApp/1.0',  // optional
 *   });
 *   await sdk.initialize();
 *   const reply = await sdk.chat.send('Hello!');
 */
export class SiskelBotSDK {
  constructor(config = {}) {
    if (!config || !config.baseUrl) {
      throw new Error('SiskelBotSDK requires { baseUrl }');
    }
    this.config = { ...config };
    this.events = new EventEmitter();
    this.auth = new AuthManager(config);

    const clientConfig = {
      ...config,
      auth: this.auth,
      onError: (err) => {
        this.events.emit('error', err);
        if (typeof config.onError === 'function') config.onError(err);
      },
    };

    this.chat = new ChatClient(clientConfig);
    this.knowledge = new KnowledgeClient(clientConfig);
    this.offline = new OfflineQueue(config.storage);

    this._ready = false;
    this._destroyed = false;
    this._onlineListener = null;
    this._offlineListener = null;

    // Wire offline queue to flush chat messages when online
    this.offline.setHandler(async (request) => {
      if (request && request.kind === 'chat.send') {
        return this.chat.send(request.message, request.options || {});
      }
      if (request && request.kind === 'knowledge.add') {
        return this.knowledge.add(request.title, request.content, request.metadata);
      }
      throw new Error(`Unknown queued request kind: ${request && request.kind}`);
    });
  }

  /**
   * Connect to the server, sync state, and emit the 'ready' event.
   * Also attempts to flush any persisted offline queue.
   */
  async initialize() {
    if (this._destroyed) {
      throw new Error('SDK has been destroyed; create a new instance');
    }
    if (this._ready) return true;

    // Best-effort health check
    try {
      const res = await this._healthCheck();
      this.events.emit('connected', res);
    } catch (err) {
      this.events.emit('offline', err);
    }

    // Best-effort flush of any queued requests
    try {
      const size = await this.offline.size();
      if (size > 0) {
        const result = await this.offline.flush();
        this.events.emit('queue:flushed', result);
      }
    } catch (err) {
      this.events.emit('error', err);
    }

    // Listen for online/offline events when available (browsers)
    this._installNetworkListeners();

    this._ready = true;
    this.events.emit('ready');
    return true;
  }

  async _healthCheck() {
    const fetchImpl =
      this.config.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : null);
    if (!fetchImpl) return { ok: false };
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/health`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: this.auth.getHeaders(),
    });
    return { ok: res.ok, status: res.status };
  }

  _installNetworkListeners() {
    if (typeof globalThis === 'undefined') return;
    if (typeof globalThis.addEventListener !== 'function') return;
    this._onlineListener = async () => {
      this.events.emit('online');
      try {
        const result = await this.offline.flush();
        this.events.emit('queue:flushed', result);
      } catch (err) {
        this.events.emit('error', err);
      }
    };
    this._offlineListener = () => {
      this.events.emit('offline');
    };
    try {
      globalThis.addEventListener('online', this._onlineListener);
      globalThis.addEventListener('offline', this._offlineListener);
    } catch {
      // Ignore if events can't be registered
    }
  }

  _removeNetworkListeners() {
    if (typeof globalThis === 'undefined') return;
    if (typeof globalThis.removeEventListener !== 'function') return;
    try {
      if (this._onlineListener) {
        globalThis.removeEventListener('online', this._onlineListener);
      }
      if (this._offlineListener) {
        globalThis.removeEventListener('offline', this._offlineListener);
      }
    } catch {
      // Ignore
    }
    this._onlineListener = null;
    this._offlineListener = null;
  }

  isReady() {
    return this._ready && !this._destroyed;
  }

  /**
   * Clean up listeners and resources.
   */
  async destroy() {
    if (this._destroyed) return;
    this._removeNetworkListeners();
    this.events.emit('destroyed');
    this.events.removeAllListeners();
    this._ready = false;
    this._destroyed = true;
  }
}
