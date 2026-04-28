# API Versioning

SiskelBot uses path-based API versioning. Each major version has its own URL prefix, its own OpenAPI document, and its own deprecation timeline.

## Versions

| Version | Prefix | Status |
|---|---|---|
| v1 | `/api/v1/` (and legacy `/api/`) | Stable; receives additive changes only |
| v2 | `/api/v2/` | Active; new resources, structured errors |

The legacy `/api/` prefix is mounted via `dualRegister` (see `routes/index.js`) and emits the `X-API-Deprecated: use /api/v1/` header. v2 routes use `lib/api-v2-errors.js` (`apiV2Error`) for machine-readable error codes and rename some resources (e.g. `context` -> `documents`). See [`API_V2_PLAN.md`](./API_V2_PLAN.md) for the full v1 -> v2 rename table.

## OpenAPI specs

Each version has its own OpenAPI document. The source of truth is `lib/openapi-spec.js`; generated artifacts live under `docs/openapi.yaml`.

Regenerate with:

```bash
npm run openapi:generate
```

## Change classes

Any API change must fall into one of three buckets:

### Breaking (requires next major version)

- Removing an endpoint or HTTP method
- Removing or renaming a previously-required request field, query param, or path param
- Adding a new **required** request field or param
- Removing a previously-documented response status code
- Tightening a value's allowed enum / pattern / type
- Renaming a response field (clients depend on the old name)

Breaking changes go into the **next** major version (e.g., v2 -> v3). They never land in the current stable version.

### Non-breaking (current version)

- Adding a new endpoint or HTTP method
- Adding a new **optional** request field or param
- Adding a new response field (existing clients ignore unknown fields)
- Adding a new response status code (e.g., a new `409` for an existing resource)
- Loosening a value's allowed enum / pattern
- Adding new headers (informational)

These ship into the current major version without bumping it.

### Cosmetic

- Description, summary, example, or tag updates
- Documentation-only changes

These are recorded in the changelog but never affect clients.

## Deprecation policy

When an endpoint, field, or behavior is deprecated:

1. Mark the operation `deprecated: true` in the OpenAPI spec.
2. Emit the response header `X-API-Deprecated: use <replacement>` from the route handler.
3. Note the deprecation in the changelog entry that introduces the replacement.
4. Wait at least **90 days** before removing the deprecated surface. Removal is a breaking change and must roll into the next major version.

## Automated changelog

PRs that touch `lib/openapi-spec.js`, `routes/**`, or the OpenAPI tooling automatically run [`.github/workflows/openapi-diff.yml`](../.github/workflows/openapi-diff.yml). The workflow:

1. Generates the OpenAPI spec from the PR base (target branch).
2. Generates the OpenAPI spec from the PR head.
3. Runs [`scripts/openapi-diff.mjs`](../scripts/openapi-diff.mjs), which categorizes the diff into **Breaking**, **Added**, and **Changed** buckets.
4. Posts a Markdown changelog as a PR comment, attaches it as an artifact (`api-changelog`), and writes it to the GitHub Step Summary.

The workflow does **not** fail the build on breaking changes — a human reviewer decides whether the change is intentional and whether it warrants a major version bump.

### Manual changelog refresh

To produce a changelog locally between any two OpenAPI documents:

```bash
node scripts/openapi-diff.mjs path/to/old.yaml path/to/new.yaml --output=docs/CHANGELOG_API.md
```

The script supports YAML (via the `yaml` or `js-yaml` packages, when available) and JSON. Exit code is `0` when the diff is purely additive and `1` when at least one breaking change is detected — handy for ad-hoc gating in scripts.

## Related docs

- [`API_V2_PLAN.md`](./API_V2_PLAN.md) — v1 -> v2 migration plan and rename table
- [`API_COOKBOOK.md`](./API_COOKBOOK.md) — common request patterns
- [`PLUGIN_API.md`](./PLUGIN_API.md) — plugin-facing surface
