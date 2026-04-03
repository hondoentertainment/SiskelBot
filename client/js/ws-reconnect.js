/**
 * Robust WebSocket client with exponential backoff, jitter, and event replay.
 * Emits connection state changes for UI indicators.
 */

export const State = Object.freeze({
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
  RECONNECTING: "RECONNECTING",
  FAILED: "FAILED",
});

export class ResilientWebSocket {
  /**
   * @param {string|(() => Promise<string>)} url - WebSocket URL or async function that returns one (e.g. fetch ws-token)
   * @param {object} [options]
   * @param {number} [options.maxRetries=10]
   * @param {number} [options.baseDelay=1000]
   * @param {number} [options.maxDelay=30000]
   * @param {number} [options.jitterFactor=0.3]
   * @param {number} [options.heartbeatInterval=25000]
   * @param {string} [options.lastEventTimestamp] - ISO timestamp for missed event replay
   */
  constructor(url, options = {}) {
    this._url = url;
    this.maxRetries = options.maxRetries ?? 10;
    this.baseDelay = options.baseDelay ?? 1000;
    this.maxDelay = options.maxDelay ?? 30000;
    this.jitterFactor = options.jitterFactor ?? 0.3;
    this.heartbeatInterval = options.heartbeatInterval ?? 25000;

    /** @type {WebSocket|null} */
    this._ws = null;
    this._state = State.DISCONNECTED;
    this._retryCount = 0;
    this._retryTimer = null;
    this._heartbeatTimer = null;
    this._closed = false;
    this._lastEventTimestamp = options.lastEventTimestamp
      ? new Date(options.lastEventTimestamp).getTime()
      : null;

    /** @type {Array<string>} */
    this._queue = [];

    // Callbacks
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onstatechange = null;
  }

  /** Current connection state */
  get state() {
    return this._state;
  }

  /**
   * Calculate delay with exponential backoff and jitter.
   * delay = min(baseDelay * 2^attempt * (1 + random*jitter), maxDelay)
   */
  _calcDelay(attempt) {
    const exponential = this.baseDelay * Math.pow(2, attempt);
    const jitter = 1 + Math.random() * this.jitterFactor;
    return Math.min(exponential * jitter, this.maxDelay);
  }

  _setState(newState) {
    if (this._state === newState) return;
    this._state = newState;
    if (typeof this.onstatechange === "function") {
      try {
        this.onstatechange(newState);
      } catch (_) {
        /* ignore callback errors */
      }
    }
  }

  /**
   * Initiate connection. Can be called multiple times safely.
   */
  async connect() {
    if (this._closed) return;
    if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1)) return;

    this._setState(this._retryCount === 0 ? State.CONNECTING : State.RECONNECTING);

    let url;
    try {
      url = typeof this._url === "function" ? await this._url() : this._url;
    } catch (err) {
      this._scheduleRetry();
      return;
    }

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this._scheduleRetry();
      return;
    }

    ws.onopen = () => {
      this._retryCount = 0;
      this._setState(State.CONNECTED);
      this._startHeartbeat();
      this._flushQueue();
      this._requestReplay();
      if (typeof this.onopen === "function") {
        try {
          this.onopen();
        } catch (_) {
          /* ignore */
        }
      }
    };

    ws.onmessage = (event) => {
      // Track last event time for replay
      try {
        const data = JSON.parse(event.data);
        if (data.timestamp) {
          this._lastEventTimestamp = new Date(data.timestamp).getTime();
        } else {
          this._lastEventTimestamp = Date.now();
        }
      } catch (_) {
        this._lastEventTimestamp = Date.now();
      }

      if (typeof this.onmessage === "function") {
        try {
          this.onmessage(event);
        } catch (_) {
          /* ignore */
        }
      }
    };

    ws.onclose = () => {
      this._stopHeartbeat();
      this._ws = null;
      if (!this._closed) {
        this._setState(State.DISCONNECTED);
        this._scheduleRetry();
      }
      if (typeof this.onclose === "function") {
        try {
          this.onclose();
        } catch (_) {
          /* ignore */
        }
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror, so we handle retry there
      ws.close();
    };

    this._ws = ws;
  }

  _scheduleRetry() {
    if (this._closed) return;
    if (this._retryCount >= this.maxRetries) {
      this._setState(State.FAILED);
      return;
    }
    const delay = this._calcDelay(this._retryCount);
    this._retryCount++;
    this._setState(State.RECONNECTING);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Send data over the WebSocket. If disconnected, queues the message
   * for delivery on reconnect.
   * @param {string|object} data
   */
  send(data) {
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(msg);
    } else {
      this._queue.push(msg);
    }
  }

  _flushQueue() {
    while (this._queue.length > 0 && this._ws && this._ws.readyState === 1) {
      this._ws.send(this._queue.shift());
    }
  }

  /**
   * Request missed events from the server on reconnect.
   */
  _requestReplay() {
    if (!this._lastEventTimestamp) return;
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(
        JSON.stringify({
          type: "replay_request",
          since: this._lastEventTimestamp,
        })
      );
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === 1) {
        try {
          this._ws.send(JSON.stringify({ type: "heartbeat" }));
        } catch (_) {
          /* ignore */
        }
      }
    }, this.heartbeatInterval);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Permanently close the connection. No further reconnect attempts.
   */
  close() {
    this._closed = true;
    this._stopHeartbeat();
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._ws) {
      this._ws.onclose = null;
      this._ws.onerror = null;
      this._ws.close();
      this._ws = null;
    }
    this._setState(State.DISCONNECTED);
  }
}
