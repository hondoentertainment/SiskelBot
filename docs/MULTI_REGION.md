# Multi-Region Failover System

Detailed operational guide for deploying SiskelBot across multiple regions with automatic leader election, health monitoring, and storage replication (Phases 45-47).

## Architecture overview

The multi-region failover system consists of three cooperating subsystems:

1. **Leader election** (`lib/leader-election.js`) -- A storage-based lock mechanism that ensures only one instance acts as the primary writer. Uses a TTL-based lease that must be renewed before expiration.

2. **Region health monitoring** (`lib/region-health.js`) -- Each instance periodically polls the `/health/ready` endpoint of every other registered region and tracks latency, status, and errors.

3. **Storage replication** (`lib/storage-replication.js`) -- The replication manager propagates key-value writes from the source region to all peer regions via `POST /api/internal/sync`. Conflict resolution uses last-write-wins with vector clocks.

Data flow:

```
  Region A (leader)                      Region B (secondary)
  +-----------------+                    +-----------------+
  | App writes key  |                    |                 |
  | ReplicationMgr  |---HTTP POST------>| /api/internal/  |
  |   .replicate()  |  (Bearer token)   |   sync          |
  |                 |                    | ReplicationMgr  |
  |                 |                    |   .receive()    |
  +-----------------+                    +-----------------+
        |                                       |
        +---- polls /health/ready ------------->|
        |<--- polls /health/ready --------------+
```

## Environment variables

All environment variables used by the multi-region modules:

| Variable | Default | Module | Description |
|----------|---------|--------|-------------|
| `REGION_ID` | `"default"` | All three | Unique identifier for this region/instance. Must be unique across the deployment. |
| `REGIONS` | `""` | region-health, storage-replication | Comma-separated list of `regionId:endpoint` pairs. Example: `us-east:https://us.example.com,eu-west:https://eu.example.com` |
| `LEADER_TTL_MS` | `30000` | leader-election | How long the leader lock is valid (ms). If the leader fails to renew within this window, another instance can take over. |
| `REGION_POLL_INTERVAL_MS` | `15000` | region-health | How often to poll peer regions' health endpoints (ms). |
| `REGION_HEALTH_TIMEOUT_MS` | `5000` | region-health | Timeout for each health check HTTP request (ms). |
| `INTERNAL_SECRET` | `""` | storage-replication | Shared secret used to authenticate inter-region sync requests. Must be identical across all regions. Required for replication to work. |
| `ENABLE_REPLICATION` | `"0"` | storage-replication | Set to `"1"` to enable storage replication. |
| `REPLICATION_TIMEOUT_MS` | `5000` | storage-replication | Timeout for outbound replication HTTP requests (ms). |
| `STORAGE_PATH` | `"./data"` | leader-election | Directory used for the file-based leader lock (when not using Postgres). |

## Leader election

### Algorithm

Leader election uses a simple lock-file (or Postgres KV entry) with a TTL:

1. An instance calls `acquire()`, which reads the current lock.
2. If no lock exists, or the existing lock has expired (current time >= `acquiredAt + ttlMs`), the instance writes its own lock and becomes leader.
3. If a valid lock from another instance exists, `acquire()` returns `false`.
4. Once leader, the instance starts a renewal interval at `ttlMs / 3` (minimum 1 second) that updates the `acquiredAt` timestamp.
5. If renewal fails or detects that another instance holds the lock, the instance demotes itself and fires the `onLeaderChange(false)` callback.

### Lock format (file-based)

The lock is stored at `<STORAGE_PATH>/.leader-lock.json`:

```json
{
  "instanceId": "us-east-a1b2c3d4-...",
  "regionId": "us-east",
  "acquiredAt": 1680000000000,
  "ttlMs": 30000
}
```

### Lock format (Postgres)

When `usePostgres` is set and KV load/save functions are provided, the same JSON structure is stored under the key `__leader_lock__`.

### Lifecycle callbacks

Register a callback to react to leadership changes:

```js
const le = getLeaderElection();
le.onLeaderChange((isLeader) => {
  if (isLeader) console.log("I am now the leader");
  else console.log("I lost leadership");
});
```

### Failover timeline

With default settings (`LEADER_TTL_MS=30000`):
- Renewal runs every ~10 seconds (`ttlMs / 3`).
- If the leader crashes, the lock expires after 30 seconds.
- A secondary instance calling `acquire()` can take over once the lock is stale.

## Region health monitoring

### How it works

`RegionHealth` parses the `REGIONS` env var on construction. It skips its own `REGION_ID` to avoid self-polling. For each peer region, it makes an HTTP GET to `<endpoint>/health/ready` with an abort timeout of `REGION_HEALTH_TIMEOUT_MS`.

Each region entry tracks:
- `status`: `"healthy"`, `"unhealthy"`, or `"unreachable"`
- `latencyMs`: round-trip time of the health check
- `error`: error message if not healthy (e.g., `"HTTP 503"` or `"timeout"`)
- `lastChecked`: ISO timestamp of last check

### Status values

| Status | Meaning |
|--------|---------|
| `healthy` | `/health/ready` returned HTTP 2xx |
| `unhealthy` | `/health/ready` returned a non-2xx status code |
| `unreachable` | Request timed out or network error occurred |
| `unknown` | Region registered but not yet checked |

### Polling

Call `startPolling()` to begin periodic checks at `REGION_POLL_INTERVAL_MS`. The interval is unref'd so it does not prevent process exit. An initial check runs immediately on start.

### API

- `GET /api/regions` (admin auth required) -- Triggers a fresh check and returns all region statuses, including self (always reported as healthy).

## Storage replication

### Prerequisites

Replication requires all three conditions:
1. `ENABLE_REPLICATION=1`
2. `REGIONS` env var lists at least one peer region
3. `INTERNAL_SECRET` is set to a non-empty string

If any condition is missing, `isEnabled()` returns `false` and `replicate()` is a no-op.

### Data flow

1. Application code calls `replicate(key, value)` after a storage write.
2. The replication manager increments the vector clock for the source region.
3. It sends a `POST /api/internal/sync` to each peer region with:
   - `Authorization: Bearer <INTERNAL_SECRET>`
   - `X-Source-Region: <REGION_ID>`
   - Body: `{ key, value, sourceRegion, clock, timestamp }`
4. The receiving region's `internalAuth` middleware validates the Bearer token.
5. `receive(payload)` compares vector clocks using sum comparison (last-write-wins). If the incoming clock sum is higher, or equal with a newer timestamp, the write is accepted and clocks are merged.

### Conflict resolution

The system uses a simplified vector clock with last-write-wins:

- Each region maintains a counter per key per region.
- On write, the source region's counter is incremented.
- On receive, clock sums are compared. Higher sum wins. On tie, the more recent timestamp wins.
- Clocks are merged by taking the max of each region's counter.

This is eventually consistent. In the rare case of true concurrent writes with identical clock sums and timestamps, the earlier write may be silently dropped.

### Sync endpoint

- `POST /api/internal/sync` -- Receives replicated data. Returns `200 { ok: true, accepted: true }` on success, or `409 { ok: false, reason: "stale_clock" }` if the incoming data is stale.

## Step-by-step: 2-region deployment

### 1. Provision two instances

- **Region A** (e.g., `us-east`): `https://us.siskelbot.example.com`
- **Region B** (e.g., `eu-west`): `https://eu.siskelbot.example.com`

### 2. Generate an internal secret

```bash
openssl rand -hex 32
# Example: a3f1c9e8b7d2...
```

### 3. Configure environment variables

**Region A:**
```env
REGION_ID=us-east
REGIONS=us-east:https://us.siskelbot.example.com,eu-west:https://eu.siskelbot.example.com
INTERNAL_SECRET=a3f1c9e8b7d2...
ENABLE_REPLICATION=1
LEADER_TTL_MS=30000
REGION_POLL_INTERVAL_MS=15000
```

**Region B:**
```env
REGION_ID=eu-west
REGIONS=us-east:https://us.siskelbot.example.com,eu-west:https://eu.siskelbot.example.com
INTERNAL_SECRET=a3f1c9e8b7d2...
ENABLE_REPLICATION=1
LEADER_TTL_MS=30000
REGION_POLL_INTERVAL_MS=15000
```

Note: Each region skips itself when parsing `REGIONS`, so the same value can be used everywhere.

### 4. Start both instances

```bash
npm start
```

### 5. Verify health

```bash
# From Region A, check all regions
curl -H "Authorization: Bearer $ADMIN_API_KEY" https://us.siskelbot.example.com/api/regions

# Check who the leader is
curl -H "Authorization: Bearer $ADMIN_API_KEY" https://us.siskelbot.example.com/api/regions/leader
```

### 6. Acquire leadership on Region A

The first instance to call `acquire()` on its `LeaderElection` becomes the leader. The scheduler and other leader-gated features use this to prevent duplicate work.

## Troubleshooting

### Regions show as "unreachable"

- Verify the endpoint URLs in `REGIONS` are reachable from each instance.
- Check that `/health/ready` returns 200 on each instance.
- Increase `REGION_HEALTH_TIMEOUT_MS` if latency between regions is high.

### Replication is not working

- Confirm `ENABLE_REPLICATION=1` is set.
- Confirm `INTERNAL_SECRET` is identical on all instances.
- Confirm `REGIONS` is set and contains at least one peer.
- Check application logs for `[replication]` messages.

### Leader election not failing over

- Verify `LEADER_TTL_MS` is set to an appropriate value (lower = faster failover but more lock file writes).
- Check that the lock file (`data/.leader-lock.json`) or Postgres KV entry is accessible from all instances.
- For file-based locks, instances must share the same filesystem (e.g., NFS, EFS) for cross-instance failover. Otherwise, each instance will independently believe it is the leader.

### Sync endpoint returns 401

- The `INTERNAL_SECRET` does not match between sender and receiver.
- Ensure the Authorization header uses the `Bearer <secret>` format.

### Sync endpoint returns 503

- `INTERNAL_SECRET` is not set on the receiving instance.

### Conflicting writes / data loss

- The vector clock conflict resolution uses last-write-wins. Truly concurrent writes to the same key from different regions may result in one write being silently dropped.
- Monitor the `409` responses from `/api/internal/sync` as indicators of write conflicts.

## Limitations and caveats

1. **File-based leader election is single-host only.** The `.leader-lock.json` file is written to the local filesystem. For cross-instance leader election, instances must share a filesystem, or use the Postgres backend.

2. **Replication is asynchronous.** Writes are replicated after the local write succeeds. If the source region crashes before replication completes, the write may be lost on peer regions.

3. **No automatic leader acquisition on startup.** Application code must explicitly call `acquire()`. The modules provide the mechanism but do not auto-elect on boot.

4. **Vector clocks are simplified.** The sum-based comparison is a simplification of true vector clock ordering. It works well for single-writer (leader) topologies but may produce unexpected results with true multi-writer active-active setups.

5. **No built-in pub/sub for WebSocket fan-out.** Real-time WebSocket connections are sticky to the process that accepted them. Cross-region WebSocket events require an external pub/sub layer (e.g., Redis).

6. **Health checks are unidirectional per instance.** Each instance polls its peers independently. There is no consensus protocol -- each instance has its own view of cluster health.

7. **Replication does not retry on failure.** If a sync request to a peer fails, it is reported in the `errors` array but not retried. The caller must implement retry logic if needed.
