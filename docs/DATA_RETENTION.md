# Data Retention Policy

## 1. Overview

SiskelBot stores several distinct categories of user and operational data. This
document defines default retention periods, the rationale for each, and the
tools available to enforce them.

> Operators MUST configure retention to match their jurisdiction's
> requirements (GDPR, CCPA, HIPAA, SOC 2, etc.). The defaults below are
> reasonable starting points for a privacy-aware deployment, **not** legal
> advice.

Cross-references:

- `docs/COMPLIANCE.md` — control mappings, GDPR/SOC 2/HIPAA reports, DSR / right-to-erasure endpoints.
- `docs/RUNBOOKS/migration_failure.md` — schema migration recovery (relevant when running purge migrations).
- `docs/RUNBOOKS/webhook_dlq_drain.md` — manual DLQ purge when capacity caps trigger.
- `docs/RUNBOOKS/disk_full.md` — emergency cleanup when retention has not kept up.

## 2. Data inventory

Table names below are the **actual** names defined in `migrations/` or implied
by the JSON-path key used by `lib/json-path-store.js`. JSON-file and SQLite KV
backends use the same logical paths; Postgres backends materialise these into
the tables shown.

| Category | Storage | Contains | Default retention | Compliance basis |
|---|---|---|---|---|
| Conversations & messages | `storage_kv` (path: `users/{u}/workspaces/{w}/conversations.json`) | User chat history, assistant responses, tool I/O, ratings | Indefinite (no built-in expiry) | GDPR Art. 5(1)(e) — operator must enforce minimization |
| Agent run sessions | `agent_sessions` (Postgres) and `storage_kv` path `agent-sessions.json` | Plan summary/DAG, tool calls, intermediate state, iterations | Indefinite (capped at `AGENT_SESSIONS_MAX_STORE`, default 4000 sessions) | Operational |
| Agent run trajectories (in-memory snapshots) | Process memory | Stepwise execution snapshots for replay/branching | `AGENT_TRAJECTORY_TTL_MS` (default 10 min) | Auto-expires |
| Agent long-term memory | `agent_memory` (Postgres) and `data/memory/{u}/{w}/memories.json` | Facts, preferences, observations, learned context | Indefinite, capped at 1000 entries per user/workspace (FIFO eviction) | User can delete via API |
| Knowledge base documents & chunks | `storage_kv` and `data/knowledge/{w}.json` (json-path-store) | User-uploaded files, chunked content, parsed text | Until deleted by user | User-controlled |
| Knowledge graph entities/relations | `data/knowledge-graph/{w}.json` (json-path-store) | Extracted entities and typed relations | Tied to source documents | Indirect |
| Embeddings | `lib/embedding-cache.js` (memory + disk) | Vector representations of text | Tied to source documents; cache LRU | N/A |
| Audit log | `audit_log` (Postgres) | Authentication events, admin actions, data access, config changes | `AUDIT_RETENTION_DAYS` (default **90 days**) | SOC 2 CC7, regulatory |
| Audit log archive (S3) | S3 prefix (`AUDIT_ARCHIVE_*` envs) | Older audit entries moved by `lib/audit-lifecycle.js` | Operator-defined S3 lifecycle | SOC 2 CC7 |
| API keys | `api_keys` (Postgres) | Hashed key (`key_hash`), scopes, last-used timestamp, revoke timestamp | Until revoked (soft delete via `revoked_at`) | Security |
| Workflows & runs | `workflows`, `workflow_runs` (Postgres) | DAG definitions and execution outputs | Indefinite | Operational |
| Webhook DLQ | `data/webhook-dlq.json` (json-path-store, in-process) | Failed webhook payloads after retries | FIFO cap of 500 entries (`DLQ_MAX` in `lib/webhook-delivery.js`) | Operational |
| Web sessions | `express-session` cookie store | Login session ID | 7 days (cookie `maxAge`, hardcoded in `server.js`) | Auto-expires |
| Idempotency keys | KV / memory | Replay-protection records | `IDEMPOTENCY_TTL_MS` (default 24h) | Auto-expires |
| Knowledge search cache | In-memory + distributed query cache | Cached search results | `KNOWLEDGE_SEARCH_CACHE_TTL_MS` (default 30s) | Auto-expires |
| Plugin install records | `storage_kv` workspace plugin entries | Per-workspace plugin enablement | Until disabled | N/A |
| Container / application logs | External log collector (out of scope) | Application stdout/stderr | Operator-defined | Out of scope for this doc |

> The values above were derived from `migrations/`, `lib/storage.js`,
> `lib/agent-session.js`, `lib/agent-memory.js`, `lib/audit-lifecycle.js`,
> `lib/webhook-delivery.js`, `lib/embeddings.js` and `.env.example`. If you add
> a new persistent store, extend this table.

## 3. Retention enforcement

| Category | Mechanism | Where |
|---|---|---|
| Audit log | **Automatic daily cron** archive-then-purge | `lib/audit-lifecycle.js` (`scheduleAuditLifecycle()` invoked at boot). Honours `AUDIT_RETENTION_DAYS`. |
| Agent trajectories | TTL eviction in process | `lib/agent-trajectory.js`, `AGENT_TRAJECTORY_TTL_MS` |
| Agent memory | Bounded queue (1000) + opportunistic consolidation | `lib/agent-memory.js`, `AGENT_MEMORY_CONSOLIDATE` |
| Agent sessions | Bounded queue (`AGENT_SESSIONS_MAX_STORE`, default 4000) | `lib/agent-session.js` |
| Webhook DLQ | FIFO cap at 500 (drops oldest on overflow) | `lib/webhook-delivery.js`, `DLQ_MAX` |
| Sessions | Cookie `maxAge` = 7d | `server.js` |
| Idempotency keys | TTL eviction | `IDEMPOTENCY_TTL_MS` |
| Search cache | TTL eviction | `KNOWLEDGE_SEARCH_CACHE_TTL_MS` |
| Conversations | **Manual / user-initiated** | No automated expiry; deletion via UI / `DELETE /api/v1/conversations/:id` |
| Knowledge base | **User-initiated** | Deletion via UI / API / `siskelbot context` tooling |
| Right-to-erasure (per-user wipe) | Admin endpoint | `POST /api/v1/compliance/right-to-erasure?userId=X&confirm=true` |
| API keys | Admin revocation | Sets `revoked_at`; row retained for audit attribution |

### Retention environment variables

These are the env vars that currently drive automated retention in the
codebase (verified against `.env.example` and source). All other categories
require manual or user-initiated cleanup.

| Variable | Default | Effect |
|---|---|---|
| `AUDIT_RETENTION_DAYS` | `90` | Drops audit entries older than N days (after archive). |
| `AGENT_TRAJECTORY_TTL_MS` | `600000` (10 min) | TTL for in-process agent trajectory snapshots. |
| `IDEMPOTENCY_TTL_MS` | `86400000` (24h) | TTL for idempotency replay-protection records. |
| `KNOWLEDGE_SEARCH_CACHE_TTL_MS` | `30000` (30s) | TTL for search-result cache entries. |
| `LEADER_TTL_MS` | (impl. default) | Leader-election lease TTL — operational, not user data. |
| `AGENT_SESSIONS_MAX_STORE` | `4000` | Cap on durable agent session count (oldest dropped). |
| `AGENT_SESSION_MAX_EVENTS` | `400` | Cap on events per session (oldest trimmed). |

### CLI-driven cleanup

There is **no** dedicated `siskelbot admin purge` command at present. Conversation
and knowledge-base cleanup must be done via:

- The web UI (per-conversation / per-document delete buttons).
- The HTTP API (`DELETE /api/v1/conversations/:id`, `DELETE /api/v1/context/:id`).
- The compliance erasure endpoint for a full per-user wipe (see Section 4).

If you need bulk retention beyond the audit log, add it as a scheduled job
(`lib/scheduler.js`) that walks `storage.list("conversations", ...)` and
deletes by `createdAt` cutoff. This is a recommended future enhancement.

## 4. User data deletion (right to erasure)

GDPR Article 17 / CCPA deletion is implemented through the compliance API:

| Step | Endpoint |
|---|---|
| Subject access (DSR) | `POST /api/v1/compliance/data-subject-request?userId=<id>` |
| Data export (portability) | `GET /api/v1/compliance/export/:userId?format=json` |
| Erasure | `POST /api/v1/compliance/right-to-erasure?userId=<id>&confirm=true` |

All three require an admin API key (`ADMIN_API_KEY`) or a session belonging
to a user listed in `QUOTA_ADMIN_USER_IDS`.

**What erasure removes** (best effort across enabled backends):

- Conversations and messages for the user.
- Agent sessions, memory entries, trajectories.
- Knowledge base documents and embeddings owned by the user.
- API keys (revocation marker is retained for audit linkage).
- Workspace memberships (the workspace itself is retained if shared).

**What erasure retains** (and why):

- Audit log entries that *reference* the user — required for SOC 2 / regulatory
  attribution. The erasure event itself is recorded.
- Aggregated metrics (Prometheus counters) — not personally identifiable.
- Backup snapshots taken before the deletion (see Section 5).

**Time to fulfill:** GDPR Article 12 sets a one-month default. Operators
should aim to complete primary-storage erasure synchronously and ensure
backup-window expiry within 30 days.

## 5. Backup retention (separate from primary data retention)

> The bundled Helm chart in `helm/siskelbot/templates/` does **not** ship a
> `backup-cronjob.yaml`. Operators are expected to configure backups at the
> database/object-store layer (e.g. managed Postgres point-in-time recovery,
> S3 lifecycle on the audit archive, Velero for the cluster).

Recommended retention windows:

| Backup type | Recommended retention |
|---|---|
| Postgres full snapshots | 30 days for production, 7 days for staging |
| Postgres WAL / PITR | 7 days minimum |
| Audit log S3 archive | Match `AUDIT_RETENTION_DAYS` × 10 (operator policy) or longer to satisfy SOC 2 / regulatory windows (often 7 years) |
| Knowledge base file storage (if backed by object storage) | Same as primary retention plus rolling 30 days |

**Important interaction with right-to-erasure:** backups taken before an
erasure request will still contain the deleted data. To remain compliant:

1. Track erasure requests in a tombstone table (the audit event is sufficient).
2. Either wait out the backup retention window before declaring the erasure
   complete, **or** re-apply tombstones automatically after any restore by
   replaying compliance erasure events from the audit log.
3. Document this lag in your privacy notice.

## 6. Compliance notes

These are defaults — operators should validate against their own counsel.

- **GDPR.** Personal data must be minimized (Art. 5(1)(e)) and subjects have
  the right to erasure (Art. 17). The defaults in this document support
  compliance once a conversation-retention job is configured (see Section 3,
  CLI-driven cleanup). The erasure endpoint (Section 4) covers Art. 17.
- **CCPA.** California users have the right to know, delete, and opt out.
  The DSR / export / erasure endpoints in Section 4 cover the first two; the
  audit log records access events to satisfy "right to know" requests.
- **SOC 2.** Audit logs must be tamper-resistant and retained per the Common
  Criteria (CC) requirements. The default 90-day primary retention plus the
  S3 archive supports CC7 provided the archive lifecycle is set to a
  multi-year window.
- **HIPAA.** SiskelBot is **not** HIPAA-certified out of the box. If used in
  healthcare contexts, retention requirements typically increase to 6 years
  for most categories, and additional controls (BAA, encryption-at-rest,
  access review) are required. Field-level encryption is available
  (`lib/field-encryption.js`) but configuration is the operator's responsibility.

## 7. Configuration recommendations

A reasonable production configuration for a privacy-sensitive deployment,
using only env vars that are honoured by the current source tree:

```bash
# Audit log: keep 90 days hot, archive to S3 for long-term retention
AUDIT_RETENTION_DAYS=90
# (configure your S3 lifecycle policy to retain the archive prefix per your
#  regulatory window — e.g. 7 years for SOC 2 / financial / health)

# Agent run telemetry: short TTL on in-process snapshots
AGENT_TRAJECTORY_TTL_MS=600000

# Idempotency: 24h is a sensible default
IDEMPOTENCY_TTL_MS=86400000

# Bound durable agent session storage to keep query latency stable
AGENT_SESSIONS_MAX_STORE=4000
AGENT_SESSION_MAX_EVENTS=400
```

> **Not yet env-driven.** Conversations, knowledge documents, agent memory,
> and workflow runs are **not** currently expirable via env var. If you need
> automated retention for these, file an enhancement and use a scheduled job
> (`lib/scheduler.js`) in the meantime. This is the most common gap reported
> by privacy-focused operators.

## 8. Operational schedule

A weekly checklist for the on-call / ops rotation:

- [ ] Verify `audit-lifecycle` cron ran in the last 24h (search logs for
      `[audit-lifecycle]`).
- [ ] Spot-check audit log row count — alert if it grew >20% week-over-week
      with no corresponding traffic increase.
- [ ] Verify database backups completed (check the storage backend's snapshot
      timestamps — managed Postgres console, S3 bucket modified times, etc.).
- [ ] Verify the audit S3 archive bucket is receiving uploads (most recent
      object should be < `AUDIT_RETENTION_DAYS` old).
- [ ] Drain any stuck webhook DLQ entries — see `docs/RUNBOOKS/webhook_dlq_drain.md`.
- [ ] If conversation cleanup is configured as a scheduled job, confirm last
      run completed.

Quarterly:

- [ ] Run a database restore drill into a non-prod environment and confirm
      data integrity. (No dedicated runbook ships today — capture the
      procedure for your chosen Postgres provider.)
- [ ] Review this policy against any regulatory or contractual changes.
- [ ] Re-validate that pending right-to-erasure requests have aged out of
      the backup retention window.
