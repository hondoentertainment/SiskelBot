# Agent Web wiring instructions

Per worktree rules, the wave 1 web-interface agents did not modify `server.js`
or `routes/index.js` directly. This document collects the one-line-ish wiring
snippets each new module needs to be fully active.

## Realtime (unified WebSocket)

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

Then, after `const httpServer = app.listen(PORT, ...)` (or wherever the HTTP
server handle is available — the existing `attachToServer(httpServer)` call
from `lib/realtime.js` is the right neighborhood), add:

```js
mountRealtimeWs(httpServer, { channels: defaultChannelRegistry });
```

The handler shares the HTTP server's `upgrade` event with existing `/ws` and
`/ws/voice` handlers — paths are namespaced so they coexist safely.

### Auth

Accepts the existing one-time token from `GET /api/ws-token` (reused via
`lib/realtime.js` `consumeToken`). For richer auth (decoding the session
cookie for WS upgrades), pass a `resolveWsAuth` function in deps:

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

### Optional Redis fan-out

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

### Tests

- `tests/realtime-channels.test.js` — 14 pure unit tests.
- `tests/realtime-ws.test.js` — 6 integration tests that skip when `ws` is not installed.

---

## Agent Run Stream

A SSE-backed route surfaces the Agent Run hero UI (Plan / Timeline / Artifacts
/ Approvals) for a single agent session.

### New files

- `lib/agent-run-stream.js` — `streamAgentRun({ sessionId, res, req, ... })`, plus `getAgentRunEmitter(sessionId)` / `publishAgentRunEvent(sessionId, type, payload)` for agent-loop callsites to push live events.
- `routes/agent-run-stream.js` — exports `mountAgentRunStreamRoutes(app, deps)`.
- `client/src/views/agent-run.js` — default export `mount(el, { sessionId, apiBase })`.
- `client/src/views/agent-run.css`.

### Route

`GET /api/v1/agent/sessions/:sessionId/stream` (legacy alias
`GET /api/agent/sessions/:sessionId/stream` with the standard
`X-API-Deprecated` header via `apiRoute`).

Middleware chain matches `routes/agent-sessions.js`:
`logRequest → userAuth → requireScope("read") → handler`.

### Event schema

| Event type       | Payload fields (typical)                                          |
|------------------|-------------------------------------------------------------------|
| `plan.update`    | `summary`, `planDag?` or `nodes?`                                  |
| `tool.call`      | `tool` / `name`, `arguments`, `runId`                              |
| `tool.result`    | `tool` / `name`, `result`, `runId`                                 |
| `hitl.request`   | `approvalId`, `tool`, `summary`, `detail`                          |
| `hitl.resolved`  | `approvalId`, `decision`                                           |
| `artifact.new`   | `id`, `name`, `mime`, `url?`, `content?`                           |
| `cost.update`    | `totalUsd` (or `costUsd`), `tokens?`                               |
| `status.change`  | `status`, `kind?`                                                  |
| `done`           | (terminal; closes the stream)                                      |

### Wiring into `routes/index.js`

```js
import { mountAgentRunStreamRoutes } from "./agent-run-stream.js";
// ...and append to mountFunctions:
mountAgentRunStreamRoutes,
```

### Integration points for live events

`publishAgentRunEvent(sessionId, type, payload)` should be called from:

- `lib/agent-loop.js` on iteration start/end → `status.change`, `done`
- `lib/agent-loop-execute-tools.js` around tool execution → `tool.call`, `tool.result`
- `lib/agent-hitl-store.js` on save / take → `hitl.request`, `hitl.resolved`
- A cost/usage hook → `cost.update`
- A future artifact sink → `artifact.new`

Historical events are backfilled on connect.

---

## Replay & Share

Tokenized, shareable, read-only replay of agent runs.

### New files

- `lib/replay-tokens.js` — `mintReplayToken`, `verifyReplayToken`, `revokeReplayToken`.
- `routes/replay.js` — exports `mountReplayRoutes(app, deps)`.
- `client/src/views/replay.js` — default export `mount(el, { token })`.
- `client/src/views/replay.css`.

### Environment

| Variable | Purpose |
|----------|---------|
| `REPLAY_TOKEN_SECRET` | HMAC signing key for replay tokens (preferred). |
| `SESSION_SECRET` | Used as a fallback when `REPLAY_TOKEN_SECRET` is unset. |
| `REPLAY_REVOKED_MAX` | Optional cap on persisted revocations (default 10 000). |

### Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST   | `/api/v1/agent/sessions/:id/share` | `userAuth` + `write` scope | Mint a token. |
| DELETE | `/api/v1/agent/sessions/:id/share/:token` | `userAuth` + `write` scope | Revoke. |
| GET    | `/r/:token` | Public (token-gated) | HTML page that mounts the replay view. |
| GET    | `/api/v1/replay/:token/events` | Public (token-gated) | Trajectory JSON. |

### Wiring into `routes/index.js`

```js
import { mountReplayRoutes } from "./replay.js";
// ...and append to mountFunctions:
mountReplayRoutes,
```

Token TTL is clamped to `[60s, 30 days]`; default 7 days.

---

## SPA shell / router / palette

Pure client-side; no server wiring required beyond serving `client/app.html`.
`client/app.html` is served statically alongside the existing `client/*.html`
set. The new shell is opt-in via direct navigation; legacy pages are
unaffected.

### Integration plan (deferred)

1. Wire `client/app.html` at `/app` (or eventually `/`) once the placeholder
   views (home, chat, runs, knowledge, recipes) are real.
2. Convert existing HTML pages into views that the shell lazy-imports.
3. Retire the 62-HTML-file model.

### Tests

- `tests/client-shell-router.test.js` — 12 unit tests for router resolution.
- `tests/client-shell-palette.test.js` — 13 unit tests for fuzzy filter/score.
