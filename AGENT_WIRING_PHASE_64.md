# Phase 64 — Research pack — Wiring

This phase adds five research-workflow modules: literature search, paper
summarization, a citation graph, an experiment-tracking bridge, and a
reproducibility-check engine. All are offline/local — no live HTTP
and no new npm dependencies.

## Modules

### 64.1 Literature search — `lib/literature-search.js`

Unified façade over arXiv, PubMed, and Semantic Scholar. Does not make
HTTP calls; stubs return deterministic mock results generated from a
SHA-256 of `(source, query, index)`. A `LITERATURE_SEARCH_LIVE=1`
environment toggle is documented for future live wiring but is **not**
implemented (the stub layer returns the same shape either way).

Exports: `searchArxiv`, `searchPubmed`, `searchSemanticScholar`,
`unifiedSearch`, `recordSearch`, `listSearches`, `listSources`,
`LITERATURE_SOURCES`, `_reset`.

Record shape: `{ id, title, authors, year, abstract, source, url }`.

Storage: `data/literature-search/{workspaceId}.json` with a ring buffer
of the last 500 searches per workspace.

### 64.2 Paper summary — `lib/paper-summary.js`

Heuristic abstract summarizer. Splits on sentence terminators, extracts
tldr (first sentence), up to 5 key points matching signal phrases
(`we show/propose/introduce`, `result`, `our approach`, `outperform`,
`state-of-the-art`), and tags one sentence each for methodology,
findings, and limitations. Reading time = `ceil(wordCount / 200)`.

Exports: `summarizePaper`, `recordSummary`, `listSummaries`,
`getSummary`, `_reset`.

Storage: `data/paper-summary/{workspaceId}.json` keyed by summary id;
`_index.json` maps summary-id → workspace for workspace-agnostic
`getSummary`.

### 64.3 Citation graph — `lib/citation-graph.js`

Per-workspace directed citation graph. Stores `papers` by id,
`cites` (outgoing adjacency), and `citedBy` (inverse). Adding a citation
auto-creates both endpoints. `getSubgraph` runs undirected BFS up to
depth 10; `findShortestPath` is undirected BFS returning the path or
null. Duplicate citations are ignored.

Exports: `addPaper`, `addCitation`, `getNeighbors`, `getSubgraph`,
`findShortestPath`, `listPapers`, `getCitationCount`,
`VALID_DIRECTIONS`, `_reset`.

Storage: `data/citation-graph/{workspaceId}.json`.

### 64.4 Experiment bridge — `lib/experiment-bridge.js`

Local W&B/MLflow-style tracker. Each experiment stores:
- `config` (static at creation time)
- `params` (merge-on-log)
- `metrics` (time-series per metric name: `{ step, value, timestamp }[]`)
- `artifacts` (ref list: `{ id, name, description, sizeBytes, timestamp }`)

`compareExperiments(ids)` returns a metric-indexed table whose cells are
the latest metric value per experiment (`null` when absent).

Exports: `createExperiment`, `logMetric`, `logParams`, `logArtifact`,
`getExperiment`, `listExperiments`, `compareExperiments`, `_reset`.

Storage: `data/experiment-bridge/{workspaceId}.json`; `_index.json` maps
experiment-id → workspace.

### 64.5 Reproducibility checks — `lib/reproducibility-checks.js`

Weighted checklist engine. Default checklist has 8 items (code SHA,
seed, dataset hash, lockfile, hardware, env, metrics, artifacts) with
per-item `weight` and `required` flags. `runCheck` returns
`{ passed, failed, skipped, score, grade, requiredSatisfied, ... }`.
Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, else F.

Exports: `createCheck`, `runCheck`, `getCheckReport`, `listChecks`,
`getDefaultChecklist`, `_reset`.

Storage: `data/reproducibility-checks/{workspaceId}.json`; `_index.json`
maps check-id → workspace.

## Routes

All route modules follow the established `mount{Name}Routes(app, deps)`
pattern and use `adminAuth`. None of them are registered in
`routes/index.js` yet (per the hard constraint not to edit that file —
wiring into `mountAllRoutes` is deferred to a follow-up).

| File | Mount function | Endpoints |
|------|----------------|-----------|
| `routes/literature-search.js` | `mountLiteratureRoutes` | `GET /literature/sources`, `POST /literature/search`, `POST /literature/arxiv`, `POST /literature/pubmed`, `POST /literature/s2`, `GET /literature/history` |
| `routes/paper-summary.js` | `mountPaperSummaryRoutes` | `POST /paper-summary/summarize`, `POST /paper-summary/record`, `GET /paper-summary/summaries`, `GET /paper-summary/summaries/:id` |
| `routes/citation-graph.js` | `mountCitationGraphRoutes` | `POST /citation-graph/papers`, `POST /citation-graph/citations`, `GET /citation-graph/papers`, `GET /citation-graph/path`, `GET /citation-graph/:paperId/neighbors`, `GET /citation-graph/:paperId/subgraph`, `GET /citation-graph/:paperId/count` |
| `routes/experiment-bridge.js` | `mountExperimentRoutes` | `POST /experiments`, `GET /experiments`, `POST /experiments/compare`, `GET /experiments/:id`, `POST /experiments/:id/metrics`, `POST /experiments/:id/params`, `POST /experiments/:id/artifacts` |
| `routes/reproducibility-checks.js` | `mountReproducibilityRoutes` | `GET /reproducibility/default-checklist`, `POST /reproducibility/checks`, `POST /reproducibility/checks/:id/run`, `GET /reproducibility/checks`, `GET /reproducibility/checks/:id` |

## Wiring into the server (next step)

When ready, add to `routes/index.js` inside `mountAllRoutes(app, deps)`:

```js
import mountLiteratureRoutes from "./literature-search.js";
import mountPaperSummaryRoutes from "./paper-summary.js";
import mountCitationGraphRoutes from "./citation-graph.js";
import mountExperimentRoutes from "./experiment-bridge.js";
import mountReproducibilityRoutes from "./reproducibility-checks.js";

// ...inside mountAllRoutes:
mountLiteratureRoutes(app, deps);
mountPaperSummaryRoutes(app, deps);
mountCitationGraphRoutes(app, deps);
mountExperimentRoutes(app, deps);
mountReproducibilityRoutes(app, deps);
```

The routes assume `deps = { apiRoute, apiError, logRequest, adminAuth }`,
matching the existing Phase 51.4 `policy-audit` wiring.

## Testing

```bash
node --test tests/literature-search.test.js \
            tests/paper-summary.test.js \
            tests/citation-graph.test.js \
            tests/experiment-bridge.test.js \
            tests/reproducibility-checks.test.js
```

54 tests, all passing as of this commit.

## Constraints observed

- No edits to `routes/index.js`, `server.js`, or `package.json`.
- No new npm dependencies.
- No live HTTP calls (literature-search is stub-only).
- Every lib module exports `_reset()` for test isolation.
- All writes go through `withPathLock` for atomicity.
- `sanitizeId` caps workspace / paper / experiment IDs to safe characters.
