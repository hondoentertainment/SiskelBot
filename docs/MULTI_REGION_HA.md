# Multi-region & high availability (Phase 45-48 / Phase 76)

This is a **design note** for operators. Siskel Bot can run behind a load balancer, but several components assume a **single logical writer** unless you add external coordination.

## Leader election (Phase 45)

Siskel Bot ships a built-in leader election mechanism (`lib/leader-election.js`). A storage-based lock (JSON file or Postgres KV) ensures only one instance runs scheduled recipes at a time.

- **TTL-based:** the leader must renew within `LEADER_TTL_MS` (default 30 s) or another instance takes over.
- The scheduler (`lib/scheduler.js`) checks leadership before each cron tick.
- Inspect the current leader via `GET /api/regions/leader` (admin only).

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `REGION_ID` | `default` | Unique identifier for this region/instance |
| `LEADER_TTL_MS` | `30000` | Lock TTL in ms |

## Cross-region health monitoring (Phase 46)

`lib/region-health.js` polls registered regions' `/health/ready` endpoints.

Configure via `REGIONS` env var:

```
REGIONS=us-east:https://us.example.com,eu-west:https://eu.example.com
```

- `GET /api/regions` (admin) returns all regions with their health status.
- `/health/ready` now includes `regionId` and `isLeader` fields.

## Storage replication (Phase 47)

`lib/storage-replication.js` provides a `ReplicationManager` that syncs writes to peer regions via `POST /api/internal/sync`.

- Authenticated with `INTERNAL_SECRET` (shared across all regions).
- **Conflict resolution:** last-write-wins with vector clocks.
- Enable with `ENABLE_REPLICATION=1`.

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `INTERNAL_SECRET` | _(none)_ | Shared secret for inter-region sync |
| `ENABLE_REPLICATION` | `0` | Enable storage replication |

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
