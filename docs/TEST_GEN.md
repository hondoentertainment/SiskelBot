# Test Generation (Phase 63.3)

`lib/test-gen.js` parses an LCOV coverage report, surfaces modules with
uncovered lines, and emits minimal test stubs targeting those gaps.

## API surface

| Export | Purpose |
|--------|---------|
| `parseLcov(text)` | Parse LCOV text into `[{ path, linesFound, linesHit, uncoveredLines }]` |
| `identifyGaps({ workspaceId, lcov })` | Persist parsed gaps; returns the gap list sorted by uncovered-line count desc |
| `generateTestStub({ workspaceId, modulePath, uncoveredLines, moduleSource })` | Produce a `node:test` stub referencing the uncovered lines |
| `listGaps(workspaceId)` | Return the persisted gap list |
| `listHistory(workspaceId)` | Return generated stubs (capped at 500) |

## Storage

`data/test-gen/{workspaceId}.json`. History capped at 500 stubs per
workspace; older entries are evicted on overflow.

## Inputs and limits

- `lcov` must include `SF:`, `DA:<line>,<hits>`, `LF:`, `LH:`, and
  `end_of_record` markers. Other LCOV fields (BRF, BRH, FNF, FNH) are
  ignored — branch and function coverage are not analysed.
- `moduleSource` is optional. When provided, the stub embeds line numbers
  with a one-line context excerpt; when omitted, only line numbers appear.
- Stubs use Node's built-in `node:test` runner. Workspaces relying on
  Vitest, Mocha, or Jest must adapt the output before use.
- The stubs are **scaffolding**, not assertions. They will compile and run
  but will not catch real regressions until the engineer fills them in.

## Failure modes

| Symptom | Cause | Mitigation |
|--------|------|-----------|
| `identifyGaps` returns empty on a non-empty lcov | Source paths in lcov are absolute; parser preserves them, callers expect repo-relative | Strip path prefix before persisting, or post-process |
| Stub references the wrong line numbers | LCOV was generated against a different revision than the source provided | Always pair lcov + source from the same git ref |
| Stub fails to import the module | `modulePath` includes a leading `/` that breaks the relative `import` | Pass workspace-relative paths; the stub does not normalise |
| History grows but `listGaps` is stale | `identifyGaps` must be called explicitly to refresh the gap list — generation alone does not | Always re-run `identifyGaps` before reading `listGaps` |
| Branch-coverage gaps invisible | Parser ignores BRF/BRH | Use `c8 report --reporter=lcov-branch` separately and feed gaps in by hand |

## HITL guarantees

The module emits scaffolding. It does **not** write files to disk, does
not run the generated tests, and does not commit. Any wrapper that
auto-writes the stub or auto-commits **MUST** route through
`lib/agent-hitl-store.js`. No exceptions.

## Disabling

The module is library-only — to remove the HTTP surface, do not register
`routes/test-gen.js` in `routes/index.js`. The `coverage:critical` script
(see `scripts/check-critical-coverage.mjs`) is independent and continues
to enforce floors.

## Related

- `scripts/check-critical-coverage.mjs` for per-file coverage floors
- `.c8rc.json` for global coverage thresholds
- `lib/eval-in-prod.js` for tracking whether generated tests catch real regressions
