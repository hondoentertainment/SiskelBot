# Agent E2E pipeline tests

## Philosophy

Our 1000+ unit tests pin individual modules (scrubber, judge, analyzer,
genealogy, feedback store, prompt tuner, etc.) but give us zero coverage of
what happens when they run together inside `runAgentLoop`. A regression
split across five modules can silently pass unit tests while breaking the
production pipeline. The tests in this directory drive one full agent
request through `runAgentLoop` with all quality features enabled and assert
the cross-module effects: scrubber runs BEFORE judge, feedback flows into
the next prompt, genealogy outcomes persist, etc.

These tests use `node:test` and `node:assert/strict`, mock only the
backend HTTP fetch, isolate storage via `mkdtempSync` + `STORAGE_PATH`,
and save/restore environment variables in `try/finally`. No real LLM, no
real network, no Playwright. Each file runs in under 1 second.

## Test matrix

| File | What it covers | Load-bearing assertion |
|------|----------------|------------------------|
| `agent-full-pipeline.test.js` | Happy path with ALL features on (judge, scrub, trajectory, metrics, genealogy). | Genealogy stores one success for `search_context`; failure store stays empty; Prometheus counter increments; judge appends no advisory on clean result. |
| `agent-feedback-loop.test.js` | 10 thumbs-down with tag `hallucination` -> `synthesizePatch` -> `setPatchStatus(applied)` -> next run. | The patch content appears as a system-role message in the very next outbound LLM body. `basis.topComplaintTags` contains `hallucination(10)`. |
| `agent-safety-pipeline.test.js` | Real knowledge doc containing AWS + Anthropic keys, indexed into an isolated KB, retrieved via `search_context`. | Raw secrets appear in ZERO outbound LLM bodies (neither agent rounds nor judge prompts); `[REDACTED_*]` markers appear in round-2 tool-role content. |
| `agent-replan-recommender.test.js` | Seeded genealogy + failure store; scripted `web_search` failure; chronic-history avoidance hint; recommender surfaces `search_context`. | Round-2 system message contains the classifier category marker AND the chronic-history avoidance hint; genealogy shows the new failure persisted; recommender ranks `search_context` first. |

## Running

Single file:
```bash
node --test tests/e2e/agent-full-pipeline.test.js
```

Whole E2E suite:
```bash
node --test tests/e2e/agent-*.test.js
```

## How to add a new E2E test

1. Start with the smallest scripted scenario that exercises the interaction
   you're worried about (one tool call, one replan, one injection, etc.).
2. Isolate storage at the top of the file:
   ```js
   const TMP_ROOT = mkdtempSync(join(tmpdir(), "e2e-foo-"));
   process.env.STORAGE_PATH = TMP_ROOT;
   ```
   Save any env var you intend to modify into a `savedEnv` object and
   restore it in `test.after`.
3. Import the public exports you need AFTER setting env. Many modules read
   env vars at import time; a late `process.env.STORAGE_PATH=` assignment
   won't take effect.
4. Write a `scriptedBackend` helper inline. Capture every outbound body in
   an array so you can assert what the loop sent. If you enable the judge,
   filter judge prompts (they carry a `"JSON-only judge"` system message)
   out of the agent-round body list before indexing.
5. Assert data in the stores directly (`loadToolOutcomes`, `loadFailureStats`,
   etc.) — these are the durable side effects the pipeline is supposed to
   produce.
6. Keep the test under 10 seconds. If you need to populate large state,
   use the bulk record helpers (e.g., `recordToolOutcomes`), not loops of
   single-record calls.

## Known limitations

- **No real LLM**: We mock `backendFetch` so the LLM never makes a real
  network call. Tests verify the shape and content of what the loop WOULD
  send; they cannot verify that a real model does the right thing with it.
- **No real workspace filesystem**: `workspace_read_file` and similar tools
  are not exercised. Tests that need realistic tool output (e.g., the
  safety pipeline) seed the knowledge store directly via `indexDocument`.
- **Recommender not yet wired into `runAgentLoop`**: The alternative
  recommender module (`lib/tool-alternative-recommender.js`) is a public
  export but is not currently invoked from the agent loop. The
  `agent-replan-recommender.test.js` test drives the recommender in-test
  against the same genealogy the loop produced, to prove the data pipeline
  is complete. When the loop is wired to call `recommendAlternatives` and
  pass `alternatives` into `analyzeAndBuildReplan`, extend that test to
  assert the `Consider these alternatives instead:` marker in the round-2
  outbound body.
- **Metrics are process-global**: `renderPrometheus` reads counters that
  other tests may have touched. Each file calls
  `__resetAgentQualityMetricsForTests()` where it matters, but counters
  for things like HTTP request latency are not reset.
