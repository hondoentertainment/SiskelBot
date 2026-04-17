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

### Recipes view

The recipes view (`client/src/views/recipes.js`) mounts a two-pane
list + editor + runner inside the shell. Add to `client/src/app.js`:

```js
router.register("/recipes", async (ctx) => (await import("./views/recipes.js")).default(mainEl, ctx));
palette.register({ id: "goto-recipes", title: "Go to recipes", run: () => router.navigate("/recipes") });
```

Consumes:

- `GET /api/v1/recipes?workspace=<ws>` — list (tolerant of `[]`,
  `{items: []}`, `{data: {items: []}}`, `{recipes: []}`).
- `GET /api/v1/recipes/:id?workspace=<ws>` — full detail when an
  existing row is opened.
- `POST /api/v1/recipes` (create) and `PUT /api/v1/recipes/:id`
  (update) with body `{name, description, steps, workspace}`.
- `DELETE /api/v1/recipes/:id?workspace=<ws>` — delete with
  confirmation.
- `POST /api/v1/recipes/:id/run` with body `{workspace}`. Falls back
  to `POST /api/v1/schedules/run-now/:id` on 404/405 (the only
  run-now path the current server exposes).

Steps editor: each step is `{tool, args}`. `args` is rendered as a
JSON textarea and validated via `validateStepArgs` on save. The
view stores `argsText` separately so freeform JSON edits round-trip
verbatim until save.

The empty list state shows a "+ New recipe" CTA. The empty editor
state shows a placeholder until a recipe is selected or created.
Run output is pretty-printed JSON in a scrollable panel below the
editor.

#### New files

- `client/src/views/recipes.js` — default export `mount(el, ctx)`.
  Named exports: `validateStepArgs`, `moveStep`, `isValidRecipeName`.
- `client/src/views/recipes.css` — dark theme matching the shell
  palette (`#0f172a` / `#1e293b` / `#e2e8f0` / `#60a5fa` / `#334155`).

#### Tests

- `tests/client-views-recipes.test.js` — 10 unit tests covering
  `validateStepArgs` (empty, valid object, invalid JSON, array /
  primitive / null rejection), `moveStep` (forward, backward,
  same-idx no-op, out-of-bounds clamping, single-element array,
  non-array input), and `isValidRecipeName` (lowercase / hyphen /
  dot / digits / 64-char accept; empty / uppercase / leading
  hyphen / over-length / spaces / slashes / non-string reject).
  No JSDOM.

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

## Shell globals

The SPA shell exposes a single global, `window.SiskelbotShell`, that other
views and downstream agents use to find the router, command palette,
realtime client, inspector, and the active user / workspace.

```js
window.SiskelbotShell = {
  router,                  // from client/src/router.js
  palette,                 // from client/src/palette.js
  realtime,                // lazy RealtimeClient wrapper (connects on first .subscribe)
  inspector,               // shell's inspector instance
  user: { userId, email?, displayName?, avatarUrl? } | null,
  workspace: { id, name, role? } | null,
  workspaces: [{ id, name, role? }, ...],
  setWorkspace(id),        // updates active, persists to localStorage, emits 'workspace:change'
  on(event, handler),      // 'workspace:change' | 'user:change'
  off(event, handler),
  emit(event, payload),
};
```

### Bootstrap behavior

- `client/src/app.js` builds the global at boot via `createShellGlobals()`
  from `client/src/shell/shell-globals.js`.
- It calls `GET /api/v1/auth/session` and `GET /api/v1/workspaces` in the
  background. On 401 the shell stays in guest mode (`user = null`,
  `workspaces = []`) and the header shows a "Sign in" link. On any other
  non-2xx response the failure is logged and the shell proceeds with
  empty state — the rest of the app must not crash.
- The workspaces endpoint may return either a bare array or
  `{ items: [...] }`; the bootstrap normalizes both shapes.

### Workspace persistence

- The active workspace id is persisted to `localStorage["siskelbot:workspace"]`
  whenever `setWorkspace(id)` is called.
- On reload, the shell prefers the persisted id; if it is no longer in the
  user's workspace list, the first workspace is selected instead.

### Realtime: lazy connect

- A single `RealtimeClient({ url: "/ws/realtime" })` is constructed at boot
  but `.connect()` is deferred until the first `.subscribe(channel, handler, opts)`.
- Views should call `window.SiskelbotShell.realtime.subscribe(...)` rather
  than constructing their own client, so subscriptions multiplex over one
  socket.

### Header

- `client/src/shell/header.js` renders a `<select>` for the workspace
  switcher and an account block with the user's display name (or initials
  avatar) when signed in, falling back to a "Sign in" link when not.
- Selecting a workspace calls `shell.setWorkspace(id)`, which persists and
  emits `workspace:change`.

### Tests

- `tests/client-shell-globals.test.js` — 5 pure unit tests covering the
  emitter contract: single + multi-handler dispatch, `off` removes a
  handler, `emit` with no handlers does not throw, and event isolation.

## Inspector context-sensitivity

The right-side inspector drawer (`client/src/shell/inspector.js`,
exposed at `window.SiskelbotShell.inspector` with `setTitle / setContent /
clear / toggle`) is now populated by views as the active selection
changes. A new pure-helper module,
`client/src/views/inspector-content.js`, exports HTML-string renderers
that each view feeds into `inspector.setContent(...)`.

Every view feature-detects `globalThis.SiskelbotShell?.inspector` and
wraps the call in `try / catch` so the panel is silently skipped when
the shell is absent (e.g., legacy HTML pages).

| View | Hook point | Title | Body renderer | When |
|------|-----------|-------|---------------|------|
| `client/src/views/chat.js` | end of `streamCompletion` (`finally` block after the SSE reader closes) | `Last response` | `renderChatSignals({ cost, latencyMs, model, tokens })` | After each assistant message completes. Captures `usage` / `model` / `costUsd` from any SSE frame; latency is the wall-clock time from request start to stream end via `performance.now()`. Missing fields render as em-dash. |
| `client/src/views/agent-run.js` | end of `handleEvent` (after `renderTimeline()`) | `Trajectory` | `renderTrajectoryTree(state.timeline)` | On every SSE frame. Groups events by type via collapsible `<details>` and truncates to the most recent 50. |
| `client/src/views/knowledge.js` | inside `showDetail(doc)`, fired before the detail pane renders | `Graph neighbors` | `renderGraphNeighbors({ entity, neighbors })` | When a doc is opened. Tries `GET /api/v1/knowledge/graph?workspace=…&entity=<docTitle>` first, then `&entity=<docId>`; on both 404 the inspector is cleared. |

### Tests

- `tests/client-shell-inspector-content.test.js` — 10 pure unit tests
  covering `renderChatSignals` (all fields / missing fields / HTML
  escape), `renderTrajectoryTree` (empty / mixed types / >50 truncation
  / HTML escape), and `renderGraphNeighbors` (0 neighbors / row content
  with `data-entity` attribute / HTML escape).

## View lifecycle

Views mounted by the SPA router (`client/src/router.js`) follow a simple
mount/unmount contract so navigation never leaks timers, in-flight fetches,
realtime subscriptions, or stale inspector content.

### Contract

A view module's `mount(el, ctx)` may return **any** of:

- `void` / `undefined` — nothing to clean up.
- A function `() => void` — called by the router on the next navigation.
- An object with a `destroy()` method — adapted to a cleanup function by
  `app.js`'s `mountInto` helper.
- A `Promise` resolving to any of the above — awaited before the router
  records the cleanup.

The router stores the resulting cleanup on `router._currentUnmount` and
invokes it **before** the next view's loader runs. Thrown errors from either
the unmount or the loader are logged via `console.error` and swallowed so a
single buggy view cannot wedge the shell.

The pure bookkeeping is factored into the exported helper
`runWithLifecycle(prevUnmount, loader, ctx, onError)` so it can be unit
tested without a DOM (`tests/client-shell-router-lifecycle.test.js`).

### What each view should clean up

Each view's returned unmount is expected to:

- Clear any `setInterval` / `setTimeout` it owns.
- Abort any in-flight `fetch` via an `AbortController`.
- Close any `EventSource` it opened.
- Unsubscribe from any realtime channels it subscribed to.
- Call `globalThis.SiskelbotShell?.inspector?.clear()` so stale inspector
  content does not linger into the next view.

`mountInto` itself also calls `SiskelbotShell.inspector.clear()` up-front
before delegating to the view's `mount()`, as a belt-and-suspenders default
for views that have nothing else to clean up.

### Per-view summary

| View | Cleanup |
|------|---------|
| `client/src/views/chat.js` | Unsubscribes realtime channel, clears inspector. |
| `client/src/views/agent-run.js` | Closes `EventSource`, replaces children, clears inspector. |
| `client/src/views/knowledge.js` | Clears DOM, clears inspector. |
| `client/src/views/recipes.js` | Replaces children, clears inspector. |
| `client/src/views/runs.js` | Clears poll `setInterval`, replaces children, clears inspector. |
| `client/src/views/replay.js` | Aborts in-flight fetch, stops playback timer, clears inspector. |
| `client/src/views/observability.js` | Clears poll `setInterval`, replaces children, clears inspector. |

## Cost emission

The `cost.update` SSE event that feeds the Agent Run hero footer is emitted from
every site where the server completes a chat completion on behalf of an agent
run. The cumulative-per-run accounting lives in a single shared helper,
`lib/agent-cost-emitter.js`, which exports `emitCostUpdate(...)` and
`disposeRunCostAccumulator(runId)`. Call sites wrap each emit in a try/catch;
resolution of `sessionId` from a bare `runId` uses `getSessionIdForRun` from
`lib/agent-session.js` (sync mirror preferred, persisted reverse index as
fallback). When no `sessionId` can be resolved, emission silently skips.

| Site | Module | Hook |
|------|--------|------|
| Single-agent tool loop | `lib/agent-loop.js` | Inline emitter (wave 5); migrates to shared helper later. |
| Swarm specialist LLM round | `lib/swarm.js` (`runSpecialistLoop`) | After each `backendFetch` parses `data.usage`, attributed to the swarm's parent `runId`. |
| Swarm synthesizer | `lib/swarm.js` (non-streaming synth branch) | After the synth response's `data.usage` is available. |
| Scheduled agent completion | `lib/scheduled-agents.js` (`runScheduledAgent`) | After the one-shot `backendFetch` returns with `usage`. |
| Direct streamed chat | `lib/llm-stream-sse.js` (`pipeLlmChatStreamToSse`) | Captures `usage` from the terminal chunk (OpenAI `stream_options.include_usage`, vLLM default) and emits once on pipe close, only when caller passes `opts.runId`/`opts.sessionId`. |

Sites NOT wired (no `runId`/`sessionId` in scope): direct non-agent chat
requests to `/v1/chat/completions` that do not thread a run through
`pipeLlmChatStreamToSse` opts; legacy `runSwarmDirect` and `runSwarmLegacy`
tool-only paths that never invoke an LLM.

---

## Subagent quotas

Per-workspace enforcement of subagent spawn limits with optional human-in-the-loop
(HITL) approval gates when thresholds are crossed. Prevents runaway agent trees
from exhausting compute or budget.

### New files

- `lib/subagent-quota.js` -- quota enforcement + HITL gate logic.
- `tests/subagent-quota.test.js` -- 19 unit tests.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SUBAGENT_MAX_SPAWNS_PER_HOUR` | `100` | Hard cap on subagent spawns per workspace per hour. `0` = unlimited. |
| `SUBAGENT_MAX_DEPTH` | `3` | Maximum nesting depth for subagent chains. |
| `SUBAGENT_HITL_COST_THRESHOLD_USD` | `5.00` | If estimated cost exceeds this, require HITL approval before spawn. `0` = disabled. |
| `SUBAGENT_HITL_SPAWN_THRESHOLD` | `10` | If hourly spawn count reaches this, require HITL approval for subsequent spawns. `0` = disabled. |

Per-workspace overrides are supported via `lib/workspace-agent-settings.js`. If
`getWorkspaceAgentAccess(userId, workspace)` returns a `subagentQuota` field, its
values (`maxSpawnsPerHour`, `maxDepth`, `hitlCostThresholdUsd`, `hitlSpawnThreshold`)
override the environment defaults.

### Quota behavior

1. **Depth check** -- if `depth >= SUBAGENT_MAX_DEPTH`, hard deny (`SUBAGENT_DEPTH_EXCEEDED`).
2. **Hourly rate check** -- in-memory `Map<workspace, {count, windowStart}>`. When `count >= max`, hard deny (`SUBAGENT_QUOTA_EXHAUSTED`). Window rotates automatically when `Date.now() - windowStart > 3600000`.
3. **HITL cost gate** -- if `estimatedCostUsd > threshold` and threshold > 0, a HITL state is saved via `saveHitlState()` from `lib/agent-hitl-store.js` and the caller receives `{ allowed: "hitl_required", approvalId }`.
4. **HITL spawn-count gate** -- if `spawnsThisHour >= spawnThreshold` and threshold > 0, same HITL pattern.
5. Otherwise, `{ allowed: true }`.

### HITL integration

The module calls `saveHitlState(state)` from `lib/agent-hitl-store.js` to persist
a one-time approval token. The saved state includes `tool: "spawn_subagent"`,
`sessionId` (from `parentSessionId`), estimated cost / spawn count, and a human-
readable reason. Because `saveHitlState` publishes `hitl.request` on the Agent Run
SSE stream when a `sessionId` is present, the 4-pane hero UI renders the approval
card automatically.

The caller (spawn_subagent tool) must poll or await the approval via
`peekHitlState(approvalId)` / `takeHitlState(approvalId, { decision })` before
proceeding. If the user denies, the spawn is aborted.

### Call convention for spawn_subagent

```js
import { checkSubagentQuota, recordSubagentSpawn } from "../lib/subagent-quota.js";

const result = await checkSubagentQuota({
  workspace,
  userId,
  parentSessionId,
  depth,
  estimatedCostUsd,
  workspaceQuotaOverrides,   // optional: subagentQuota from workspace settings
});

if (result.allowed === false) {
  return { error: result.reason, code: result.code };
}
if (result.allowed === "hitl_required") {
  // Await human approval via takeHitlState(result.approvalId, ...)
  return { hitl_required: true, approvalId: result.approvalId, reason: result.reason };
}

// Proceed with spawn, then record it:
recordSubagentSpawn(workspace);
```

### Tests

`tests/subagent-quota.test.js` -- 19 tests covering fresh workspace allow,
hourly exhaustion, depth exceeded, HITL cost gate, HITL spawn-count gate,
window rotation, stats accuracy, per-workspace isolation, disabled thresholds,
priority ordering, workspace overrides, and counter reset.

