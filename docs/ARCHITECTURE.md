# SiskelBot Architecture Decision Records

This document records the key architectural decisions made in SiskelBot, the reasoning behind each, the alternatives considered, and the trade-offs accepted.

---

## ADR-1: Express over Fastify or Koa

**Decision:** Use Express 4.x as the HTTP framework.

**Context:** SiskelBot is a proxy server that sits between clients and LLM backends (Ollama, vLLM, OpenAI). It needs to handle streaming SSE responses, WebSocket upgrades, static file serving, session management, OAuth callbacks, and 37+ route modules. The framework must support a large middleware ecosystem and be well understood by contributors.

**Alternatives considered:**

- **Fastify** -- Higher raw throughput via schema-based serialization and a plugin system. However, SiskelBot's bottleneck is the upstream LLM backend, not HTTP parsing. Fastify's plugin encapsulation model adds complexity when 37 route modules need shared state (storage, scheduler, realtime, teams). Express's flat middleware chain makes it straightforward to pass a `deps` object to every route module via `mountAllRoutes(app, deps)`.

- **Koa** -- Cleaner async/await middleware via `ctx`. However, Koa's ecosystem is smaller, and many battle-tested middlewares (helmet, express-session, passport, express-rate-limit, compression) are Express-native. Wrapping them for Koa introduces compatibility risk for marginal benefit.

- **Hono / H3** -- Lightweight and fast, but less mature middleware ecosystems. SiskelBot relies on passport (GitHub + Google OAuth, OIDC, SAML), express-session, and helmet -- all built for Express.

**Rationale:**

1. **Ecosystem depth.** SiskelBot uses 8+ Express-native middlewares (helmet, cors, compression, rate-limit, session, passport, multer, express.json). Each is production-hardened with millions of weekly downloads.
2. **Contributor familiarity.** Express is the most widely known Node.js framework. New contributors can read the route files without learning a framework-specific pattern.
3. **Streaming support.** Express passes the raw Node.js `res` writable stream to handlers, making SSE streaming (the core chat feature) trivial: `res.write("data: ...\n\n")`.
4. **Adequate performance.** The latency-critical path is the upstream LLM call (100ms-60s). Express adds microseconds of overhead per request. Framework performance is not a meaningful bottleneck.

**Trade-offs accepted:**

- No built-in schema validation -- compensated by `lib/validate.js` middleware.
- Callback-based error handling -- mitigated by consistent `try/catch` + `apiError()` helper in every route.

---

## ADR-2: ES Modules over CommonJS or TypeScript

**Decision:** Use native ES modules (`import`/`export`) throughout, with no TypeScript compilation step.

**Context:** The codebase spans ~190 modules (145 in `lib/`, 37 routes, plus client, CLI, and scripts). A build step would add complexity to development, CI, and the Docker image. The project targets Node.js 18+ where ES modules are stable.

**Alternatives considered:**

- **CommonJS (`require`)** -- Still the Node.js default for many projects. However, ES modules offer static analysis (tree-shaking for the client build via esbuild), top-level `await`, and alignment with browser JavaScript (the client is vanilla JS with no build step). Mixing CommonJS and ESM creates interop headaches (`require` of ESM fails; `import()` of CJS works but loses named exports).

- **TypeScript** -- Provides compile-time type checking and better IDE support. However:
  - Adds a build step for 190+ server modules, increasing CI time and Docker image complexity.
  - Requires `tsc --watch` in development or `tsx`/`ts-node` wrappers.
  - The client is vanilla JS served directly by Express -- TypeScript would only cover the server, creating a split.
  - SiskelBot uses JSDoc + `@ts-check` for type safety in critical modules (see ADR-6) without requiring compilation.

**Rationale:**

1. **Zero build step.** `node server.js` starts the server. No compilation, no source maps to maintain, no `dist/` directory. Development uses `node --watch server.js`.
2. **One module system.** Both server (`lib/`, `routes/`) and client (`client/`) use `import`/`export`. The same module syntax runs everywhere.
3. **Node.js 18+ stability.** ES modules, top-level `await`, and `import.meta.url` are stable and unflagged in the target runtime.
4. **Package.json declares `"type": "module"`**, making `.js` files default to ESM. The Electron wrapper uses `.cjs` for the small number of files that must be CommonJS.

**Trade-offs accepted:**

- No compile-time type checking across all modules (mitigated by JSDoc + `@ts-check` in critical files).
- `__dirname` is not available -- replaced by `fileURLToPath(import.meta.url)` and `dirname()`.
- Some npm packages still ship only CJS; these require dynamic `import()` or are avoided.

---

## ADR-3: JSON File Storage as Default Backend

**Decision:** Store all data as JSON files on disk (under `data/`) by default, with optional SQLite and PostgreSQL backends.

**Context:** SiskelBot stores conversations, context documents, recipes, workspace metadata, agent memories, eval sets, audit logs, and more. The default storage must work with zero dependencies -- no database server to install, no connection string to configure.

**Alternatives considered:**

- **SQLite as default** -- More robust for concurrent writes and querying. However, SQLite requires a native binary (`better-sqlite3`), which complicates cross-platform installs (especially on Alpine Docker, Windows ARM, and CI environments). SiskelBot lists `better-sqlite3` as an `optionalDependency` so `npm ci` succeeds even if compilation fails.

- **PostgreSQL as default** -- Production-grade, but requiring a running database server for a 5-minute quickstart is a non-starter for local development and single-user setups.

- **Embedded key-value stores (LevelDB, LMDB)** -- Native dependencies with the same cross-platform issues as SQLite, plus less familiar APIs.

**Rationale:**

1. **Zero dependencies.** `npm ci && npm start` works on any platform with Node.js 18+. No database to install, no ports to open, no connection strings.
2. **Human-readable data.** JSON files in `data/` can be inspected, edited, and backed up with standard filesystem tools. This is invaluable for debugging and for users who are not database administrators.
3. **Progressive complexity.** Users start with JSON files, then upgrade to SQLite (`STORAGE_BACKEND=sqlite`) for better concurrency, or PostgreSQL (`STORAGE_BACKEND=postgres`) for production multi-replica deployments. The storage API (`lib/storage.js`) abstracts the backend so route code is unchanged.
4. **Backup simplicity.** Backing up `data/` is a directory copy. Restoring is replacing the directory. The backup API (`lib/backup.js`) archives `data/` as a zip.

**Trade-offs accepted:**

- No atomic multi-key transactions (mitigated by per-file locking in `lib/storage.js`).
- No query language -- search is handled by `lib/search-index.js` (inverted index) and `lib/knowledge-store.js` (keyword/semantic search) rather than SQL.
- Concurrent writes from multiple processes can cause data loss (mitigated by advisory file locks and documented single-process recommendation for JSON backend).
- Performance degrades with very large datasets (thousands of conversations per workspace). The documented upgrade path is SQLite or PostgreSQL.

**Storage backend summary:**

| Backend | Config | Use case |
|---------|--------|----------|
| JSON (default) | `STORAGE_PATH=./data` | Development, single-user, small teams |
| SQLite | `STORAGE_BACKEND=sqlite` | Medium workloads, single-server |
| PostgreSQL | `STORAGE_BACKEND=postgres` + `DATABASE_URL` | Production, multi-replica, HA |

---

## ADR-4: AsyncLocalStorage for Request Context

**Decision:** Use Node.js `AsyncLocalStorage` (via `lib/request-context.js`) to propagate request ID, user ID, and workspace across async call chains.

**Context:** SiskelBot's request handling spans many modules: a chat request may flow through auth middleware, the agent loop, tool execution, knowledge search, storage, metrics recording, and error reporting. Each of these needs the request ID (for log correlation), user ID (for storage scoping), and workspace (for data isolation). Threading these as function parameters through 10+ call layers creates noisy function signatures and coupling.

**Alternatives considered:**

- **Explicit parameter threading** -- Passing `{ requestId, userId, workspace }` as a parameter to every function. This is the most explicit approach, but with 145 library modules, it creates significant API surface pollution. Functions like `indexDocument()` and `recall()` should not need to know about HTTP request IDs.

- **Global state / singleton** -- A global mutable object holding the "current request." This breaks under concurrent requests since Node.js is single-threaded but handles multiple requests interleaved across `await` boundaries.

- **cls-hooked (legacy)** -- The predecessor to `AsyncLocalStorage`, based on `async_hooks`. `AsyncLocalStorage` is the official, stable, and more performant replacement built into Node.js core since v16.4.

**Rationale:**

1. **Clean function signatures.** Library modules (`knowledge-store.js`, `agent-memory.js`, `metrics.js`, etc.) can call `getRequestId()` or `getRequestContext()` without receiving request metadata as parameters.
2. **Correct under concurrency.** Each async call chain gets its own store. Concurrent requests do not leak context into each other.
3. **Zero dependencies.** `AsyncLocalStorage` is in `node:async_hooks`, part of the Node.js standard library.
4. **Minimal overhead.** The performance impact is negligible for a proxy server where upstream LLM calls dominate latency.

**Implementation:**

```js
// lib/request-context.js
import { AsyncLocalStorage } from "node:async_hooks";
const store = new AsyncLocalStorage();

export function requestContextMiddleware() {
  return (req, res, next) => {
    store.run({ requestId: req.requestId, userId: req.userId, workspace: req.query?.workspace || "default" }, () => next());
  };
}

export function getRequestId() {
  return (store.getStore() || {}).requestId || "unknown";
}
```

**Trade-offs accepted:**

- Implicit data flow -- developers must know that `getRequestContext()` exists and is populated by middleware. Mitigated by clear module documentation and consistent usage patterns.
- `AsyncLocalStorage` has a small performance cost per `run()` call. Benchmarks show this is negligible (sub-microsecond) compared to LLM proxy latency.

---

## ADR-5: In-Memory LRU Cache with Optional Redis

**Decision:** Use an in-memory LRU cache with TTL (`lib/cache.js`) as the default caching layer, with optional Redis (`REDIS_URL`) for multi-replica deployments.

**Context:** SiskelBot caches knowledge search results, context documents, recipe lists, and API responses to reduce storage reads and improve response times. The caching layer must work without external dependencies by default.

**Alternatives considered:**

- **Redis as default** -- Shared cache across replicas, rich data structures, pub/sub. However, requiring a Redis server for a quickstart setup adds operational complexity. Many SiskelBot deployments are single-instance (local development, small teams).

- **Node-cache / lru-cache npm packages** -- Feature-rich but add dependencies for functionality that is straightforward to implement. SiskelBot's `lib/cache.js` is ~80 lines implementing `Map`-based LRU with TTL.

- **No caching** -- Simplest approach, but knowledge searches and context lookups hit storage on every request, which is slow for the JSON backend (file I/O) and unnecessary for data that changes infrequently.

**Rationale:**

1. **Zero dependencies for single-instance.** `createCache({ ttlMs: 60000, maxSize: 1000 })` works out of the box. No Redis to install.
2. **Predictable memory usage.** The LRU eviction policy and `maxSize` cap prevent unbounded memory growth. Each named cache (knowledge, recipes, context) has its own size limit.
3. **Simple invalidation.** `cache.clear()` is called on write operations (e.g., after adding a document). No cache coherence protocol needed for single-instance.
4. **Redis as an upgrade path.** When `REDIS_URL` is set, `lib/realtime-redis.js` provides pub/sub for cache invalidation across replicas, and the cache layer can be extended to use Redis as a shared store.

**Implementation:**

```js
// lib/cache.js
export function createCache({ ttlMs = 60000, maxSize = 1000 }) {
  const store = new Map();  // insertion-order = LRU order
  // get() re-inserts to move to end (most recent)
  // set() evicts oldest if at capacity
  // Entries auto-expire after ttlMs
}
```

**Trade-offs accepted:**

- Cache is per-process. In multi-replica deployments without Redis, each replica has its own cache, leading to stale reads after writes on a different replica. Documented mitigation: use Redis or sticky sessions.
- No persistence. Cache is lost on restart. This is acceptable because the cache is a performance optimization, not a data store.
- Memory overhead. Each cache entry lives in the V8 heap. The `maxSize` default of 1000 entries per named cache keeps this bounded.

---

## ADR-6: JSDoc + @ts-check Instead of TypeScript

**Decision:** Use JSDoc type annotations with the `@ts-check` directive for type safety in critical modules, rather than adopting TypeScript.

**Context:** TypeScript provides the strongest type safety guarantees, but adopting it has costs (see ADR-2). JSDoc + `@ts-check` provides a middle ground: type annotations in comments that the TypeScript language server (used by VS Code and other editors) can check without a compilation step.

**Alternatives considered:**

- **Full TypeScript adoption** -- Maximum type safety, but requires a build step, source maps, and `tsconfig.json` management for 190+ modules. See ADR-2 for the full analysis.

- **No type annotations** -- Fastest to write, but large codebases without type hints become difficult to navigate and refactor. IDE autocompletion degrades, and type errors surface only at runtime.

- **JSDoc without @ts-check** -- Type annotations as documentation only, without IDE enforcement. Better than nothing, but does not catch type errors during development.

**Rationale:**

1. **Zero build step.** JSDoc annotations are comments. They do not affect runtime behavior. `node server.js` runs the code as-is.
2. **IDE type checking.** Adding `// @ts-check` to the top of a file enables VS Code's TypeScript language server to check types, report errors, and provide autocompletion -- without `tsc`.
3. **Gradual adoption.** `@ts-check` can be added to one file at a time. Critical modules (`storage.js`, `agent-loop.js`, `agent-tools.js`) use it; less critical modules can opt in later.
4. **No toolchain dependency.** Contributors do not need to install TypeScript, configure `tsconfig.json`, or run a watcher. The type checking happens in the editor.

**Example usage in the codebase:**

```js
// @ts-check
/**
 * @param {string} userId
 * @param {string} workspaceId
 * @returns {Promise<Array<{id: string, title: string, content: string}>>}
 */
export async function listItems(type, workspaceId, userId) { ... }
```

**Trade-offs accepted:**

- JSDoc type syntax is more verbose than TypeScript's inline syntax (`/** @type {string} */` vs `string`).
- Some TypeScript features (generics, discriminated unions, mapped types) are awkward or impossible to express in JSDoc.
- Type checking is opt-in per file. Modules without `@ts-check` get no compile-time checking.
- No `.d.ts` output for consumers of the SDK. The SDK is generated from the OpenAPI spec (`npm run build:sdk`), which is type-complete regardless of source language.

---

## Summary

| Decision | Choice | Primary rationale |
|----------|--------|-------------------|
| HTTP framework | Express | Ecosystem depth, contributor familiarity, streaming support |
| Module system | ES modules | Zero build step, unified syntax with client |
| Default storage | JSON files | Zero dependencies, human-readable, progressive upgrade path |
| Request context | AsyncLocalStorage | Clean function signatures, correct under concurrency |
| Caching | In-memory LRU | Zero dependencies for single-instance, Redis as upgrade path |
| Type safety | JSDoc + @ts-check | Zero build step, IDE checking without compilation |
