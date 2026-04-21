# PR Review Agent (Phase 63.2)

`lib/pr-review-agent.js` runs deterministic heuristic rules against added
lines in a unified diff and stores reviews per workspace.

## API surface

| Export | Purpose |
|--------|---------|
| `BUILTIN_RULES` | Frozen list of built-in rules: `no-console-log`, `todo-fixme`, `long-function`, `missing-test`, `dangerous-eval` |
| `parseDiff(diff)` | Parse a unified diff into per-file added-line records |
| `reviewDiff({ workspaceId, diff, rules })` | Run rules over a diff, persist a review |
| `getReview(reviewId, workspaceId)` | Look up a stored review |
| `listReviews(workspaceId)` | List recent reviews (newest first) |

## Storage

`data/pr-review/{workspaceId}.json`. Capped at 500 reviews per workspace
(oldest evicted on overflow).

## Inputs and limits

- `diff` must be a string in unified-diff format (`+++ b/<path>` headers,
  `@@ ... @@` hunks, `+`/`-`/` ` line prefixes). Binary diffs and rename-only
  diffs are silently skipped (no `addedLines`).
- `rules` is optional; when omitted, `BUILTIN_RULES` are applied. Custom
  rules must shape-match `{ id, severity, description, match(line) -> bool }`.
- `workspaceId` is sanitised: anything outside `[a-zA-Z0-9._-]` is replaced
  with `_`, and the value is truncated to 100 chars.

## Failure modes

| Symptom | Cause | Mitigation |
|--------|------|-----------|
| Review returns zero comments on a non-trivial diff | Diff lacks `+++ b/...` headers (raw patch fragment) | Pre-pend the headers or supply a properly-formatted unified diff |
| `dangerous-eval` not flagging dynamic `Function()` | Rule matches `new Function(` exactly — variants with whitespace can slip past | Add a custom rule, or extend `BUILTIN_RULES` upstream |
| `missing-test` false positives on docs-only PRs | Heuristic only checks for matching `*.test.*` paths next to source | Pre-filter the diff before submission, or accept the noise |
| `long-function` misses Python | Rule uses brace counting | Treat as JS/TS-only today; do not rely on it for Python PRs |
| `getReview` returns `null` for a known id | Workspace mismatch, or review evicted past the 500-cap | Use `listReviews` to confirm presence and surface the cap to operators |

## HITL guarantees

This module is **comment-only** — it never posts to GitHub. Any caller
wiring it to GitHub MCP tools (`mcp__github__add_comment_to_pending_review`)
**MUST** route through `lib/agent-hitl-store.js` and require explicit
operator approval. Auto-posting is an operator opt-in, not a default.

## Disabling

There is no global feature flag — the module ships always-on. To remove
the agent surface, do not register `routes/pr-review.js` in
`routes/index.js`. To suppress a specific rule, pass an explicit `rules`
array omitting it.

## Related

- `lib/repo-rag.js` for code search the agent can use as evidence
- `lib/agent-hitl-store.js` for approval gating before posting comments
- `lib/policy-audit.js` for org-wide policy on auto-posting
