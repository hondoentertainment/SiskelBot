/**
 * Unified realtime channel registry (in-memory).
 *
 * Provides a channel multiplexer so a single WebSocket can carry typed
 * events for chat, agent runs, workspace presence, etc. Each channel has
 * a monotonic sequence number and a bounded backlog, so a client
 * reconnecting can request events it missed via sinceSeq.
 *
 * The module is intentionally standalone — it does NOT modify
 * lib/realtime.js or lib/realtime-redis.js. A Redis adapter can be
 * injected later via setRedisAdapter() to fan out across instances; the
 * interface was shaped to match the existing { publishWorkspace,
 * subscribeWorkspace } contract from lib/realtime-redis.js so the
 * adapter can be swapped without changing callers.
 */

const DEFAULT_BACKLOG_SIZE = 500;

/**
 * @typedef {object} ChannelEvent
 * @property {number} seq       Monotonic sequence number within the channel.
 * @property {string} channel   Channel id.
 * @property {any} payload      Application payload.
 * @property {number} ts        Publish timestamp (ms since epoch).
 */

/**
 * @typedef {object} ChannelState
 * @property {ChannelEvent[]} backlog
 * @property {number} nextSeq
 * @property {Map<string, (event: ChannelEvent) => void>} subscribers
 */

/**
 * @typedef {object} ChannelRegistry
 * @property {(channelId: string, payload: any) => ChannelEvent} publish
 * @property {(channelId: string, clientId: string, onEvent: (event: ChannelEvent) => void, opts?: { sinceSeq?: number }) => { channelId: string, replayed: number }} subscribe
 * @property {(channelId: string, clientId: string) => boolean} unsubscribe
 * @property {(clientId: string) => number} unsubscribeAll
 * @property {(channelId: string) => ChannelEvent[]} getBacklog
 * @property {() => { channels: number, subscribers: number }} stats
 * @property {(adapter: RedisLikeAdapter | null) => void} setRedisAdapter
 */

/**
 * @typedef {object} RedisLikeAdapter
 * @property {(channelId: string, message: any) => Promise<void> | void} [publish]
 * @property {(channelId: string, callback: (message: any) => void) => Promise<void> | void} [subscribe]
 * @property {(channelId: string) => Promise<void> | void} [unsubscribe]
 */

/**
 * Create a new channel registry. Exported so tests can isolate state.
 *
 * @param {object} [opts]
 * @param {number} [opts.backlogSize] max events retained per channel.
 * @returns {ChannelRegistry}
 */
export function createChannelRegistry(opts = {}) {
  const backlogSize = Math.max(1, opts.backlogSize ?? DEFAULT_BACKLOG_SIZE);

  /** @type {Map<string, ChannelState>} */
  const channels = new Map();

  /** @type {RedisLikeAdapter | null} */
  let redisAdapter = null;

  /** @type {Set<string>} channels we've already subscribed to via Redis */
  const redisSubscribedChannels = new Set();

  function getOrCreateChannel(channelId) {
    let ch = channels.get(channelId);
    if (!ch) {
      ch = {
        backlog: [],
        nextSeq: 1,
        subscribers: new Map(),
      };
      channels.set(channelId, ch);
    }
    return ch;
  }

  function appendToBacklog(ch, event) {
    ch.backlog.push(event);
    if (ch.backlog.length > backlogSize) {
      ch.backlog.splice(0, ch.backlog.length - backlogSize);
    }
  }

  function fanOut(ch, event) {
    for (const onEvent of ch.subscribers.values()) {
      try {
        onEvent(event);
      } catch (err) {
        // Subscribers must not break the publish path.
        // eslint-disable-next-line no-console
        console.warn("[realtime-channels] subscriber error:", err?.message || err);
      }
    }
  }

  /** @type {ChannelRegistry['publish']} */
  function publish(channelId, payload) {
    if (!channelId || typeof channelId !== "string") {
      throw new Error("channelId must be a non-empty string");
    }
    const ch = getOrCreateChannel(channelId);
    const event = {
      seq: ch.nextSeq++,
      channel: channelId,
      payload,
      ts: Date.now(),
    };
    appendToBacklog(ch, event);
    fanOut(ch, event);
    if (redisAdapter && typeof redisAdapter.publish === "function") {
      try {
        Promise.resolve(redisAdapter.publish(channelId, event)).catch(() => {});
      } catch {
        // never let redis failures break in-process delivery
      }
    }
    return event;
  }

  /** @type {ChannelRegistry['subscribe']} */
  function subscribe(channelId, clientId, onEvent, opts2 = {}) {
    if (!channelId || typeof channelId !== "string") {
      throw new Error("channelId must be a non-empty string");
    }
    if (!clientId || typeof clientId !== "string") {
      throw new Error("clientId must be a non-empty string");
    }
    if (typeof onEvent !== "function") {
      throw new Error("onEvent must be a function");
    }
    const ch = getOrCreateChannel(channelId);
    ch.subscribers.set(clientId, onEvent);

    let replayed = 0;
    const sinceSeq = Number.isFinite(opts2.sinceSeq) ? Number(opts2.sinceSeq) : null;
    if (sinceSeq != null) {
      for (const ev of ch.backlog) {
        if (ev.seq > sinceSeq) {
          try {
            onEvent(ev);
            replayed++;
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("[realtime-channels] replay error:", err?.message || err);
          }
        }
      }
    }

    // Lazy-register a Redis subscription for this channel so events
    // published from other instances are fanned in locally. The adapter
    // is expected to deduplicate if needed; it's a no-op when absent.
    if (
      redisAdapter &&
      typeof redisAdapter.subscribe === "function" &&
      !redisSubscribedChannels.has(channelId)
    ) {
      redisSubscribedChannels.add(channelId);
      try {
        Promise.resolve(
          redisAdapter.subscribe(channelId, (remoteEvent) => {
            // Route remote events through local fan-out without re-appending
            // to the backlog if they already carry a seq; otherwise assign
            // a local seq so our clients get contiguous numbering.
            const local = getOrCreateChannel(channelId);
            const event =
              remoteEvent && typeof remoteEvent.seq === "number"
                ? remoteEvent
                : {
                    seq: local.nextSeq++,
                    channel: channelId,
                    payload: remoteEvent?.payload ?? remoteEvent,
                    ts: remoteEvent?.ts ?? Date.now(),
                  };
            appendToBacklog(local, event);
            fanOut(local, event);
          }),
        ).catch(() => {});
      } catch {
        // ignore adapter failures
      }
    }

    return { channelId, replayed };
  }

  /** @type {ChannelRegistry['unsubscribe']} */
  function unsubscribe(channelId, clientId) {
    const ch = channels.get(channelId);
    if (!ch) return false;
    const ok = ch.subscribers.delete(clientId);
    if (ch.subscribers.size === 0 && ch.backlog.length === 0) {
      channels.delete(channelId);
    }
    return ok;
  }

  /** @type {ChannelRegistry['unsubscribeAll']} */
  function unsubscribeAll(clientId) {
    let removed = 0;
    for (const [channelId, ch] of channels.entries()) {
      if (ch.subscribers.delete(clientId)) removed++;
      if (ch.subscribers.size === 0 && ch.backlog.length === 0) {
        channels.delete(channelId);
      }
    }
    return removed;
  }

  /** @type {ChannelRegistry['getBacklog']} */
  function getBacklog(channelId) {
    const ch = channels.get(channelId);
    return ch ? ch.backlog.slice() : [];
  }

  /** @type {ChannelRegistry['stats']} */
  function stats() {
    let subscribers = 0;
    for (const ch of channels.values()) subscribers += ch.subscribers.size;
    return { channels: channels.size, subscribers };
  }

  /** @type {ChannelRegistry['setRedisAdapter']} */
  function setRedisAdapter(adapter) {
    redisAdapter = adapter || null;
    redisSubscribedChannels.clear();
  }

  return {
    publish,
    subscribe,
    unsubscribe,
    unsubscribeAll,
    getBacklog,
    stats,
    setRedisAdapter,
  };
}

// A module-level default registry for callers that don't want to pass
// their own instance around. Tests should prefer createChannelRegistry().
export const defaultChannelRegistry = createChannelRegistry();

export const DEFAULT_CHANNEL_BACKLOG_SIZE = DEFAULT_BACKLOG_SIZE;
