# Bugs found while writing regression tests

These were surfaced by `tests/agent-hitl-409-race.test.js` and
`tests/agent-loop-edge-cases.test.js`. Each is pinned to the *current*
(buggy) behavior so the test suite remains green until someone fixes the
underlying code. When a fix lands, the tests should be updated and the
corresponding entry here removed.

No production code was modified while writing these tests.

---

## 1. `routes/agent-hitl.js` — the 409 CONFLICT branch is unreachable

**File:** `routes/agent-hitl.js` (lines 47-68)
**Finding:** The handler reads

```js
const snapshot = peekHitlState(approvalId);
if (!snapshot) return apiError(res, 404, "NOT_FOUND", ...);
const taken = takeHitlState(approvalId, { decision });
if (!taken) return apiError(res, 409, "CONFLICT", ...);
```

There is no `await` between `peekHitlState` and `takeHitlState`, both
functions are synchronous (see `lib/agent-hitl-store.js`), and
JavaScript is single-threaded, so two concurrent requests can never
interleave peek+take on the same token in a way that causes peek to
return truthy and take to return null for the same request. The loser
of a race sees the token already gone at peek time and degrades to 404
instead of 409.

**Impact:** The 409 response shape (`CONFLICT` + "Approval already
resolved") exists only for a race window that cannot open. Clients
that specifically catch 409 to distinguish a race from a missing
token will never exercise that path.

**Fix direction:** Either (a) remove the unreachable branch and
document that 404 covers both cases, or (b) introduce a real async
gap — e.g. a persistent audit write or distributed lock — between
peek and take so the race becomes observable and CONFLICT becomes
meaningful in HA deployments.

**Test coverage:**
- `tests/agent-hitl-409-race.test.js`:
  - "concurrent approvals never yield a 409 under the real route" —
    pins the current [200, 404] response pair.
  - "when peek+take straddle an async gap, concurrent requests
    produce a 409" — uses a test-only route with an artificial delay
    to prove the 409 JSON shape is correct for the day someone adds
    a real gap.
  - "sequential resolution returns 200 then 404" — pins the
    no-409-degradation behavior.

---

## 2. `lib/agent-tools.js` — `runTool` exception wrapper does not set outer `ok` flag

**File:** `lib/agent-tools.js` (lines 452-459)
**Finding:** `runTool` wraps thrown exceptions into a content payload:

```js
try {
  result = await runToolCore(name, execArgs, ctx);
} catch (e) {
  result = { content: JSON.stringify({ ok: false, error: String(e?.message || e) }) };
}
```

The inner JSON body says `ok: false`, but the outer `result` object
has no `ok` field. Downstream in `lib/agent-loop.js` (inside
`tracedRunTool`) the log entry is derived from `result.ok !== false`:

```js
toolCallsLog.push({ ..., ok: result.ok !== false });
```

`undefined !== false` evaluates to `true`, so a thrown tool is logged
as `ok: true` even though the content clearly says otherwise. The same
mismatch applies to any tool that returns `{content: "{\"ok\":false,...\"}"}`
without an outer `ok` on the wrapper (e.g. `fetch_allowed_url` when
the URL is blocked, the Unknown-tool `default:` branch in
`runToolCore`, etc.).

**Impact:** `toolCallsLog[i].ok` and the `toolCallsLog` summary in
the agent-loop result cannot be trusted to reflect actual tool
success. Metrics and downstream UI that rely on that boolean will
under-count failures.

**Fix direction:** In `runTool`, either (a) always set
`result.ok = <bool>` on the wrapper before returning, or (b) change
`tracedRunTool` to parse the content JSON when the wrapper has no
`ok` field.

**Test coverage:**
- `tests/agent-loop-edge-cases.test.js` test 2 ("unknown tool name")
  pins the fact that unknown-tool calls are caught by
  `lib/tool-validation.js` first (which *does* set `ok: false`), so
  the `default:` branch in `runToolCore` is effectively dead code for
  the agent loop. That dead code emits content *without* `ok:false`,
  which would hit the mismatch above if validation were ever
  disabled.
- `tests/agent-loop-edge-cases.test.js` test 4 ("tool that fails
  mid-loop") pins the overall loop-continues-cleanly behavior for
  tools that return ok:false payloads.

---

## 3. `lib/agent-tools.js` — `runToolCore` `default:` branch is dead code

**File:** `lib/agent-tools.js` (lines 964-965)
**Finding:** The `default:` branch returns

```js
return { content: JSON.stringify({ error: `Unknown tool: ${name}` }) };
```

For this to run, the tool name must pass `toolValidationEnabled()`
plus the KNOWN_TOOLS check in `lib/tool-validation.js`. Because
KNOWN_TOOLS and the core switch are the same set of tool names, the
validator rejects any unknown tool before `runToolCore` ever sees it
(the rejected call is recorded with `validationError: true, ok:
false`). The `default:` branch only becomes reachable if someone
disables validation via `TOOL_VALIDATION_STRICT=0` and the two lists
ever drift out of sync.

**Impact:** Low — dead code, but the error payload is inconsistent
with the rest of the file (missing `ok:false`) and would trip bug #2
above if it ever ran.

**Fix direction:** Either keep the branch and add `ok: false` for
consistency, or drop it and let a `TypeError` bubble up into `runTool`'s
try/catch (which would also hit bug #2 until that is fixed).

**Test coverage:**
- `tests/agent-loop-edge-cases.test.js` test 2 documents that the
  validator is what handles unknown tools today, not the `default:`
  branch.
