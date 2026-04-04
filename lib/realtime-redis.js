/**
 * Redis pub/sub adapter for multi-instance WebSocket realtime sync.
 * Activated when REDIS_URL environment variable is set.
 * Uses the `redis` npm package (optionalDependency) via dynamic import.
 */

/** @type {import('redis').RedisClientType|null} */
let pubClient = null;
/** @type {import('redis').RedisClientType|null} */
let subClient = null;
let ready = false;

const CHANNEL_PREFIX = "siskelbot:ws:";
const PRESENCE_CHANNEL = "siskelbot:presence";

/**
 * Create a Redis pub/sub adapter.
 * @param {string} redisUrl - Redis connection URL (e.g. redis://localhost:6379)
 * @returns {Promise<RedisAdapter|null>} adapter or null if redis package unavailable
 */
export async function createRedisAdapter(redisUrl) {
  let redis;
  try {
    redis = await import("redis");
  } catch {
    console.warn("[realtime-redis] redis package not installed, skipping Redis pub/sub");
    return null;
  }

  try {
    pubClient = redis.createClient({ url: redisUrl });
    subClient = pubClient.duplicate();

    pubClient.on("error", (err) => console.error("[realtime-redis] pub client error:", err.message));
    subClient.on("error", (err) => console.error("[realtime-redis] sub client error:", err.message));

    await Promise.all([pubClient.connect(), subClient.connect()]);
    ready = true;
    console.log("[realtime-redis] connected to", redisUrl);
  } catch (err) {
    console.error("[realtime-redis] failed to connect:", err.message);
    ready = false;
    return null;
  }

  /** @type {Map<string, (message: string) => void>} */
  const subscriptions = new Map();

  const adapter = {
    /**
     * Publish a message to a workspace channel.
     * @param {string} workspaceId
     * @param {object} message - will be JSON-stringified
     */
    async publishWorkspace(workspaceId, message) {
      if (!ready) return;
      try {
        await pubClient.publish(CHANNEL_PREFIX + workspaceId, JSON.stringify(message));
      } catch (err) {
        console.warn("[realtime-redis] publish error:", err.message);
      }
    },

    /**
     * Subscribe to a workspace channel.
     * @param {string} workspaceId
     * @param {(message: object) => void} callback
     */
    async subscribeWorkspace(workspaceId, callback) {
      if (!ready) return;
      const channel = CHANNEL_PREFIX + workspaceId;
      if (subscriptions.has(channel)) return;
      const handler = (message) => {
        try {
          callback(JSON.parse(message));
        } catch {}
      };
      subscriptions.set(channel, handler);
      try {
        await subClient.subscribe(channel, handler);
      } catch (err) {
        console.warn("[realtime-redis] subscribe error:", err.message);
        subscriptions.delete(channel);
      }
    },

    /**
     * Unsubscribe from a workspace channel.
     * @param {string} workspaceId
     */
    async unsubscribeWorkspace(workspaceId) {
      if (!ready) return;
      const channel = CHANNEL_PREFIX + workspaceId;
      if (!subscriptions.has(channel)) return;
      try {
        await subClient.unsubscribe(channel);
      } catch {}
      subscriptions.delete(channel);
    },

    /**
     * Publish a presence update.
     * @param {object} presenceData - { instanceId, workspaceId, userId, displayName, action }
     */
    async publishPresence(presenceData) {
      if (!ready) return;
      try {
        await pubClient.publish(PRESENCE_CHANNEL, JSON.stringify(presenceData));
      } catch (err) {
        console.warn("[realtime-redis] presence publish error:", err.message);
      }
    },

    /**
     * Subscribe to presence updates from other instances.
     * @param {(data: object) => void} callback
     */
    async subscribePresence(callback) {
      if (!ready) return;
      if (subscriptions.has(PRESENCE_CHANNEL)) return;
      const handler = (message) => {
        try {
          callback(JSON.parse(message));
        } catch {}
      };
      subscriptions.set(PRESENCE_CHANNEL, handler);
      try {
        await subClient.subscribe(PRESENCE_CHANNEL, handler);
      } catch (err) {
        console.warn("[realtime-redis] presence subscribe error:", err.message);
        subscriptions.delete(PRESENCE_CHANNEL);
      }
    },

    /**
     * Gracefully close Redis connections.
     */
    async close() {
      ready = false;
      try {
        if (subClient) await subClient.quit();
      } catch {}
      try {
        if (pubClient) await pubClient.quit();
      } catch {}
      pubClient = null;
      subClient = null;
      subscriptions.clear();
      console.log("[realtime-redis] disconnected");
    },

    /** Whether the adapter is connected and ready. */
    get ready() {
      return ready;
    },
  };

  return adapter;
}
