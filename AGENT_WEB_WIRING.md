# Agent Web: wiring instructions for `server.js`

Per the worktree rules, `server.js` was NOT modified. This document describes
the one-line-ish wiring snippet needed to turn on the unified realtime
WebSocket handler introduced in this change.

## Realtime

### New files

- `lib/realtime-channels.js` — in-memory channel registry (publish / subscribe / bounded backlog / resume by `sinceSeq`). Optional Redis adapter via `setRedisAdapter({ publish, subscribe })`.
- `routes/realtime-ws.js` — `mountRealtimeWs(httpServer, deps)` mounts a `WebSocketServer` at `/ws/realtime` that multiplexes channels over a single socket per tab.
- `client/src/realtime/events.js` — shared protocol constants.
- `client/src/realtime/client.js` — browser `RealtimeClient` (auto-reconnect with exponential backoff, 20s heartbeat, resume per channel).

### Wiring snippet for `server.js`

Add the imports alongside the other route-module imports:

```js
import { mountRealtimeWs } from "./routes/realtime-ws.js";
import { defaultChannelRegistry } from "./lib/realtime-channels.js";
```

Then, **after** `const httpServer = app.listen(PORT, ...)` (or wherever the
HTTP server handle is available — the existing `attachToServer(httpServer)`
call from `lib/realtime.js` is the right neighborhood), add:

```js
mountRealtimeWs(httpServer, { channels: defaultChannelRegistry });
```

That's the full wiring. The handler shares the HTTP server's `upgrade` event
with the existing `/ws` and `/ws/voice` handlers — paths are namespaced so
they coexist safely.

### Auth

The handler accepts the existing one-time token from `GET /api/ws-token`
(reused via `lib/realtime.js` `consumeToken`). For richer auth (decoding the
session cookie for WS upgrades), pass a `resolveWsAuth` function in deps:

```js
mountRealtimeWs(httpServer, {
  channels: defaultChannelRegistry,
  resolveWsAuth: async (request) => {
    // TODO: decode session cookie via the shared express-session store
    // and return { userId, workspaceId } or null.
    return null;
  },
});
```

When `resolveWsAuth` is omitted and no token/auth is configured, the handler
falls back to the `anonymous` user (matching `lib/auth.js` `userAuth`
semantics).

### Publishing events

Any module that already has a `workspaceId`, `conversationId`, or
`runId` can publish to a channel:

```js
import { defaultChannelRegistry } from "./lib/realtime-channels.js";

defaultChannelRegistry.publish(`chat:${conversationId}`, { role: "assistant", delta: "..." });
defaultChannelRegistry.publish(`run:${sessionId}`, { type: "tool_call", name: "search_context" });
defaultChannelRegistry.publish(`presence:${workspaceId}`, { type: "join", userId });
```

Suggested channel conventions (see `client/src/realtime/events.js`):

- `chat:<conversationId>` — streaming chat deltas / tool-call events
- `run:<agentSessionId>` — agent session lifecycle events
- `presence:<workspaceId>` — join / leave / cursor updates

### Optional Redis fan-out across instances

`lib/realtime-channels.js` accepts a minimal adapter matching the shape
already exposed by `lib/realtime-redis.js`:

```js
import { createRedisAdapter } from "./lib/realtime-redis.js";
import { defaultChannelRegistry } from "./lib/realtime-channels.js";

const redis = await createRedisAdapter(process.env.REDIS_URL);
if (redis) {
  defaultChannelRegistry.setRedisAdapter({
    publish: (channel, event) => redis.publishWorkspace(channel, event),
    subscribe: (channel, cb) => redis.subscribeWorkspace(channel, cb),
  });
}
```

This is a zero-modification hook — `lib/realtime-redis.js` itself stays
untouched.

### Tests

- `tests/realtime-channels.test.js` — 14 pure unit tests (publish / subscribe / backlog / resume / unsubscribe / eviction / multi-subscriber / adapter / validation).
- `tests/realtime-ws.test.js` — 6 integration tests that spin up a real `http.Server`, connect with the `ws` client, and verify end-to-end subscribe/unsubscribe/ping/reconnect-with-`sinceSeq`. These tests skip cleanly when `ws` is not installed in `node_modules` (they will run under CI where dependencies are installed).
