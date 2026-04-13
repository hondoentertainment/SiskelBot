/**
 * Browser client for the unified realtime WebSocket layer.
 *
 * Usage:
 *   const rt = new RealtimeClient({ url: "/ws/realtime" });
 *   rt.connect();
 *   rt.subscribe("chat:42", (ev) => console.log(ev), { resume: true });
 *   // ...
 *   rt.unsubscribe("chat:42");
 *   rt.close();
 *
 * Features:
 *   - One WebSocket per tab, multiplexing many channels.
 *   - Exponential-backoff reconnect (1s, 2s, 4s, 8s, max 30s).
 *   - On reconnect, automatically re-subscribes to every active channel
 *     with sinceSeq=<last received seq> so the server replays missed
 *     events from its bounded backlog.
 *   - 20s heartbeat ping to keep proxies from idling the socket.
 *   - Works in the browser (uses global WebSocket). In Node tests you
 *     can pass a { wsCtor } option pointing at the `ws` package.
 */

import {
  CLIENT_SUBSCRIBE,
  CLIENT_UNSUBSCRIBE,
  CLIENT_PING,
  SERVER_EVENT,
  SERVER_ACK,
  SERVER_PONG,
  SERVER_ERROR,
} from "./events.js";

const DEFAULT_HEARTBEAT_MS = 20_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * @typedef {object} RealtimeClientOptions
 * @property {string} url              Absolute or relative WS URL.
 * @property {*} [wsCtor]              Optional WebSocket constructor (for tests).
 * @property {number} [heartbeatMs]    Heartbeat interval in ms (default 20000).
 * @property {(err: any) => void} [onError]
 * @property {(state: "connecting"|"open"|"closed"|"reconnecting") => void} [onStateChange]
 */

export class RealtimeClient {
  /** @param {RealtimeClientOptions} opts */
  constructor(opts) {
    if (!opts || !opts.url) throw new Error("RealtimeClient: url is required");
    this.url = opts.url;
    this._wsCtor =
      opts.wsCtor ||
      (typeof globalThis !== "undefined" ? globalThis.WebSocket : undefined);
    if (!this._wsCtor) {
      throw new Error("RealtimeClient: no WebSocket implementation available");
    }
    this._heartbeatMs = Number.isFinite(opts.heartbeatMs) ? opts.heartbeatMs : DEFAULT_HEARTBEAT_MS;
    this._onError = opts.onError || (() => {});
    this._onStateChange = opts.onStateChange || (() => {});

    /** @type {Map<string, { handler: (event: any) => void, lastSeq: number, resume: boolean }>} */
    this._subs = new Map();
    /** @type {WebSocket | null} */
    this._ws = null;
    this._closed = false;
    this._reconnectAttempt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._reconnectTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._heartbeatTimer = null;
  }

  connect() {
    if (this._closed) return;
    if (this._ws) return;
    this._setState("connecting");
    let ws;
    try {
      ws = new this._wsCtor(this.url);
    } catch (err) {
      this._onError(err);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.addEventListener
      ? ws.addEventListener("open", () => this._onOpen())
      : (ws.onopen = () => this._onOpen());
    ws.addEventListener
      ? ws.addEventListener("message", (ev) => this._onMessage(ev))
      : (ws.onmessage = (ev) => this._onMessage(ev));
    ws.addEventListener
      ? ws.addEventListener("close", () => this._onClose())
      : (ws.onclose = () => this._onClose());
    ws.addEventListener
      ? ws.addEventListener("error", (err) => this._onErr(err))
      : (ws.onerror = (err) => this._onErr(err));
  }

  /**
   * Subscribe to a channel. handler is invoked with
   * { channel, seq, payload, ts } for each event. If resume is true
   * (default) the client remembers lastSeq and re-subscribes with
   * sinceSeq on reconnect so no events are dropped.
   *
   * @param {string} channel
   * @param {(event: { channel: string, seq: number, payload: any, ts: number }) => void} handler
   * @param {{ resume?: boolean }} [opts]
   */
  subscribe(channel, handler, opts = {}) {
    if (typeof channel !== "string" || !channel) throw new Error("channel required");
    if (typeof handler !== "function") throw new Error("handler required");
    const resume = opts.resume !== false;
    const existing = this._subs.get(channel);
    this._subs.set(channel, {
      handler,
      lastSeq: existing ? existing.lastSeq : 0,
      resume,
    });
    if (this._ws && this._ws.readyState === 1) {
      this._send({
        type: CLIENT_SUBSCRIBE,
        channel,
        sinceSeq: existing && resume ? existing.lastSeq : undefined,
      });
    }
  }

  /** @param {string} channel */
  unsubscribe(channel) {
    if (!this._subs.has(channel)) return;
    this._subs.delete(channel);
    if (this._ws && this._ws.readyState === 1) {
      this._send({ type: CLIENT_UNSUBSCRIBE, channel });
    }
  }

  close() {
    this._closed = true;
    this._clearTimers();
    if (this._ws) {
      try { this._ws.close(); } catch { /* ignore */ }
      this._ws = null;
    }
    this._setState("closed");
  }

  // ---- internals ----

  _onOpen() {
    this._reconnectAttempt = 0;
    this._setState("open");
    // Re-subscribe to every channel; if resume is enabled, pass sinceSeq.
    for (const [channel, entry] of this._subs.entries()) {
      this._send({
        type: CLIENT_SUBSCRIBE,
        channel,
        sinceSeq: entry.resume ? entry.lastSeq : undefined,
      });
    }
    this._startHeartbeat();
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === SERVER_EVENT) {
      const entry = this._subs.get(msg.channel);
      if (!entry) return;
      if (typeof msg.seq === "number" && msg.seq > entry.lastSeq) {
        entry.lastSeq = msg.seq;
      }
      try {
        entry.handler({
          channel: msg.channel,
          seq: msg.seq,
          payload: msg.payload,
          ts: msg.ts,
        });
      } catch (err) {
        this._onError(err);
      }
      return;
    }
    if (msg.type === SERVER_PONG) return;
    if (msg.type === SERVER_ACK) return;
    if (msg.type === SERVER_ERROR) {
      this._onError(new Error(`[realtime] ${msg.code || "ERROR"}: ${msg.message || ""}`));
      return;
    }
  }

  _onClose() {
    this._ws = null;
    this._clearTimers();
    if (this._closed) {
      this._setState("closed");
      return;
    }
    this._setState("reconnecting");
    this._scheduleReconnect();
  }

  _onErr(err) {
    this._onError(err?.error || err);
  }

  _scheduleReconnect() {
    if (this._closed) return;
    const attempt = this._reconnectAttempt++;
    const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * Math.pow(2, attempt));
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === 1) {
        this._send({ type: CLIENT_PING });
      }
    }, this._heartbeatMs);
    if (typeof this._heartbeatTimer?.unref === "function") {
      this._heartbeatTimer.unref();
    }
  }

  _clearHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _clearTimers() {
    this._clearHeartbeat();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _send(msg) {
    try {
      this._ws.send(JSON.stringify(msg));
    } catch (err) {
      this._onError(err);
    }
  }

  _setState(state) {
    try { this._onStateChange(state); } catch { /* ignore */ }
  }
}

export default RealtimeClient;
