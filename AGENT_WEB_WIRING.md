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

---

## Signals

Read-only aggregator that powers the "signal strip" rendered under the chat
composer (backend + model, rolling cost estimate, p50 latency, quality score,
circuit-breaker pip). The strip polls the endpoint every 10 seconds.

### New files

- `routes/signals.js` — exports `mountSignalsRoutes(app, deps)`. Reads from
  `lib/usage-tracker.js`, `lib/model-quality.js`, `lib/smart-router.js`, and
  `lib/circuit-breaker.js`. No new storage or computation.
- `client/signal-strip.js` — module that finds the composer anchor
  (`form#chat-form` → `#prompt` fallback), injects a `<div class="signal-strip">`
  as its previousElementSibling, and polls `GET /api/v1/signals/composer`.
  Exports a pure `format` helper for tests.

### Route

`GET /api/v1/signals/composer` — returns:

```json
{
  "backend": "openai",
  "model": "gpt-4o-mini",
  "estCostUsd": 0.003,
  "p50LatencyMs": 1420,
  "qualityScore": 0.82,
  "breakerState": "closed",
  "updatedAt": "2026-04-14T00:00:00.000Z"
}
```

### Wiring into `routes/index.js`

```js
import { mountSignalsRoutes } from "./signals.js";
// ...and append to mountFunctions:
mountSignalsRoutes,
```

### Client include

Already appended to `client/index.html` alongside the existing script loads
(single `<script type="module" src="/signal-strip.js"></script>` line after
`/js/ot-client.js`). Served by the existing `express.static("client")`
handler, no extra route needed.

### TODOs

- `estCostUsd` currently approximates per-request cost as
  `avgTokensPerRequest * costPer1K / 1000` using `lib/smart-router.js`
  `getModelCost()`. Switch to a recorded per-request `costUsd` if
  `lib/usage-tracker.js` grows one.
- `breakerState` reports only `closed`/`open`. Expose `half_open` if
  `lib/circuit-breaker.js` gains a tri-state API.

### Tests

- `tests/signals-route.test.js` — mounts `mountSignalsRoutes` on a minimal
  Express app and asserts the 200 response shape.
- `tests/signal-strip-render.test.js` — pure unit tests for the
  `format()` helper (cost / latency / quality / backend-model / breaker).

---

## Build pipeline

`scripts/build-client.mjs` bundles the `client/src/` module tree with esbuild
(format `esm`, splitting enabled, sourcemaps on) into `client/dist/`.

### Commands

| Command | Description |
|---------|-------------|
| `npm run build:client` | One-shot production build (minified). |
| `npm run build:client:watch` | Rebuild on change (dev, unminified). |
| `npm run build:client:legacy` | Previous concat-and-copy script, still used by `prestart`. |

Entry points bundled:

- `client/src/app.js` → `client/dist/app.js`
- `client/src/views/agent-run.js` → `client/dist/agent-run.js`
- `client/src/views/replay.js` → `client/dist/replay.js`

A `client/dist/manifest.json` is written mapping each logical entry name to its
final `/dist/...` path (with hashed chunk filenames for cache-busting). Shared
code is split into `client/dist/chunks/*.js`.

### Serving in `client/app.html`

The shell agent owns `client/app.html`. To switch from the unbundled
development layout to the bundled production layout, change:

```html
<script type="module" src="/src/app.js"></script>
```

to:

```html
<script type="module" src="/dist/app.js"></script>
```

View-level entries (`agent-run.js`, `replay.js`) follow the same pattern.
Keep the unbundled path during local development so source edits are
immediately visible without re-running the bundler.

### Fallback

If esbuild is ever uninstalled, `scripts/build-client.mjs` copies `client/src/`
to `client/dist/` verbatim (no bundling, no minification) so
`/dist/app.js` still resolves. Re-install esbuild
(`npm install --save-dev esbuild`) to restore real bundling.

### Tests

- `tests/build-client.test.js` — runs the build script as a child process,
  asserts `client/dist/app.js` is produced with exit code 0. Skips cleanly if
  esbuild is unavailable.

---

## Observability snapshot

In-app observability view that surfaces trajectories, circuit-breaker state,
slow routes, and pool health for non-ops users.

### New files

- `routes/observability-snapshot.js` — `mountObservabilitySnapshotRoutes(app, deps)`. Calls `lib/circuit-breaker.js` (`isOpen`), `lib/observability.js` (`getLatencyPercentiles`, `getErrorRates`), `lib/trace-recorder.js` (`listTraces`), and `lib/pool-health.js` (`getPoolStats`); no new business logic lives in the route.
- `client/src/views/observability.js` — default export `mount(el, opts?)`. Polls the snapshot endpoint every 5s. Renders 4 cards (Breakers, Slow Routes, Recent Trajectories, Pool & Rates) with red color-coded cells for open breakers, p95 over 500ms, waiting pool clients, and non-zero error rate. Exports pure helpers `formatDuration`, `formatBreakerRow`, `sortBySlowest` for tests.
- `client/src/views/observability.css` — dark theme (`#0f172a / #e2e8f0 / #60a5fa`) matching `client/src/views/agent-run.css`.

### Route

`GET /api/v1/observability/snapshot` (plus legacy `/api/` alias via `apiRoute`).

Middleware chain matches `routes/agent-sessions.js`:
`logRequest → userAuth → requireScope("read") → handler`.

### Response shape

```json
{
  "breakers": [
    { "name": "ollama", "state": "closed", "failures": 0, "lastFailureAt": null }
  ],
  "slowRoutes": [
    { "route": "GET /api/v1/chat", "p95Ms": 842, "p50Ms": 120, "hits": 57 }
  ],
  "recentTrajectories": [
    { "runId": "abc-123", "startedAt": "2026-04-14T00:00:00.000Z", "steps": 8, "status": "complete" }
  ],
  "pool": { "dbConnections": 10, "inUse": 3, "waiting": 0 },
  "uptimeSec": 1234,
  "requestsPerMinute": 12.5,
  "errorsPerMinute": 0.1
}
```

### Stubbed fields

The public `lib/circuit-breaker.js` API only exposes `isOpen(backend)`, so
`failures` is reported as `0` and `lastFailureAt` as `null`. A `TODO` in
`routes/observability-snapshot.js` points at the richer snapshot API that
should land alongside a `getBreakerSnapshot()` export. The pool block is
also zeroed out when no Postgres pool is registered (JSON/SQLite backends).

### Wiring into `routes/index.js`

```js
import { mountObservabilitySnapshotRoutes } from "./observability-snapshot.js";
// ...and append to mountFunctions:
mountObservabilitySnapshotRoutes,
```

No changes to `server.js` are required — snapshot rendering is pull-based
and reuses the existing observability in-memory aggregator populated by
the request-timing middleware.

### Tests

- `tests/observability-snapshot-route.test.js` — mounts the handler on a
  minimal Express app; asserts 200 with the correct shape and that auth is
  enforced.
- `tests/observability-view.test.js` — unit tests for the pure formatting
  helpers (`formatDuration`, `formatBreakerRow`, `sortBySlowest`) exported
  from the view. No JSDOM required.

---

## Chat + presence publication

Streaming chat deltas and workspace presence join/leave events are also
fanned out through `defaultChannelRegistry` so the unified realtime client
(`client/src/realtime/client.js`) can subscribe without opening a separate
transport. Publication is **strictly additive** — existing SSE clients on
`/v1/chat/completions` and existing WebSocket clients on `/ws` see
unchanged output. Every publish call is wrapped in `try / catch` so a
subscriber throwing, or the registry being unavailable, never interrupts
the response or the WS lifecycle.

### Channels

| Channel | Published by | Event payload shape |
|---------|--------------|---------------------|
| `chat:<conversationId>` | `lib/llm-stream-sse.js` (swarm-synthesis path) and `routes/chat.js` (main streaming proxy path) | `{ role: "assistant", delta: string, index: number }` |
| `presence:<workspaceId>` | `lib/realtime.js` (`publishPresenceEvent`) on WS join / disconnect | `{ type: "join" \| "leave", userId: string, ts: number }` |

`conversationId` is resolved from `req.body.conversationId` or
`req.body.agentOptions.conversationId`. If neither is present the publish
call is skipped (nothing is invented). Legacy callers that don't pass a
conversation id see zero behavior change.

`workspaceId` and `userId` are sanitized through the same helpers already
used for WebSocket presence (`sanitizeWorkspace`, `sanitizeUserId`).

### Tests

- `tests/realtime-pub-chat.test.js` — exercises
  `pipeLlmChatStreamToSse(..., { conversationId })` with a mock streaming
  backend and asserts deltas arrive on `chat:<conversationId>` with the
  documented shape; also asserts the no-conversationId path creates no
  channels.
- `tests/realtime-pub-presence.test.js` — calls the exported
  `publishPresenceEvent` helper and subscribes to
  `presence:<workspaceId>`, asserting `{ type, userId, ts }` events and
  channel-level isolation.

---

## Shell view registration (wave 4)

The agent runs list view (`client/src/views/runs.js`) pairs with the
existing `agent-run.js` detail view. To wire both into the SPA shell,
replace the `/runs` and `/runs/:id` placeholder registrations in
`client/src/app.js` with:

```js
router.register("/runs", async (ctx) => (await import("./views/runs.js")).default(mainEl, ctx));
router.register("/runs/:id", async (ctx) => (await import("./views/agent-run.js")).default(mainEl, { sessionId: ctx.params.id }));
palette.register({ id: "goto-runs", title: "Go to agent runs", run: () => router.navigate("/runs") });
```

Where `mainEl` is the `<main id="sb-main">` node already created by
`bootstrap()`. The list view consumes
`GET /api/v1/agent/sessions?workspace=<ws>&limit=40`, polls every 5s
(TODO: upgrade to the `run:*` realtime channel), and navigates to
`/runs/:id` via `window.SiskelbotShell.router` when present, with a
`window.location.assign("/app#/runs/" + id)` fallback.

### New files

- `client/src/views/runs.js` — default export `mount(el, { params, query, apiBase? })`.
  Exports pure helpers `formatStatus`, `sortRows`, `filterRows`.
- `client/src/views/runs.css` — dark theme matching `agent-run.css`.

### Tests

- `tests/client-views-runs.test.js` — 19 unit tests covering
  `formatStatus` (label + color class), `sortRows` (stable,
  createdAt-desc default, numeric + ISO timestamps, title / status keys),
  and `filterRows` (status + query composition, `completed`/`complete`
  equivalence, case-insensitive substring match, id fallback). No JSDOM.

### Chat view

The chat view (`client/src/views/chat.js`) mounts a two-pane conversation
list + streaming composer inside the shell. Add to `client/src/app.js`:

```js
router.register("/chat", async (ctx) => (await import("./views/chat.js")).default(mainEl, ctx));
palette.register({ id: "goto-chat", title: "Go to chat", run: () => router.navigate("/chat") });
```

The view consumes `GET /api/v1/conversations?workspace=default` for the
list, tries `GET /api/v1/conversations/:id/messages` for per-conversation
history (falls back to reading `messages` from the conversation object
when that endpoint is not available), and POSTs
`/v1/chat/completions` with `{messages, model, stream: true, workspace,
conversationId, requestId}` for streaming responses. SSE frames are
parsed via the exported `parseSseLine` helper.

Model selection is persisted to `localStorage["siskelbot:chat:model"]`;
the option list is static (`gpt-4o-mini`, `gpt-4o`, `llama3.1`).

#### New files

- `client/src/views/chat.js` — default export `mount(el, ctx)`.
  Named exports: `parseSseLine`, `renderMarkdown`, `formatUsd`.
- `client/src/views/chat.css` — dark theme matching the shell palette.

#### Tests

- `tests/client-views-chat.test.js` — 15 unit tests covering
  `parseSseLine` (data / event / [DONE] / blank / comment / malformed),
  `renderMarkdown` (fenced code, inline code, bold/italic, link href
  escape, `<script>` sanitization, `javascript:` href rejection), and
  `formatUsd` (sub-dollar, `>= 1`, zero, negative, non-numbers). No JSDOM.

### Knowledge view

The knowledge view (`client/src/views/knowledge.js`) mounts a three-tab
panel (Docs / Search / Graph) in the shell. Add to `client/src/app.js`:

```js
router.register("/knowledge", async (ctx) => (await import("./views/knowledge.js")).default(mainEl, ctx));
palette.register({ id: "goto-knowledge", title: "Go to knowledge", run: () => router.navigate("/knowledge") });
```

Consumes:

- `GET /api/v1/context?workspace=<ws>` — docs list (tolerant of
  `[]`, `{items: []}`, `{documents: []}`).
- `POST /api/v1/context`, `PUT /api/v1/context/:id`,
  `DELETE /api/v1/context/:id?workspace=<ws>` — doc CRUD.
- `GET /api/v1/search?q=<q>&workspace=<ws>` — keyword search.
- `GET /api/v1/context/semantic?q=<q>&workspace=<ws>` — semantic
  search. If this endpoint returns 404, the view shows a visible
  notice and falls back to the keyword endpoint.
- `GET /api/v1/knowledge/graph?workspace=<ws>&limit=100` — knowledge
  graph. On 404 or empty result the view renders "Graph unavailable".

The graph tab renders a static 600×600 canvas using the exported
`layoutEntitiesCircular` helper (deterministic circular placement).
Click a node to highlight its neighbors by dimming others. No zoom /
pan. Responsive only via CSS `max-width: 100%`.

#### New files

- `client/src/views/knowledge.js` — default export `mount(el, ctx)`.
  Named exports: `formatDocSize`, `rankSearchResults`,
  `layoutEntitiesCircular`.
- `client/src/views/knowledge.css` — dark theme matching the shell
  palette.

#### Tests

- `tests/client-views-knowledge.test.js` — 4 unit tests covering
  `formatDocSize` (0 / null / undefined / string / KB / MB),
  `rankSearchResults` (empty, non-mutation, stable score-desc /
  updatedAt-desc / title-asc tie-breaking), and
  `layoutEntitiesCircular` (0 / 1 / 4 entities, determinism, finite
  coords). No JSDOM.

---

## Artifacts

Named outputs (files, charts, tables, etc.) produced by agent tools during a
run are recorded in a durable store, fan out as `artifact.new` on the Agent
Run SSE stream, and render in the hero-view Artifacts pane.

### New files

- `lib/agent-artifacts.js` — artifact store (`createArtifact`,
  `listArtifactsForSession`, `getArtifactContent`, `getArtifactRecord`,
  `deleteArtifact`, `deleteArtifactsForSession`, `getSessionArtifactBytes`,
  `getArtifactLimits`). Inline payloads ≤ `ARTIFACT_INLINE_BYTES` (default
  64 KiB) live in the metadata record; larger payloads spill to
  `<STORAGE_PATH>/artifacts/<sessionId>/<id>.bin`. Metadata is persisted via
  `lib/json-path-store.js` so it flows through the same JSON / SQLite /
  Postgres backends as the rest of the codebase. `createArtifact` publishes
  `artifact.new` via `publishAgentRunEvent(sessionId, "artifact.new", …)`.
- `routes/agent-artifacts.js` — exports `mountAgentArtifactRoutes(app, deps)`.

### Routes

| Method | Path                                          | Scope | Description                                      |
|--------|-----------------------------------------------|-------|--------------------------------------------------|
| GET    | `/agent/sessions/:id/artifacts`               | read  | List artifacts for the session (metadata only).  |
| POST   | `/agent/sessions/:id/artifacts`               | write | Create an artifact (JSON or multipart).          |
| GET    | `/agent/artifacts/:artifactId`                | read  | Stream the content with the recorded MIME.       |
| DELETE | `/agent/artifacts/:artifactId`                | write | Remove an artifact (record + disk file).         |

All four routes follow the `logRequest → userAuth → requireScope → handler`
chain and gate access through `getWorkspaceAgentAccess` + session ownership
(same pattern as `routes/agent-sessions.js`).

`POST` accepts either:

- `application/json` with `{ name, mime, contentBase64 }` or
  `{ name, mime, content }` (string, UTF-8).
- `multipart/form-data` with a `file` field and optional `name` / `mime` /
  `runId` / `meta` form fields.

### Size caps and environment variables

| Variable                       | Default              | Purpose                                                  |
|--------------------------------|----------------------|----------------------------------------------------------|
| `ARTIFACT_MAX_BYTES`           | `10485760` (10 MiB)  | Per-artifact hard cap — returns 413 `ARTIFACT_TOO_LARGE` |
| `ARTIFACT_SESSION_MAX_BYTES`   | `104857600` (100 MiB)| Per-session cap — returns 413 `ARTIFACT_QUOTA_EXCEEDED`  |
| `ARTIFACT_INLINE_BYTES`        | `65536` (64 KiB)     | Threshold at which payloads spill to disk                |

Coded error responses: `INVALID_NAME`, `INVALID_MIME`, `INVALID_CONTENT`,
`ARTIFACT_TOO_LARGE`, `ARTIFACT_QUOTA_EXCEEDED`.

### Wiring into `routes/index.js`

```js
import { mountAgentArtifactRoutes } from "./agent-artifacts.js";
// ...and append to mountFunctions:
mountAgentArtifactRoutes,
```

### Client rendering

`client/src/views/agent-run.js` — the Artifacts pane now:

- Backfills on first mount via `GET /agent/sessions/:id/artifacts`.
- Prepends new artifacts when an `artifact.new` SSE frame arrives
  (dedup'd by id).
- Renders each card with a mime-category icon, name, mime, and size.
- On click:
  - `image/*` → inline `<img>` via the content endpoint.
  - `text/*`, `application/json`, `*+json`, `*+xml` → fetched and rendered
    in a `<pre>`, truncated at 20 KB with a **Load full** button.
  - Everything else → a Download link (uses the same content endpoint with
    a `download` attribute).

### Tests

- `tests/agent-artifacts-store.test.js` — 10 unit tests covering inline +
  disk storage, per-artifact and per-session caps, mime / name validation,
  SSE publish, list scoping, and `deleteArtifactsForSession` cleanup.
- `tests/agent-artifacts-route.test.js` — 11 integration tests covering
  JSON and multipart POST, list, streamed GET with correct MIME and bytes,
  auth + workspace-access gates, 404 paths, and DELETE semantics.
