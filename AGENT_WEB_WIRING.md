# Agent Web view wiring

Agent-facing single-page views live under `client/src/views/` and stream from
matching routes. Each new route module MUST be wired into `routes/index.js`
per the worktree rules (we do NOT modify `server.js` here).

## Agent Run Stream

A new SSE-backed route surfaces the Agent Run hero UI (Plan / Timeline /
Artifacts / Approvals) for a single agent session.

### New files

- `lib/agent-run-stream.js` — `streamAgentRun({ sessionId, res, req, ... })`,
  plus `getAgentRunEmitter(sessionId)` / `publishAgentRunEvent(sessionId, type, payload)`
  for agent-loop callsites to push live events.
- `routes/agent-run-stream.js` — exports `mountAgentRunStreamRoutes(app, deps)`.
- `client/src/views/agent-run.js` — default export `mount(el, { sessionId, apiBase })`.
- `client/src/views/agent-run.css`.

### Route

`GET /api/v1/agent/sessions/:sessionId/stream`
(legacy alias `GET /api/agent/sessions/:sessionId/stream` with the standard
`X-API-Deprecated` header via `apiRoute`).

Middleware chain matches `routes/agent-sessions.js`:
`logRequest → userAuth → requireScope("read") → handler`. The handler rejects
missing sessions with 404, non-member workspaces with 403, and sessions owned
by another user with 403. On success it streams SSE frames:

```
event: <type>
data: {"seq":N,"ts":"...","payload":{...}}
```

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

Add alongside the existing imports:

```js
import { mountAgentRunStreamRoutes } from "./agent-run-stream.js";
```

and append to `mountFunctions`:

```js
mountAgentRunStreamRoutes,
```

### Integration point (out of scope for this change)

The per-session `EventEmitter` returned by `getAgentRunEmitter(sessionId)` is
the publish boundary. Downstream emitters should import
`publishAgentRunEvent(sessionId, type, payload)` from `lib/agent-run-stream.js`
and call it from agent-loop callsites:

- `lib/agent-loop.js` on iteration start/end → `status.change`, `done`
- `lib/agent-loop-execute-tools.js` around tool execution → `tool.call`, `tool.result`
- `lib/agent-hitl-store.js` on save / take → `hitl.request`, `hitl.resolved`
- A cost/usage hook → `cost.update`
- A future artifact sink → `artifact.new`

Historical events (durable session event log + trajectory steps) are backfilled
on connect, so late subscribers still see the full run.

## Replay & Share

Tokenized, shareable, read-only replay of agent runs. A signed bearer token
(HMAC-SHA256, compact JWT-style) grants unauthenticated viewers access to a
recorded trajectory through a minimal single-page viewer served at `/r/:token`.

### New files

- `lib/replay-tokens.js` — `mintReplayToken({ runId, workspaceId, userId, ttlMs })`,
  `verifyReplayToken(token)`, `revokeReplayToken(token)`. Secret resolution:
  `REPLAY_TOKEN_SECRET` → `SESSION_SECRET`; throws with code
  `REPLAY_SECRET_MISSING` if neither is set. Revocation list (by `jti`) is
  persisted via `lib/json-path-store.js` under
  `data/replay-revoked.json` (key space "replay:revoked:<jti>" conceptually).
- `routes/replay.js` — exports `mountReplayRoutes(app, deps)`.
- `client/src/views/replay.js` — default export `mount(el, { token })`;
  self-contained 3-pane (Plan / Timeline / Artifacts) viewer with top
  scrubber (play/pause, step, 0.5x/1x/2x/4x, draggable seek).
- `client/src/views/replay.css` — dark theme (`#0f172a` / `#e2e8f0` / `#60a5fa`).

### Environment

| Variable | Purpose |
|----------|---------|
| `REPLAY_TOKEN_SECRET` | HMAC signing key for replay tokens (preferred). |
| `SESSION_SECRET` | Used as a fallback when `REPLAY_TOKEN_SECRET` is unset. |
| `REPLAY_REVOKED_MAX` | Optional cap on persisted revocations (default 10 000). |

### Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST   | `/api/v1/agent/sessions/:id/share` | `userAuth` + `write` scope | Validate workspace access and ownership, mint token. Returns `{ token, url: "/r/<token>", expiresAt, runId, sessionId }`. |
| DELETE | `/api/v1/agent/sessions/:id/share/:token` | `userAuth` + `write` scope | Revoke the token (`jti` blacklist). |
| GET    | `/r/:token` | Public (token-gated) | Minimal HTML page that imports `client/src/views/replay.js` and calls `mount(el, { token })`. |
| GET    | `/api/v1/replay/:token/events` | Public (token-gated) | JSON `{ runId, workspaceId, expiresAt, plan, events, eventCount, generatedAt }`. |

Authenticated endpoints are registered through the existing `apiRoute(...)`
helper (`/api/v1/...` and legacy `/api/...` with the standard deprecation
header). The public `/r/:token` HTML endpoint is registered with `app.get`
directly because `apiRoute` is API-versioned.

### Wiring into `routes/index.js`

Add alongside the existing imports:

```js
import { mountReplayRoutes } from "./replay.js";
```

and append to `mountFunctions`:

```js
mountReplayRoutes,
```

### Integration notes

- `POST /agent/sessions/:id/share` looks up the session via
  `getAgentSession(id)`, verifies workspace access
  (`getWorkspaceAgentAccess`) and ownership (`resolveStorageUserId`), then
  mints a token scoped to the session's most-recent linked runId (falling
  back to the sessionId if no runs have been linked yet).
- Public endpoints never call the authenticated user pipeline; the token's
  `{ runId, workspaceId }` claims are the only authorization signal. Events
  come straight from `loadTrajectory(runId)` and `getAgentSession(runId)`;
  no mutation paths are exposed to public viewers.
- Token TTL is clamped to `[60s, 30 days]`; default 7 days.
