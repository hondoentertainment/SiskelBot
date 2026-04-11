# Runbook: Database Slow

## Symptoms
- Storage operations taking over one second.
- Connection-pool exhaustion warnings in logs.
- API endpoints timing out on storage-heavy paths (conversations, audit, knowledge).

## Severity
**high** — cascades into user-facing latency quickly.

## Investigation Steps
1. Check pool health: `GET /api/v1/admin/pool-health`.
2. Inspect database server CPU, memory, and disk IO.
3. Look for long-running queries, lock contention, or deadlocks.
4. Check for missing indexes on frequently-queried tables.
5. Review any recent schema migration that may have rewritten or locked a table.
6. If a read replica is available, consider failing reads over to it.

## Remediation
- Terminate long-running or stuck queries on the database side.
- Raise pool size temporarily while the root cause is investigated.
- Failover reads to a replica.
- If a runaway query is caused by a recent code change, rollback.

## Prevention
- Run `EXPLAIN` on hot queries in load tests before merging.
- Configure `statement_timeout` on the database to bound worst-case query time.
- Review slow-query logs on a regular cadence.
- Backfill indexes ahead of traffic growth rather than after incidents.
