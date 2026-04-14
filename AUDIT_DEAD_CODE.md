# Dead Code Audit

Audit of SiskelBot `client/*.html` pages and `lib/*.js` modules conducted 2026-04-14.

## Summary counts

| Scope | Total | Orphaned / Unimported | Safe to delete | Kept (needs review) |
|-------|-------|-----------------------|----------------|---------------------|
| `client/*.html` (non-protected) | 41 | 31 | 31 | 0 |
| `lib/*.js` | 360 | 2 | 1 | 1 (plugin-worker, loaded via Worker thread) |

Protected HTML (untouched per task rules): `index.html`, `app.html`, `admin.html`, `eval.html`.

Test-only lib modules: 13 (kept; not moved).

Dynamic-suspected lib modules (import path not matched statically but name appears as string): 0 genuine — `plugin-worker.js` is loaded via `new Worker(path)` in `plugin-sandbox.js` and must be kept.

## Methodology

- **HTML**: For each non-protected `client/*.html`, the full repo (excluding `node_modules`, `build`, `coverage`, `dist`, `sdk`, `vendor`, `.git`) was searched for the basename (e.g. `foo.html`). Candidates with non-zero references were then traced to verify whether the referrer is itself an orphan (transitive orphan).
- **Lib**: For each `lib/*.js`, the repo was grepped for `/<basename>` (matches both `./lib/foo.js` and `../lib/foo.js` imports) outside the file itself. Test references were counted separately. The module name (without `.js`) was also searched as a bare string literal to flag dynamic-suspected usage.
- **Routes**: Only reported, not touched. Routes are mounted via `mountAllRoutes` in `routes/index.js`.

## Orphaned HTML pages (deleted)

Two tiers of orphans: zero-reference (27) and transitive orphans whose only referrers are themselves orphans (4).

### Zero-reference orphans

| File | Lines |
|------|-------|
| `client/adapters.html` | 554 |
| `client/agent-marketplace.html` | 728 |
| `client/continuous-learning.html` | 352 |
| `client/dashboard-builder.html` | 541 |
| `client/developer.html` | 586 |
| `client/entitlement-reviews.html` | 644 |
| `client/experiments.html` | 581 |
| `client/gallery.html` | 643 |
| `client/gbrain.html` | 665 |
| `client/hierarchy-viewer.html` | 371 |
| `client/missions.html` | 574 |
| `client/models.html` | 921 |
| `client/pq-migration.html` | 455 |
| `client/preference-builder.html` | 691 |
| `client/privacy-budget.html` | 553 |
| `client/query-analyzer.html` | 591 |
| `client/recipe-marketplace.html` | 593 |
| `client/referrals.html` | 552 |
| `client/runbooks.html` | 497 |
| `client/security-scorecard.html` | 483 |
| `client/slo.html` | 388 |
| `client/synthetic.html` | 480 |
| `client/transcript.html` | 393 |
| `client/voice-chat.html` | 444 |
| `client/voice-clone.html` | 667 |
| `client/webhook-builder.html` | 588 |
| `client/zero-to-hero.html` | 432 |

### Transitive orphans (only referenced by other orphans)

| File | Lines | Only referenced by |
|------|-------|--------------------|
| `client/analytics.html` | 391 | continuous-learning.html, dashboard-builder.html (both orphans) |
| `client/dashboard-view.html` | 212 | dashboard-builder.html (orphan) |
| `client/health.html` | 382 | security-scorecard.html, synthetic.html (both orphans) |
| `client/playground.html` | 735 | voice-clone.html, webhook-builder.html (both orphans) |

### HTML pages retained (references found in code/docs/protected surfaces)

- `compliance.html` — `docs/COMPLIANCE.md`
- `explain.html` — linked from `compliance.html` (kept)
- `marketplace.html` — `routes/plugins.js` uses `res.sendFile(...marketplace.html)`
- `observability.html` — linked from `traces.html` (kept)
- `r.html` — `routes/referrals.js` redirects to `/r.html`
- `screen-share.html` — `docs/WEBRTC.md`
- `shared.html` — `lib/conversation-sharing.js` emits `/shared.html?id=...` URLs
- `status.html` — `docs/AGENT_B_WIRING.md`, `docs/NEXT_PHASES.md`
- `traces.html` — `docs/TRACING.md`, `routes/traces.js`
- `webhook-inspector.html` — `docs/NEXT_PHASES.md`, `AGENT_C_WIRING.md`
- `xr.html` — loaded by `client/js/xr-session.js`

## Unimported lib modules

### Safe to delete

| File | Lines | Notes |
|------|-------|-------|
| `lib/storage-optimizer.js` | 127 | No static imports anywhere; exports `createIndex`/`batchRead`/`watchForChanges` but nothing references this file by path. Mentioned only in `CLAUDE.md`. |

### Not deleted (needs owner review)

| File | Lines | Reason |
|------|-------|--------|
| `lib/plugin-worker.js` | 54 | Dynamic-suspected: loaded at runtime via `new Worker(resolve(__dirname, "plugin-worker.js"))` in `lib/plugin-sandbox.js`. Static grep does not match because the path is resolved via `__dirname`. Keeping. |

## Test-only lib modules (not moved; candidates for future review)

These modules are imported only from `tests/` — they may be slated for removal or relocation, but the task rules instruct to err on the side of keeping.

| File | Lines |
|------|-------|
| `lib/agent-delegation.js` | 176 |
| `lib/api-key-scopes.js` | 87 |
| `lib/crdt-sync.js` | 126 |
| `lib/experiment-sdk.js` | 167 |
| `lib/i18n-errors.js` | 158 |
| `lib/mission-runner.js` | 243 |
| `lib/mtls.js` | 208 |
| `lib/observability.js` | 310 |
| `lib/response-helpers.js` | 16 |
| `lib/tenant-isolation.js` | 124 |
| `lib/workspace-migration.js` | 322 |
| `lib/workspace-rate-limit.js` | 147 |
| `lib/zero-to-hero.js` | 531 |

## Dynamic-suspected lib modules

None identified that are simultaneously both (a) missing static imports AND (b) plausibly loaded dynamically via some bundler/manifest — except for `plugin-worker.js`, which is unambiguously loaded via `worker_threads` and therefore kept.

## Routes (reported only, not touched)

All 37+ route modules are mounted via `mountAllRoutes` in `routes/index.js`. No route files are being deleted by this audit per the task rules. (Some route files such as `routes/traces.js`, `routes/referrals.js`, and `routes/plugins.js` still serve kept HTML pages directly; this dependency was the main reason several HTML pages were retained.)

## Deletion plan

**Deleted (total 32 files):**

- 31 orphaned HTML pages (listed above).
- 1 unimported lib module: `lib/storage-optimizer.js`.

**Deferred (needs review):**

- `lib/plugin-worker.js` — loaded dynamically; retain.
- 13 test-only lib modules — retained per "err strongly toward keeping" rule.

## Test verification

The full `node --test tests/` suite was executed after deletions. Results are recorded in the commit that accompanies this audit.
