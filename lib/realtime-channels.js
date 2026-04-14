/**
 * Unified realtime channel registry (in-memory).
 *
 * Provides a channel multiplexer so a single WebSocket can carry typed
 * events for chat, agent runs, workspace presence, etc. Each channel has
 * a monotonic sequence number and a bounded backlog, so a client
 * reconnecting can request events it missed via sinceSeq.
 *
 * Dispatch model (wave 2):
 *   publish(channel, payload) enqueues the event into every subscriber's
 *   own bounded FIFO queue and schedules a microtask drain. It does NOT
 *   invoke subscriber callbacks synchronously — so a slow subscriber
 *   cannot stall the publisher. When a subscriber's queue is full, the
 *   oldest pending event for THAT subscriber is dropped and a
 *   slow-subscriber warning hook fires. Errors thrown from subscriber
 *   callbacks are caught and surfaced via onSubscriberError without
 *   affecting peers. Subscribers receive events in publish order.
 *
 * The module is intentionally standalone — it does NOT modify
 * lib/realtime.js or lib/realtime-redis.js. A Redis adapter can be
 * injected later via setRedisAdapter() to fan out across instances; the
 * interface was shaped to match the existing { publishWorkspace,
 * subscribeWorkspace } contract from lib/realtime-redis.js so the
 * adapter can be swapped without changing callers.
 */

const DEFAULT_BACKLOG_SIZE = 500;
const DEFAULT_SUBSCRIBER_QUEUE_CAPACITY = 256;
const SLOW_WARNING_EVERY_N_DROPS = 100;

/**
 * @typedef {object} ChannelEvent
 * @property {number} seq       Monotonic sequence number within the channel.
 * @property {string} channel   Channel id.
 * @property {any} payload      Application payload.
 * @property {number} ts        Publish timestamp (ms since epoch).
 */

/**
 * @typedef {object} SubscriberState
 * @property {string} clientId
 * @property {string} channelId
 * @property {(event: ChannelEvent) => void} onEvent
 * @property {ChannelEvent[]} queue
 * @property {number} queueCapacity
 * @property {boolean} scheduled       Whether a microtask drain is already scheduled.
 * @property {boolean} draining        Reentrancy guard for the drain loop.
 * @property {number} droppedOldest    Cumulative number of oldest events dropped.
 * @property {number} slowWarningsCount Cumulative count of slow warnings emitted.
 * @property {number} maxQueueDepth    High-water mark of this subscriber's queue length.
 */

/**
 * @typedef {object} ChannelState
 * @property {ChannelEvent[]} backlog
 * @property {number} nextSeq
 * @property {Map<string, SubscriberState>} subscribers
 * @property {number} totalDropped     Sum of droppedOldest across lifetime subscribers.
 * @property {number} maxQueueDepth    High-water mark of any subscriber on this channel.
 */

/**
 * @typedef {object} ChannelStatsChannel
 * @property {number} subscribers
 * @property {number} totalDropped
 * @property {number} maxQueueDepth
 */

/**
 * @typedef {object} ChannelRegistry
 * @property {(channelId: string, payload: any) => ChannelEvent} publish
 * @property {(channelId: string, clientId: string, onEvent: (event: ChannelEvent) => void, opts?: { sinceSeq?: number, queueCapacity?: number }) => { channelId: string, replayed: number }} subscribe
 * @property {(channelId: string, clientId: string) => boolean} unsubscribe
 * @property {(clientId: string) => number} unsubscribeAll
 * @property {(channelId: string) => ChannelEvent[]} getBacklog
 * @property {() => { channels: number, subscribers: number, perChannel: Record<string, ChannelStatsChannel> }} stats
 * @property {(adapter: RedisLikeAdapter | null) => void} setRedisAdapter
 * @property {(n: number) => void} setSubscriberQueueCapacity
 * @property {(fn: ((info: { channel: string, clientId: string, droppedCount: number }) => void) | null) => void} setSlowSubscriberHook
 * @property {(fn: ((channel: string, clientId: string, err: any) => void) | null) => void} setSubscriberErrorHook
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
 * @param {number} [opts.subscriberQueueCapacity] default subscriber queue capacity.
 * @returns {ChannelRegistry}
 */
export function createChannelRegistry(opts = {}) {
  const backlogSize = Math.max(1, opts.backlogSize ?? DEFAULT_BACKLOG_SIZE);
  let defaultQueueCapacity = Math.max(
    1,
    opts.subscriberQueueCapacity ?? DEFAULT_SUBSCRIBER_QUEUE_CAPACITY,
  );

  /** @type {Map<string, ChannelState>} */
  const channels = new Map();

  /** @type {RedisLikeAdapter | null} */
  let redisAdapter = null;

  /** @type {Set<string>} channels we've already subscribed to via Redis */
  const redisSubscribedChannels = new Set();

  /** @type {((info: { channel: string, clientId: string, droppedCount: number }) => void) | null} */
  let slowSubscriberHook = null;

  /** @type {((channel: string, clientId: string, err: any) => void) | null} */
  let subscriberErrorHook = null;

  function getOrCreateChannel(channelId) {
    let ch = channels.get(channelId);
    if (!ch) {
      ch = {
        backlog: [],
        nextSeq: 1,
        subscribers: new Map(),
        totalDropped: 0,
        maxQueueDepth: 0,
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

  function emitSlowWarning(sub) {
    if (!slowSubscriberHook) return;
    try {
      slowSubscriberHook({
        channel: sub.channelId,
        clientId: sub.clientId,
        droppedCount: sub.droppedOldest,
      });
    } catch {
      // hook failures must not break dispatch
    }
  }

  function emitSubscriberError(sub, err) {
    if (!subscriberErrorHook) {
      // Keep a diagnostic trail even if no hook is registered so operators
      // aren't blind to broken subscribers. Matches wave-1 behavior.
      try {
        // eslint-disable-next-line no-console
        console.warn(
          "[realtime-channels] subscriber error:",
          err?.message || err,
        );
      } catch {
        // ignore
      }
      return;
    }
    try {
      subscriberErrorHook(sub.channelId, sub.clientId, err);
    } catch {
      // hook failures must not break dispatch
    }
  }

  function scheduleDrain(sub) {
    if (sub.scheduled) return;
    sub.scheduled = true;
    queueMicrotask(() => {
      sub.scheduled = false;
      drainSubscriber(sub);
    });
  }

  function drainSubscriber(sub) {
    if (sub.draining) return;
    sub.draining = true;
    try {
      // Drain everything currently queued. New events published during
      // this drain land in the same queue; because we loop until empty
      // they will be delivered in FIFO order without needing another
      // microtask — but we still honor the scheduled flag for safety
      // with nested publishes.
      while (sub.queue.length > 0) {
        const event = sub.queue.shift();
        try {
          sub.onEvent(event);
        } catch (err) {
          emitSubscriberError(sub, err);
        }
      }
    } finally {
      sub.draining = false;
    }
  }

  function enqueueToSubscriber(sub, event, ch) {
    // Drop-oldest when full. We drop from the head so the newest event
    // is always delivered — consistent with "latest wins" semantics for
    // presence/state updates and still strictly FIFO for whatever
    // remains in the queue.
    if (sub.queue.length >= sub.queueCapacity) {
      sub.queue.shift();
      sub.droppedOldest++;
      if (ch) ch.totalDropped++;
      // First drop always warns; after that, warn every Nth drop so
      // sustained slow subscribers don't spam the hook.
      if (
        sub.droppedOldest === 1 ||
        sub.droppedOldest % SLOW_WARNING_EVERY_N_DROPS === 0
      ) {
        sub.slowWarningsCount++;
        emitSlowWarning(sub);
      }
    }
    sub.queue.push(event);
    if (sub.queue.length > sub.maxQueueDepth) {
      sub.maxQueueDepth = sub.queue.length;
      if (ch && sub.maxQueueDepth > ch.maxQueueDepth) {
        ch.maxQueueDepth = sub.maxQueueDepth;
      }
    }
    scheduleDrain(sub);
  }

  function fanOut(ch, event) {
    for (const sub of ch.subscribers.values()) {
      enqueueToSubscriber(sub, event, ch);
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
    const queueCapacity = Math.max(
      1,
      Number.isFinite(opts2.queueCapacity)
        ? Number(opts2.queueCapacity)
        : defaultQueueCapacity,
    );
    /** @type {SubscriberState} */
    const sub = {
      clientId,
      channelId,
      onEvent,
      queue: [],
      queueCapacity,
      scheduled: false,
      draining: false,
      droppedOldest: 0,
      slowWarningsCount: 0,
      maxQueueDepth: 0,
    };
    ch.subscribers.set(clientId, sub);

    let replayed = 0;
    const sinceSeq = Number.isFinite(opts2.sinceSeq) ? Number(opts2.sinceSeq) : null;
    if (sinceSeq != null) {
      // Route replay through the same per-subscriber queue so a slow
      // subscriber cannot race the live stream against its backlog.
      for (const ev of ch.backlog) {
        if (ev.seq > sinceSeq) {
          enqueueToSubscriber(sub, ev, ch);
          replayed++;
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
    const sub = ch.subscribers.get(clientId);
    const ok = ch.subscribers.delete(clientId);
    if (sub) {
      // Drop any queued but undelivered events so we don't fire them
      // after unsubscribe. A microtask drain may still be scheduled; it
      // becomes a no-op because the queue is empty.
      sub.queue.length = 0;
    }
    if (ch.subscribers.size === 0 && ch.backlog.length === 0) {
      channels.delete(channelId);
    }
    return ok;
  }

  /** @type {ChannelRegistry['unsubscribeAll']} */
  function unsubscribeAll(clientId) {
    let removed = 0;
    for (const [channelId, ch] of channels.entries()) {
      const sub = ch.subscribers.get(clientId);
      if (sub) sub.queue.length = 0;
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
    /** @type {Record<string, ChannelStatsChannel>} */
    const perChannel = {};
    for (const [channelId, ch] of channels.entries()) {
      subscribers += ch.subscribers.size;
      perChannel[channelId] = {
        subscribers: ch.subscribers.size,
        totalDropped: ch.totalDropped,
        maxQueueDepth: ch.maxQueueDepth,
      };
    }
    return { channels: channels.size, subscribers, perChannel };
  }

  /** @type {ChannelRegistry['setRedisAdapter']} */
  function setRedisAdapter(adapter) {
    redisAdapter = adapter || null;
    redisSubscribedChannels.clear();
  }

  /** @type {ChannelRegistry['setSubscriberQueueCapacity']} */
  function setSubscriberQueueCapacity(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 1) {
      throw new Error("queue capacity must be a positive integer");
    }
    defaultQueueCapacity = Math.floor(v);
  }

  /** @type {ChannelRegistry['setSlowSubscriberHook']} */
  function setSlowSubscriberHook(fn) {
    if (fn != null && typeof fn !== "function") {
      throw new Error("slow subscriber hook must be a function or null");
    }
    slowSubscriberHook = fn || null;
  }

  /** @type {ChannelRegistry['setSubscriberErrorHook']} */
  function setSubscriberErrorHook(fn) {
    if (fn != null && typeof fn !== "function") {
      throw new Error("subscriber error hook must be a function or null");
    }
    subscriberErrorHook = fn || null;
  }

  return {
    publish,
    subscribe,
    unsubscribe,
    unsubscribeAll,
    getBacklog,
    stats,
    setRedisAdapter,
    setSubscriberQueueCapacity,
    setSlowSubscriberHook,
    setSubscriberErrorHook,
  };
}

// A module-level default registry for callers that don't want to pass
// their own instance around. Tests should prefer createChannelRegistry().
export const defaultChannelRegistry = createChannelRegistry();

export const DEFAULT_CHANNEL_BACKLOG_SIZE = DEFAULT_BACKLOG_SIZE;
export const DEFAULT_CHANNEL_SUBSCRIBER_QUEUE_CAPACITY = DEFAULT_SUBSCRIBER_QUEUE_CAPACITY;
