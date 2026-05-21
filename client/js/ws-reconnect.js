/**
 * WebSocket reconnection manager with exponential backoff, jitter,
 * visibility/online awareness, heartbeat, and UI indicator.
 */

const STATES = Object.freeze({
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  disconnected: 'disconnected',
});

/**
 * Create a reconnecting WebSocket manager.
 *
 * @param {object} options
 * @param {string} options.getTokenUrl - URL to fetch a one-time WS token (e.g. "/api/ws-token")
 * @param {string} [options.apiKey] - API key sent as Authorization header when fetching the token
 * @param {function(): Record<string, string>} [options.getTokenHeaders] - Optional headers for each token fetch; merged after apiKey (overrides shared keys like Authorization)
 * @param {string} [options.workspace="default"] - Workspace id appended to the token URL and WS URL
 * @param {number} [options.maxRetries=10]
 * @param {number} [options.baseDelay=1000] - Initial reconnect delay in ms
 * @param {number} [options.maxDelay=30000] - Cap for reconnect delay in ms
 * @param {number} [options.heartbeatInterval=30000] - Ping interval in ms
 * @param {function} [options.onConnect] - Called when the WebSocket connects
 * @param {function} [options.onDisconnect] - Called when the WebSocket disconnects (manual or max retries)
 * @param {function(number, number)} [options.onReconnecting] - Called with (attempt, delay) before each retry
 * @param {function} [options.onMaxRetriesExceeded] - Called when max retries is reached
 * @param {function(MessageEvent)} [options.onMessage] - Called on every incoming WS message
 * @returns {{ connect(): void, disconnect(): void, send(data: string|object): void, getState(): string, getReconnectAttempt(): number }}
 */
export function createReconnectingWebSocket(options = {}) {
  const {
    getTokenUrl = '/api/ws-token',
    apiKey,
    getTokenHeaders,
    workspace = 'default',
    maxRetries = 10,
    baseDelay = 1000,
    maxDelay = 30000,
    heartbeatInterval = 30000,
    onConnect,
    onDisconnect,
    onReconnecting,
    onMaxRetriesExceeded,
    onMessage,
  } = options;

  let state = STATES.disconnected;
  let ws = null;
  let attempt = 0;
  let retryTimer = null;
  let heartbeatTimer = null;
  let intentionalClose = false;
  let pausedForVisibility = false;
  let pausedForOffline = false;
  const sendQueue = [];

  // --- helpers ---

  function setState(newState) {
    state = newState;
  }

  function calcDelay(n) {
    const exponential = baseDelay * Math.pow(2, n);
    // +-25% jitter
    const jitter = 1 + (Math.random() * 0.5 - 0.25);
    return Math.min(exponential * jitter, maxDelay);
  }

  function safeCall(fn, ...args) {
    if (typeof fn === 'function') {
      try { fn(...args); } catch (_) { /* ignore callback errors */ }
    }
  }

  // --- token fetch ---

  async function fetchToken() {
    const sep = getTokenUrl.includes('?') ? '&' : '?';
    const url = `${getTokenUrl}${sep}workspace=${encodeURIComponent(workspace)}`;
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (typeof getTokenHeaders === 'function') {
      try {
        const extra = getTokenHeaders();
        if (extra && typeof extra === 'object') Object.assign(headers, extra);
      } catch (_) { /* ignore */ }
    }
    const res = await fetch(url, { headers, credentials: 'include' });
    if (!res.ok) throw new Error(`ws-token fetch failed: ${res.status}`);
    const data = await res.json();
    if (!data || !data.token) throw new Error('ws-token response missing token');
    return data.token;
  }

  // --- heartbeat ---

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) { /* ignore */ }
      }
    }, heartbeatInterval);
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // --- queue ---

  function flushQueue() {
    while (sendQueue.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(sendQueue.shift());
    }
  }

  // --- core connect ---

  async function doConnect() {
    if (intentionalClose) return;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    setState(attempt === 0 ? STATES.connecting : STATES.reconnecting);

    let token;
    try {
      token = await fetchToken();
    } catch (_) {
      scheduleRetry();
      return;
    }

    if (intentionalClose) return;

    const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
    const host = typeof location !== 'undefined' ? location.host : 'localhost';
    const wsUrl = `${proto}//${host}/ws?token=${encodeURIComponent(token)}&workspace=${encodeURIComponent(workspace)}`;

    let sock;
    try {
      sock = new WebSocket(wsUrl);
    } catch (_) {
      scheduleRetry();
      return;
    }

    sock.onopen = () => {
      attempt = 0;
      setState(STATES.connected);
      startHeartbeat();
      flushQueue();
      safeCall(onConnect);
    };

    sock.onmessage = (event) => {
      safeCall(onMessage, event);
    };

    sock.onclose = () => {
      stopHeartbeat();
      ws = null;
      if (!intentionalClose) {
        setState(STATES.disconnected);
        safeCall(onDisconnect);
        scheduleRetry();
      }
    };

    sock.onerror = () => {
      // onclose fires after onerror; retry handled there
      sock.close();
    };

    ws = sock;
  }

  // --- retry scheduling ---

  function scheduleRetry() {
    if (intentionalClose) return;
    if (pausedForVisibility || pausedForOffline) return;
    if (attempt >= maxRetries) {
      setState(STATES.disconnected);
      safeCall(onMaxRetriesExceeded);
      safeCall(onDisconnect);
      return;
    }
    const delay = calcDelay(attempt);
    setState(STATES.reconnecting);
    safeCall(onReconnecting, attempt + 1, Math.round(delay));
    attempt++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      doConnect();
    }, delay);
  }

  function cancelRetry() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  // --- visibility / online listeners ---

  function onVisibilityChange() {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      pausedForVisibility = true;
      cancelRetry();
    } else {
      pausedForVisibility = false;
      if (!intentionalClose && state !== STATES.connected) {
        cancelRetry();
        doConnect();
      }
    }
  }

  function onOnline() {
    pausedForOffline = false;
    if (!intentionalClose && state !== STATES.connected) {
      attempt = 0;
      cancelRetry();
      doConnect();
    }
  }

  function onOffline() {
    pausedForOffline = true;
    cancelRetry();
  }

  function addListeners() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
    }
  }

  function removeListeners() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    }
  }

  // --- public API ---

  function connect() {
    intentionalClose = false;
    attempt = 0;
    addListeners();
    doConnect();
  }

  function disconnect() {
    intentionalClose = true;
    cancelRetry();
    stopHeartbeat();
    removeListeners();
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }
    setState(STATES.disconnected);
    safeCall(onDisconnect);
  }

  function send(data) {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    } else {
      sendQueue.push(msg);
    }
  }

  function getState() {
    return state;
  }

  function getReconnectAttempt() {
    return attempt;
  }

  return { connect, disconnect, send, getState, getReconnectAttempt };
}

/**
 * Render a live connection status indicator into the given container element.
 * Listens to WebSocket manager state changes via polling (lightweight) and
 * wires up a manual retry button.
 *
 * @param {HTMLElement} containerEl - Element to render the indicator into
 * @param {{ getState(): string, getReconnectAttempt(): number, connect(): void }} wsManager
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=10] - Used for display purposes (e.g. "3/10")
 */
export function renderConnectionIndicator(containerEl, wsManager, opts = {}) {
  const maxRetries = opts.maxRetries ?? 10;

  // Build DOM
  const wrapper = document.createElement('div');
  wrapper.className = 'ws-connection-indicator';
  wrapper.setAttribute('role', 'status');
  wrapper.setAttribute('aria-live', 'polite');
  wrapper.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:13px;font-family:inherit;';

  const dot = document.createElement('span');
  dot.style.cssText = 'width:10px;height:10px;border-radius:50%;display:inline-block;flex-shrink:0;';

  const label = document.createElement('span');
  label.className = 'ws-indicator-label';

  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'Retry';
  retryBtn.type = 'button';
  retryBtn.style.cssText = 'display:none;margin-left:4px;padding:2px 8px;font-size:12px;cursor:pointer;border:1px solid #888;border-radius:3px;background:#f5f5f5;';
  retryBtn.addEventListener('click', () => {
    wsManager.connect();
  });

  wrapper.appendChild(dot);
  wrapper.appendChild(label);
  wrapper.appendChild(retryBtn);
  containerEl.appendChild(wrapper);

  let lastRendered = '';

  function update() {
    const st = wsManager.getState();
    const att = wsManager.getReconnectAttempt();
    const key = `${st}:${att}`;
    if (key === lastRendered) return;
    lastRendered = key;

    retryBtn.style.display = 'none';

    switch (st) {
      case 'connected':
        dot.style.background = '#22c55e';
        label.textContent = 'Connected';
        break;
      case 'connecting':
        dot.style.background = '#eab308';
        label.textContent = 'Connecting...';
        break;
      case 'reconnecting':
        dot.style.background = '#eab308';
        label.textContent = `Reconnecting (attempt ${att}/${maxRetries})...`;
        break;
      case 'disconnected':
        dot.style.background = '#ef4444';
        label.textContent = 'Disconnected';
        if (att >= maxRetries || att > 0) {
          retryBtn.style.display = 'inline-block';
        }
        break;
      default:
        dot.style.background = '#9ca3af';
        label.textContent = st;
    }
  }

  // Poll state at a low frequency; this keeps the UI in sync without
  // requiring the manager to hold DOM references or emit events.
  const pollId = setInterval(update, 500);
  update();

  // Return a cleanup function
  return function destroy() {
    clearInterval(pollId);
    if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
  };
}

// --- Legacy backward-compatible exports ---
// The previous version of this module exported a ResilientWebSocket class
// and a State enum. These are preserved so existing tests and consumers
// continue to work.

export const State = Object.freeze({
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  RECONNECTING: 'RECONNECTING',
  FAILED: 'FAILED',
});

export class ResilientWebSocket {
  constructor(url, options = {}) {
    this._url = url;
    this.maxRetries = options.maxRetries ?? 10;
    this.baseDelay = options.baseDelay ?? 1000;
    this.maxDelay = options.maxDelay ?? 30000;
    this.jitterFactor = options.jitterFactor ?? 0.3;
    this.heartbeatInterval = options.heartbeatInterval ?? 25000;

    this._ws = null;
    this._state = State.DISCONNECTED;
    this._retryCount = 0;
    this._retryTimer = null;
    this._heartbeatTimer = null;
    this._closed = false;
    this._lastEventTimestamp = options.lastEventTimestamp
      ? new Date(options.lastEventTimestamp).getTime()
      : null;
    this._queue = [];

    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onstatechange = null;
  }

  get state() {
    return this._state;
  }

  _calcDelay(attempt) {
    const exponential = this.baseDelay * Math.pow(2, attempt);
    const jitter = 1 + Math.random() * this.jitterFactor;
    return Math.min(exponential * jitter, this.maxDelay);
  }

  _setState(newState) {
    if (this._state === newState) return;
    this._state = newState;
    if (typeof this.onstatechange === 'function') {
      try { this.onstatechange(newState); } catch (_) { /* ignore */ }
    }
  }

  async connect() {
    if (this._closed) return;
    if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1)) return;

    this._setState(this._retryCount === 0 ? State.CONNECTING : State.RECONNECTING);

    let url;
    try {
      url = typeof this._url === 'function' ? await this._url() : this._url;
    } catch (_) {
      this._scheduleRetry();
      return;
    }

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (_) {
      this._scheduleRetry();
      return;
    }

    ws.onopen = () => {
      this._retryCount = 0;
      this._setState(State.CONNECTED);
      this._startHeartbeat();
      this._flushQueue();
      this._requestReplay();
      if (typeof this.onopen === 'function') {
        try { this.onopen(); } catch (_) { /* ignore */ }
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this._lastEventTimestamp = data.timestamp
          ? new Date(data.timestamp).getTime()
          : Date.now();
      } catch (_) {
        this._lastEventTimestamp = Date.now();
      }
      if (typeof this.onmessage === 'function') {
        try { this.onmessage(event); } catch (_) { /* ignore */ }
      }
    };

    ws.onclose = () => {
      this._stopHeartbeat();
      this._ws = null;
      if (!this._closed) {
        this._setState(State.DISCONNECTED);
        this._scheduleRetry();
      }
      if (typeof this.onclose === 'function') {
        try { this.onclose(); } catch (_) { /* ignore */ }
      }
    };

    ws.onerror = () => { ws.close(); };
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

  send(data) {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
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

  _requestReplay() {
    if (!this._lastEventTimestamp) return;
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(JSON.stringify({ type: 'replay_request', since: this._lastEventTimestamp }));
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === 1) {
        try { this._ws.send(JSON.stringify({ type: 'heartbeat' })); } catch (_) { /* ignore */ }
      }
    }, this.heartbeatInterval);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

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

// Expose on window for non-module usage (the SPA loads scripts directly)
if (typeof window !== 'undefined') {
  window.SiskelWSReconnect = { createReconnectingWebSocket, renderConnectionIndicator };
}
