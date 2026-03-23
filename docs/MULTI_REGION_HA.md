# Multi-region & high availability (Phase 76)

This is a **design note** for operators. Siskel Bot can run behind a load balancer, but several components assume a **single logical writer** unless you add external coordination.

## Storage (Phase 68+)

- With `STORAGE_BACKEND=postgres`, tenant-scoped JSON and KV paths use the same database as workspace content. Run **one primary** Postgres for writes; read replicas are safe for read-only traffic only if the app is not issuing writes to replicas.
- File-based `data/*.json` modes are **not** safe for multi-instance concurrent writes; use Postgres (or SQLite only for single-process desktop).

## Agent trajectories

- Durable mode (`AGENT_TRAJECTORY_DURABLE` not `0`) writes through `json-path-store`. In multi-instance deployments, ensure the backing store is shared (e.g. Postgres) so `GET /api/agent/trajectory/:runId` works from any node.

## WebSockets and presence

- Real-time connections are **sticky** to the process that accepted the socket. Options:
  - **Sticky sessions** at the load balancer to the same Node process, or
  - A **pub/sub** layer (Redis, etc.) for cross-node events (not shipped in core; extension point).

## Audit archival (Phase 70)

- Scheduled or admin-triggered S3 upload (`/api/admin/audit/archive-s3`) should run **at most once per cluster** at a time, or use an external scheduler with leader election, to avoid duplicate uploads.

## Active / passive regions

- **Active-passive:** Secondary region stays cold; DNS or global load balancer fails over after promoting Postgres / restoring backups.
- **Active-active:** Requires shared durable storage, idempotent webhooks, and careful handling of scheduled jobs—treat as a custom architecture review.

## Webhooks and cron

- Vercel Cron and similar invoke a **single URL**; ensure that URL targets one deployment or a worker that deduplicates jobs.
