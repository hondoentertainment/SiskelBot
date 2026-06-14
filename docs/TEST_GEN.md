# Test generation (Phase 63.3)

Coverage-driven **scaffolding**: parse an **LCOV** report, persist “gaps” (files with uncovered lines), and emit a minimal **`node:test`** stub an engineer must fill in. **Deterministic**—no LLM.

## Purpose

- **`identifyGaps`**: parse LCOV text, persist per-workspace gaps, return parsed files plus gap list.
- **`generateTestStub`**: build a stub file string (and append to history) from `modulePath`, optional `uncoveredLines`, optional `moduleSource` (used only to sniff simple `export` declarations).

## HTTP routes (`routes/test-gen.js`)

Registered with **`apiRoute`**: **`/api/v1`** + suffix below, and legacy **`/api`** + suffix. All use **`adminAuth`**.

| Method | Path | Body / query |
|--------|------|----------------|
| `POST` | `/test-gen/analyze` | `{ workspaceId?, lcov }` — **`lcov` must be a string** (empty string allowed) |
| `POST` | `/test-gen/generate` | `{ workspaceId?, modulePath, uncoveredLines?, moduleSource? }` |
| `GET` | `/test-gen/gaps` | `?workspaceId` |
| `GET` | `/test-gen/history` | `?workspaceId` |

### Mount status

**`mountTestGenRoutes`** is registered in `routes/index.js` alongside other Phase 63 developer-tool routes (`mountPrReviewRoutes`, `mountRepoRagRoutes`). Exposed paths are `/api/v1/test-gen/*` and deprecated `/api/test-gen/*`.

## LCOV parsing

`parseLcov` scans records for **`SF:`**, **`DA:<line>,<hits>`**, **`LF:`**, **`LH:`**, **`end_of_record`**.

- Lines with **`hits === 0`** on a `DA:` line are treated as uncovered.
- If **`LF`** / **`LH`** are absent, **`end_of_record`** may infer `linesFound` from uncovered count + `linesHit` when applicable (see implementation).
- Extremely malformed reports can yield incomplete or odd gap metadata—the parser is pragmatic, not a full LCOV validator.

## Stub output

- Uses **`node:test`** and **`node:assert/strict`**.
- **Imports**: tries named exports matching `export (async )?function|const|let|var|class Name`—**other export forms are not detected**, so stubs fall back to `import * as target`.
- **`modulePath`** not starting with `.` or `/` gets an import prefix of **`../`** in the stub (may require manual fixing).

## Environment and storage

No test-gen-specific env vars. Persistence: `data/test-gen/{workspaceId}.json`:

- **`gaps`**: last **`identifyGaps`** result set (overwritten each analyze).
- **`history`**: append-only generations, trimmed to **500** newest entries (`MAX_HISTORY`).

Storage backend follows **`STORAGE_PATH`** / Postgres or SQLite KV like other `json-path-store` consumers.

## Limits

| Limit | Value |
|-------|--------|
| History entries per workspace store | **500** (FIFO trim) |
| Uncovered lines named in stub comment / TODO | Lists all in header; **`join` in TODO** trims to **first 20** in the smoke test body |

## Failure modes

- **400** on analyze if **`lcov` is not a string** (routes); library accepts missing/empty and returns zero files.
- **400** on generate if **`modulePath`** missing (routes) or blank (library throws).
- **500** on unexpected errors through route handlers.

**Semantic gaps**: stubs do not guarantee correct import paths, mock setup, or that listed lines are easy to exercise.

## Human-in-the-loop (HITL)

**None** for test generation routes or library APIs.

## Disabling or exposure

- Remove **`mountTestGenRoutes`** from `routes/index.js` `mountFunctions` if a deployment should not expose test-gen HTTP.
- Access is gated by **`adminAuth`**; combine with network policy in production.

Internal: **`_reset(workspaceId?)`** clears store for tests—not for production ops.
