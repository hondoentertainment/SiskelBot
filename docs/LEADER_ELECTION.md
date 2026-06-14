# Leader election (Phase 45)

File-based or Postgres KV lock with TTL renewal. Used for singleton cron/leader workloads in multi-instance deploys.

## Behavior

- **`acquire()`** — writes lock if none exists or previous lock expired.
- **Renewal** — leader renews at ~TTL/3 intervals.
- **`release()`** — only the holder clears the lock.
- **`isLeader()`** — reads lock; returns false if expired or held by another instance.

## Partition / TTL takeover

When the leader stops renewing (crash, network partition, slow GC):

1. Lock expires after `LEADER_TTL_MS` (default 30s, env override).
2. Standby instance calls `acquire()` and becomes leader.
3. Stale leader must call `isLeader()` after reconnect — returns false until it can re-acquire.

See **`tests/chaos/leader-partition.test.js`** for automated coverage.

## Split-brain caveat (file locks)

File-based locks are **not atomic** under simultaneous `acquire()` after expiry. Two instances racing may both succeed briefly. **Sequential** acquire is safe: second caller fails while the first lock is valid.

For strict mutual exclusion in multi-region prod, use **Postgres KV** (`usePostgres: true`) or an external consensus store.

## Ops

| Env | Purpose |
|-----|---------|
| `LEADER_TTL_MS` | Lock TTL (ms) |
| `REGION_ID` | Instance region label in lock payload |
| `STORAGE_PATH` / Postgres | Lock storage |

## Related

- `lib/leader-election.js`
- `docs/RUNBOOK.md` — load shedding & leader notes
