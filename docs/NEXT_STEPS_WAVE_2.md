# SiskelBot — Recommended Next Steps (Wave 2)

**Status date:** 2026-04-15
**Branch:** `claude/recommend-next-steps-ff1qE`
**Supersedes:** [`docs/NEXT_STEPS.md`](NEXT_STEPS.md) (nearly all of its P1–P3 items shipped)

This doc takes fresh stock of the tree after Phase 63/64/71/72/75 and the
Wave-4 Agent Web Interface landed, and recommends the next concrete wave.

---

## Where we are

**Repo shape**

| Metric | 2026-04-14 (last doc) | 2026-04-15 (now) | Δ |
|--------|----------------------|------------------|---|
| `server.js` | 1,257 lines | 1,368 lines | **+111** (drift worse) |
| `lib/` modules | 371 | 388 | +17 |
| `routes/` modules | 195 | 231 | +36 |
| `tests/*.test.js` | 318 | 379 | +61 |
| Coverage floor (`.c8rc.json`) | 50 / 40 / 45 | 50 / 40 / 45 | unchanged |

**What shipped since `docs/NEXT_STEPS.md`**

All P1–P3 verticals from the previous plan are in tree with `lib/*.js` +
`routes/*.js` + `tests/*.test.js`, and every new route is listed in
`mountFunctions` in `routes/index.js`:

| Phase | Modules |
|-------|--------|
| 63 Code Generation | `repo-rag`, `pr-review-agent`, `test-gen`, `refactor-agent`, `migration-assistant` |
| 64 Research | `literature-search`, `paper-summary`, `citation-graph`, `experiment-bridge`, `reproducibility-checks` |
| 71 Agent Economics | `pricing-engine`, `outcome-verification`, `revenue-share`, `credit-system`, `invoicing` |
| 72 Trust & Safety Pro | `red-team-harness`, `model-card-generator`, `bias-eval-suite`, `k-anonymous-telemetry`, `safety-sla` |
| 75 Evaluation 2.0 | `eval-in-prod`, `judge-calibration`, `preference-collection`, `regression-bisection`, `synthetic-users` |

Wave-4 Agent Web Interface (see `AGENT_WEB_WIRING.md`):

- Unified realtime WebSocket at `/ws/realtime` with channel registry, resume-by-seq, optional Redis fan-out
- SPA shell at `/app` — router, command palette (Cmd+K), keyboard chords, lazy-loaded views
- Views: `chat`, `knowledge`, `runs` (list), `agent-run` (detail), `observability`, `replay`
- Artifact pipeline: durable store with inline/disk spill + `/agent/sessions/:id/artifacts` routes + SSE fan-out
- Signals strip under the chat composer (`GET /api/v1/signals/composer`, 10s poll)
- Replay & Share flow (tokenized public replay at `/r/:token`)
- Client build pipeline (`scripts/build-client.mjs`, esbuild + splitting + manifest)
- Chat deltas and presence published on unified channels

**Dead-code audit executed:** `client/*.html` trimmed from 62 → 15 files
(`AUDIT_DEAD_CODE.md` called out 31 orphans; the cleanup landed).

---

## What's still open

1. **Coverage was never actually measured.** `COVERAGE_BASELINE.md` is
   explicit that c8 didn't run ("`c8` is not installed in this sandbox").
   Per-file critical thresholds (80/75/70) exist as code in
   `scripts/check-critical-coverage.mjs`, but nothing in CI proves they
   hold after the +25 new modules landed as WIP commits.
2. **`server.js` drift got worse.** 1,073 → 1,257 → 1,368 across the last
   two waves. It is no longer a composition root — it has grown real
   logic (startup checks, middleware, WS wiring).
3. **SPA shell not yet the front door.** `/app` is opt-in; `/` still
   serves `client/index.html`. `/home` and `/recipes` in the shell are
   still `placeholderView(...)`. 15 legacy HTML pages remain
   (`admin.html`, `eval.html`, `marketplace.html`, `observability.html`,
   `compliance.html`, `traces.html`, `webhook-inspector.html`, etc.).
4. **Runs list still polls** (`setInterval` @ 5s, explicit TODO in
   `client/src/views/runs.js:256` to "upgrade to realtime channel
   run:*"). The realtime infra is shipped; the consumer hasn't been
   converted.
5. **Tree/Graph of Thought are routes only.** `lib/tree-of-thought.js`
   and `lib/graph-of-thought.js` are mounted as HTTP routes but are not
   registered in `lib/agent-tools.js`, so the agent loop cannot use
   them.
6. **25 new Phase 63/64/71/72/75 modules shipped via WIP commits.**
   Every one has a `.test.js` file, but the WIP sequencing (see
   `git log --grep=WIP` — 10+ "more phase module files" commits)
   increases the odds of stubs that pass unit tests without exercising
   real behavior.
7. **Phases 73, 74, 76–80** from `NEXT_PHASES.md` remain deferred.

---

## Recommended next steps (prioritized)

### P0 — Pay down the drift that the last two waves added

These are small, finish-what-we-started PRs. Do them before opening any
new Phase fronts.

1. **Measure coverage for real.** Install `c8`, run `npm run test:coverage`
   against the current tree (with the +25 new modules + Wave-4 client
   code), and rewrite `COVERAGE_BASELINE.md` with measured numbers. Then
   either (a) raise `.c8rc.json` thresholds to match reality, or (b) file
   specific coverage-uplift tickets for the bottom-10 modules. Do NOT
   leave the baseline doc in its current "estimate" state.

2. **WIP-commit audit for Phase 63/64/71/72/75.** For each of the 25 new
   modules, confirm:
   - `lib/*.js` exports real behavior (not `TODO`-stubbed functions)
   - `tests/*.test.js` hits more than the happy path (error paths,
     input validation, state transitions)
   - `routes/*.js` middleware chain matches the pattern in
     `routes/agent-sessions.js` (`logRequest → userAuth →
     requireScope → handler`)
   Fix or delete any that don't pass. Track in a single
   `AUDIT_PHASE_63_64_71_72_75.md`.

3. **`server.js` extraction.** It added 295 lines across the last two
   waves. Pull the drift into focused modules under `lib/` or
   `server/`:
   - WS upgrade handlers → `lib/ws-upgrade.js`
   - Startup-check orchestration → already in `lib/startup-checks.js`,
     leave it alone
   - New middleware → `lib/middleware/*.js`
   Target: `server.js` back under 1,100 lines and clearly a
   composition root again.

4. **Runs list → realtime.** Wire `client/src/views/runs.js` to
   subscribe to `run:*` on the unified WebSocket and remove the 5s
   poll. This closes the explicit TODO on line 256 of that view and
   validates that the realtime layer works for list-level updates, not
   just single-session streams.

### P1 — Finish the SPA shell and retire legacy HTML ⭐⭐⭐

The shell has all the infrastructure (router, palette, lazy-loaded
views, build pipeline, realtime). Three PRs finish the job.

5. **Port the four heaviest legacy pages** to shell views:
   `eval.html`, `admin.html`, `marketplace.html`, `observability.html`.
   For each, register a route + palette entry in `client/src/app.js`
   and delete the `.html` file. The Wave-4 views are the template:
   each is ~500 lines of vanilla JS under `client/src/views/*.js`
   with a matching `.css`.

6. **Real `home` view.** Today `placeholderView("Home", ...)`. Build a
   dashboard that surfaces: recent runs (top 5 via
   `/api/v1/agent/sessions?limit=5`), recent conversations, signal
   strip, and a "resume run" card for the last open HITL approval.
   Reuse existing route data — no new endpoints.

7. **Real `recipes` view.** Port from the CLI surface
   (`bin/siskelbot.js` `recipes list` / `run`) to a shell view that
   uses `GET /api/v1/recipes` and `POST /api/v1/recipes/:name/run`.

Gate on shipping all three: **switch `/` to serve `app.html`** and
leave `index.html` reachable only at `/legacy` for one release cycle,
then delete.

### P2 — Wire the reasoning primitives into the agent loop ⭐⭐

The tree-of-thought, graph-of-thought, self-consistency,
verification-loop, and tool-composition libraries are mounted as
routes but aren't exposed as agent tools. They cost nothing to wire
and meaningfully expand the agent's problem-solving surface.

8. Add to `lib/agent-tools.js`:
   - `tree_of_thought_plan` — enumerate n candidate plans, score, pick
   - `verify_output` — wraps `lib/verification-loop.js`
   - `self_consistency` — re-sample & majority-vote (gated by cost)
   Gate all three behind an env flag (`AGENT_REASONING_TOOLS=1`) so the
   default tool list doesn't grow unexpectedly. Add one e2e test per
   tool that runs the actual agent loop end-to-end.

### P3 — Pick one vertical to productize ⭐⭐⭐

With Phases 63 + 64 + 71 all shipped in skeleton form, one of them
should be chosen as the first production vertical and polished.
Polishing means: agent tools, docs, example recipes, eval set, design
partner. Don't polish two in parallel.

- **Phase 63 Code Generation** if any inbound signal is for dev-tool
  use. Highest reuse of existing infra (GitHub MCP, agent loop,
  knowledge graph). Requires: expose `search_repo`, `propose_patch`,
  `run_tests` as agent tools; ship a `/app/recipes/code-review`
  canned recipe; wire `lib/repo-rag.js` to workspaces where
  `WORKSPACE_FILE_TOOLS=1`.
- **Phase 71 Agent Economics** if monetization pressure dominates.
  Requires: end-to-end flow from `pricing-engine.js` through
  `credit-system.js` to `invoicing.js` with a test workspace that
  actually debits credits; Stripe webhook adapter;
  `/app/billing` view; per-workspace usage caps with graceful
  degradation.
- **Phase 64 Research pack** if a research / ML-user partner exists.
  Smallest TAM of the three; defer unless there's a specific ask.

### P4 — Deferred

- **Phase 73 Federated Learning** — `lib/federated-training.js` and
  friends already exist; the route surface is wired. True federation
  needs a multi-tenant design partner first.
- **Phase 74/76–80** — as before, deferred until P3 vertical has a
  live design partner.

---

## Out of scope for this wave

- Refactoring the plugin system (`lib/plugins-loader.js`,
  `lib/plugin-sandbox.js`, `lib/plugin-worker.js`). It's stable and
  risky to touch without a concrete requirement.
- Adding new storage backends. JSON / SQLite / Postgres cover all
  current deployment scenarios.
- Further HTML deletion beyond the SPA port in P1.

---

## Execution guidance

- Same 5-subtask shape when opening a new phase.
- Every subtask: `lib/*.js` + `routes/*.js` + `tests/*.test.js` + wire
  in `routes/index.js::mountFunctions`. If the lib module is also an
  agent tool, register it in `lib/agent-tools.js` and add an e2e
  agent-loop test.
- Do not ship without tests that exercise error paths — the
  WIP-commit pattern from the last wave left unit tests that mostly
  assert the happy path.
- Run `npm run eval:ci` on any PR that touches `lib/agent-*`,
  `lib/gbrain*`, `lib/eval-*`, `lib/repo-rag.js`, or any reasoning
  primitive.
- Parallel worktrees + per-agent `AGENT_*_WIRING.md` docs continue to
  work well; keep the pattern.
