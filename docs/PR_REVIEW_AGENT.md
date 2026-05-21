# PR review agent (Phase 63.2)

Deterministic first-pass review over a **unified diff**: it parses added lines, applies small heuristic rules, persists results per workspace, and returns structured “review comments.” **No LLM is used on the HTTP surface** today—the live API always calls `reviewDiff`, not `reviewDiffWithLLM`.

Operators use this to catch common issues (debug logging, risky patterns, missing tests) before or alongside human review. It is **not** a full semantic or security audit.

## Purpose

- Parse a diff string into per-file **added** lines (simplified parser; not a complete diff engine).
- Emit comments with `file`, `line`, `severity`, `rule`, and `message`.
- Append each run to durable storage under `data/pr-review/{workspaceId}.json` (path follows `STORAGE_PATH` / KV—see [Storage](#storage)).

## HTTP routes

All routes use **`adminAuth`**. Paths are registered with **`apiRoute`** (`lib/server-configured-app.js`): each row’s path is prefixed with **`/api/v1`** (stable) and **`/api`** (legacy, deprecation headers). Example: `POST /api/v1/pr-review/review`.

Suffix paths:

| Method | Path | Notes |
|--------|------|--------|
| `POST` | `/pr-review/review` | Body: `workspaceId?`, `diff` (required string), `rules?` (optional array of rule ids—filters output) |
| `GET` | `/pr-review/reviews` | Query: `workspaceId?` (omitted → `"default"`) |
| `GET` | `/pr-review/reviews/:id` | Query: `workspaceId?` |
| `GET` | `/pr-review/rules` | Returns `BUILTIN_RULES` metadata |

## Built-in rules

| Rule id | Default severity | Trigger (summary) |
|---------|------------------|-------------------|
| `no-console-log` | warn | Added line matches `console.log(` |
| `todo-fixme` | info | Added line contains `TODO` or `FIXME` |
| `long-function` | warn | Added contiguous run from a function-like header exceeds 50 lines |
| `dangerous-eval` | error | Added `eval(` or `new Function(` |
| `missing-test` | info | `src/` or `*.js/ts/py/go/rs/java` changed, no test path changed in same diff |

Severity and descriptions for built-ins are also exposed as `BUILTIN_RULES` in `lib/pr-review-agent.js`.

## Environment and storage

There are **no PR-review-specific env vars**. Persistence uses `lib/json-path-store.js`:

- **`STORAGE_PATH`** sets the root (see `lib/env-data-root.js`); otherwise `./data` locally or a temp dir on Vercel.
- Optional **Postgres KV** / **SQLite KV** (when enabled) store the same logical JSON path instead of a plain file.

## Library-only: LLM augmentation

`reviewDiffWithLLM({ workspaceId, diff, prTitle, prDescription, llmClient, model })` merges heuristic comments with JSON array output from a caller-supplied `llmClient`. Behavior in code:

- If `llmClient` is omitted, it delegates to `reviewDiff` (pure heuristics).
- Diff sent to the model is **truncated to 40,000 characters**.
- LLM failures (`try/catch`) yield **no LLM comments**; heuristics still apply.
- **`llmClient` is expected** to return something like `{ content: string }` for `JSON.parse` into a comment array.

**This function is not wired to any route** in this repo; integrating it requires a new route or caller.

## Limits and retention

| Limit | Value |
|-------|--------|
| Reviews per workspace file | Last **500** runs (older entries dropped) |
| LLM diff cap (library only) | **40,000** chars |
| `workspaceId` / id sanitization | Non-alphanumerics → `_`, max **100** chars |

## Failure modes

- **400** on `POST /pr-review/review` if `diff` is missing or blank.
- **404** on fetch by id if no matching `reviewId` in that workspace store.
- **500** on unexpected errors (message passed through as `INTERNAL_ERROR` body).
- **Heuristic gaps**: complex diffs may mis-track line numbers; rules only inspect **added** lines; `missing-test` uses path heuristics only.
- **Filtered rules**: if `rules` is a non-empty array, only those rule ids are kept; unknown ids can zero out comments.

## Human-in-the-loop (HITL)

**Not implemented for PR review.** `lib/agent-hitl-store.js` exists for **execute_step** resume tokens and Agent Run stream events; nothing in `pr-review-agent` imports or calls it. There is **no approval gate** in these routes.

## Disabling or reducing exposure

- **Router**: remove `mountPrReviewRoutes` from `routes/index.js` (or stop mounting that module in your deployment entrypoint).
- **Access**: rely on `adminAuth` and network policy; there is no dedicated kill-switch flag in code for this subsystem.
- **Data**: delete or rotate `data/pr-review/*.json` under your storage root (or corresponding KV keys).

Internal test hook: `lib/pr-review-agent.js` exports `_reset(workspaceId?)` for wiping store in tests—**not** an operator API.
