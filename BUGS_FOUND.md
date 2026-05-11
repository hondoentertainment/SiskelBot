# Regression-test notes (resolved items cleared)

Historical regressions documented during test authoring live here until fixes ship.

## Resolved

1. **`server.js` + Vercel — `ERR_MODULE_NOT_FOUND` for `lib/server-configured-app.js`**  
   Dynamic `import()` must use **relative string specifiers** (`import("./lib/...")`), not `new URL(..., import.meta.url).href`, so `@vercel/node` traces and ships modules under `/var/task`. Guarded by `tests/server-vercel-bootstrap.test.js`.

2. **`routes/agent-hitl.js` — 409 CONFLICT for duplicate approval consumption**  
   Fixed by atomic `takeHitlState` plus `isHitlConsumed` for losers (`tests/agent-hitl-409-race.test.js`).

3. **`lib/agent-tools.js` — outer `ok` on tool results**  
   Blocked hook responses now set `ok: false` on the wrapper; `runTool` runs `coalesceToolOuterOk()` so JSON payloads with `{ ok: ... }` mirror onto the wrapper for metrics (`toolCallsLog`). Thrown tools still map to `{ ok: false }`.

4. **`runToolCore` unknown tool**  
   The `default` branch throws; validation remains the primary gate (`TOOL_VALIDATION_STRICT=0` drift surfaces as a thrown error absorbed by `runTool`).

---

When you discover new pinned-behavior notes while writing tests, add a dated subsection here and remove it once production code matches the intended contract.
