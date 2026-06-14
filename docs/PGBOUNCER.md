# PgBouncer Connection Pooling

SiskelBot's Helm chart can deploy [PgBouncer](https://www.pgbouncer.org/) as a
sidecar Deployment in front of Postgres. This document explains why you might
want it, when to enable it, the trade-offs of each pool mode, and how to verify
the deployment is healthy.

## Why PgBouncer

When SiskelBot runs against the Postgres storage backend
(`STORAGE_BACKEND=postgres`), the node-postgres pool inside the app opens a
fresh connection for many request paths. With multiple Express replicas under
load, the total client connection count can easily exceed Postgres'
`max_connections` (default `100`), causing `FATAL: too many connections for
role` errors that surface as 500s and degraded latency.

PgBouncer sits between the app and Postgres and multiplexes thousands of
short-lived client connections onto a small, long-lived pool of server
connections. A typical configuration pools ~10,000 client connections down to
~25 server connections per database/user pair.

## Pool modes

PgBouncer supports three pool modes (the chart exposes this as
`pgbouncer.poolMode`):

| Mode          | Server connection released... | Use it when                                                                 |
|---------------|-------------------------------|------------------------------------------------------------------------------|
| `transaction` | After each transaction        | **Default for typical web traffic.** Highest pooling efficiency.            |
| `session`     | When the client disconnects   | You need server-side state (`LISTEN/NOTIFY`, prepared statements, advisory locks, `SET LOCAL` outside a txn). |
| `statement`   | After each statement          | Read-only analytics with no multi-statement transactions. Rarely useful.    |

### Caveats

- **Transaction mode breaks `LISTEN/NOTIFY`.** PgBouncer can route subsequent
  queries from the same client to a different server connection, so async
  notifications never reach the listener. If SiskelBot uses pg notifications,
  switch to `session` mode (and accept lower pooling).
- **Server-side prepared statements must be off in transaction mode.** Modern
  Postgres clients (including node-postgres ≥ 8) handle this correctly out of
  the box. If you set `pg.preparedStatements = true` explicitly, disable it or
  use `session` mode.
- **`SET` and other session state.** Anything that mutates session state
  (search_path, role, custom GUCs) outside a transaction will not survive a
  pool checkout. Use `SET LOCAL ... ` inside a transaction instead.
- **Latency overhead.** PgBouncer adds roughly 1 ms per query. The win comes
  from avoiding TCP/TLS handshakes and Postgres `fork()` cost — net latency is
  almost always lower under load.

## When to enable

Turn PgBouncer on when any of these are true:

- Sustained concurrency over ~50 in-flight requests per replica.
- You see `too many connections` errors in Postgres logs.
- You run more than ~5 SiskelBot replicas against a single Postgres instance.
- You are about to scale horizontally (e.g. enabling HPA in production).

For dev/staging with a single replica and < 20 concurrent users, PgBouncer adds
moving parts without measurable benefit — leave it off.

## Tuning

`pgbouncer.defaultPoolSize` is the cap on **server-side** connections per
(database, user) pair. A reasonable starting point is:

```
defaultPoolSize ≈ 2 × postgres_cpu_cores
```

Total server connections to Postgres will be approximately
`defaultPoolSize × pgbouncer.replicas × number_of_(db,user)_pairs`. Make sure
this stays well under Postgres' `max_connections`.

`pgbouncer.maxClientConn` is the cap on **client-side** connections accepted
across all pgbouncer pods. Set it well above your peak concurrency — exhausting
this limit causes app-side connection refusals.

Defaults shipped by the chart:

| Setting              | `values.yaml` (dev) | `values.production.yaml` |
|----------------------|---------------------|--------------------------|
| `replicas`           | 2                   | 3                        |
| `poolMode`           | `transaction`       | `transaction`            |
| `maxClientConn`      | 1000                | 5000                     |
| `defaultPoolSize`    | 25                  | 50                       |

## DATABASE_URL handling

When `pgbouncer.enabled=true`, the chart automatically overrides `DATABASE_URL`
on the SiskelBot pods to point at the in-cluster pgbouncer Service:

```
postgres://<username>:<password>@<release>-pgbouncer:6432/<database>
```

The password is sourced from `postgresql.existingSecret` /
`postgresql.existingSecretPasswordKey`. Because Kubernetes evaluates explicit
`env` entries **after** `envFrom`, this overrides any `DATABASE_URL` that comes
out of `siskelbot-secrets` — you do not need to update the Secret.

If you manage `DATABASE_URL` outside the chart (external secret operator,
sealed secrets, etc.), make sure your tooling does not also set the same key
on the pod env spec, or the chart override will be shadowed. The simplest
fallback is to update the upstream Secret to point at the pgbouncer Service
(`<release>-pgbouncer:6432`) and leave `pgbouncer.enabled=true` to spin up the
pooler only.

## Monitoring

PgBouncer exposes an admin pseudo-database called `pgbouncer` on the same port
(6432). Connect with `psql` to inspect runtime state:

```bash
# SHOW POOLS — current per-pool client/server connection counts
kubectl exec deploy/siskelbot-pgbouncer -- \
  psql -h localhost -p 6432 -U siskelbot pgbouncer -c "SHOW POOLS"

# SHOW STATS — aggregate query/transaction counters
kubectl exec deploy/siskelbot-pgbouncer -- \
  psql -h localhost -p 6432 -U siskelbot pgbouncer -c "SHOW STATS"

# SHOW CLIENTS / SHOW SERVERS for connection-level detail
kubectl exec deploy/siskelbot-pgbouncer -- \
  psql -h localhost -p 6432 -U siskelbot pgbouncer -c "SHOW CLIENTS"
```

The bitnami/pgbouncer image used by the chart accepts the same admin commands.
For Prometheus monitoring, deploy a sidecar like
[`prometheus-community/pgbouncer-exporter`](https://github.com/prometheus-community/pgbouncer_exporter)
and scrape it via your existing ServiceMonitor.

## Verification

After enabling, sanity-check that the app is actually using the pooler:

```bash
# 1. Pgbouncer pods are Ready
kubectl get pods -l app.kubernetes.io/component=pgbouncer

# 2. App pods see the pooler in DATABASE_URL
kubectl exec deploy/siskelbot -- printenv DATABASE_URL
# expect: postgres://siskelbot:...@siskelbot-pgbouncer:6432/siskelbot

# 3. Pools have non-zero cl_active under load
kubectl exec deploy/siskelbot-pgbouncer -- \
  psql -h localhost -p 6432 -U siskelbot pgbouncer -c "SHOW POOLS"
```

## Enabling via Helm

Dev / staging:

```bash
helm upgrade siskelbot ./helm/siskelbot --set pgbouncer.enabled=true
```

Production (the production values file already has it on):

```bash
helm upgrade siskelbot ./helm/siskelbot \
  --set pgbouncer.enabled=true \
  -f helm/siskelbot/values.production.yaml
```

## Disabling

Set `pgbouncer.enabled=false` and re-apply. The Deployment + Service are
deleted, and the SiskelBot pods revert to whatever `DATABASE_URL` the upstream
Secret provides — make sure that points back at Postgres directly, not at the
(now-gone) pgbouncer Service.
