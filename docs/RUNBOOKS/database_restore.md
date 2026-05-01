# Database Restore

**Severity:** critical — data loss event.

**Time to resolve:** 30 minutes – 2 hours, depending on dataset size.

> Note: the Helm chart does not currently ship a `backup-cronjob.yaml` template. Operators are expected to deploy a CronJob (or external backup tool) that produces gzipped `pg_dump` files to S3 in the format `siskelbot-YYYYMMDDTHHMMSSZ.sql.gz`. This runbook assumes that format.

## 1. When to use this runbook

- Confirmed data corruption (bad migration, application bug, accidental `DELETE` / `TRUNCATE`).
- Disaster recovery (DB instance lost, region failure, storage volume gone).
- Restoring a staging environment from a production backup for testing or forensics.

Do **not** use this runbook for transient query slowness — see `database_slow.md`. For a failed schema migration that did not corrupt data, see `migration_failure.md` first.

## 2. Prerequisites

- AWS CLI installed locally (or a debug pod built from the backup image).
- Read access to the S3 backup bucket (`s3://siskelbot-prod-backups/`).
- Database admin credentials (`DATABASE_URL` with rights to `DROP`/`CREATE` tables).
- `kubectl` context pointed at the right cluster.
- Confirmed backup integrity — if time allows, test the restore against a staging database first.

## 3. RTO / RPO targets

| Metric | Target |
|---|---|
| RPO (Recovery Point Objective) | 24 hours (daily backups) |
| RTO (Recovery Time Objective) | 1 hour for `<10 GB`, 4 hours for `<100 GB` |

If the business requires a tighter RPO than 24 h, change the backup CronJob schedule to run more frequently (e.g. `schedule: "0 */6 * * *"` for every 6 hours).

## 4. Pre-restore checklist

Before starting, confirm:

- [ ] Decision made to restore — restoring is destructive and could lose recent legitimate writes. Don't restore reflexively.
- [ ] Application traffic stopped or in maintenance mode (`kubectl scale deployment/siskelbot --replicas=0`).
- [ ] Current database state preserved as a forensic snapshot (see step 5).
- [ ] On-call notified, incident channel posted in.
- [ ] Target backup identified (timestamp, file size matches the expected daily size).

## 5. Take a safety dump (preserves current state for forensics)

```bash
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump "${DATABASE_URL}" --no-owner --no-privileges --clean --if-exists \
  | gzip -9 > "/tmp/siskelbot-pre-restore-${TIMESTAMP}.sql.gz"

# Upload to S3 with explicit "pre-restore" prefix so it does not get rotated
# by the regular daily-retention lifecycle policy.
aws s3 cp "/tmp/siskelbot-pre-restore-${TIMESTAMP}.sql.gz" \
  "s3://siskelbot-prod-backups/postgres/forensic/siskelbot-pre-restore-${TIMESTAMP}.sql.gz"
```

If the database is so corrupted that `pg_dump` fails, capture filesystem-level snapshots of the data volume instead (EBS snapshot, RDS snapshot) before proceeding.

## 6. List available backups

```bash
aws s3 ls s3://siskelbot-prod-backups/postgres/daily/ \
  | sort -k1,2 \
  | tail -30
```

Pick a backup taken **before** the data loss event. The filename format is `siskelbot-YYYYMMDDTHHMMSSZ.sql.gz` (UTC).

## 7. Download and verify the backup

```bash
BACKUP=siskelbot-20260415T020000Z.sql.gz
aws s3 cp "s3://siskelbot-prod-backups/postgres/daily/${BACKUP}" "/tmp/${BACKUP}"

# Verify gzip integrity
gunzip -t "/tmp/${BACKUP}" && echo "OK: gzip integrity passed"

# Spot-check content
zcat "/tmp/${BACKUP}" | head -50
zcat "/tmp/${BACKUP}" | grep -c "CREATE TABLE"
```

If `gunzip -t` fails the backup is unusable — pick the next-most-recent one and accept the wider RPO gap.

## 8. Stop application writes

```bash
# Drain traffic (replicas=0 stops all pods)
kubectl scale deployment/siskelbot --replicas=0 -n siskelbot
kubectl wait --for=delete pod -l app.kubernetes.io/name=siskelbot -n siskelbot --timeout=60s

# Confirm zero pods
kubectl get pods -n siskelbot -l app.kubernetes.io/name=siskelbot
```

Also disable any external writers (workers, schedulers, webhook deliverers) that talk to the same database.

## 9. Restore the database

The dump was produced with `--clean --if-exists`, so it will `DROP` existing tables before recreating them. Execute carefully:

```bash
zcat "/tmp/${BACKUP}" | psql "${DATABASE_URL}"
```

If restoring to a fresh database (different host, e.g. a DR scenario), the database itself must already exist:

```bash
createdb -h newhost siskelbot
zcat "/tmp/${BACKUP}" | psql "postgres://siskelbot:pass@newhost/siskelbot"
```

Watch the output for `ERROR:` lines. A clean restore should print only `NOTICE:` and `SET` / `ALTER` statements.

## 10. Verify the restore

```bash
psql "${DATABASE_URL}" <<'SQL'
-- Check migrations table state
SELECT id, applied_at FROM _migrations ORDER BY applied_at DESC LIMIT 5;

-- Sanity-check core tables exist and have data
SELECT count(*) FROM workspaces;
SELECT count(*) FROM users;
SELECT max(created_at) FROM audit_log;
SQL
```

`max(created_at)` from `audit_log` should match the backup timestamp roughly. If the counts are zero or wildly off the expected production volume, abort and investigate before resuming traffic.

## 11. Re-apply migrations (if backup pre-dates a recent migration)

If the backup was taken before a migration in the currently-deployed image was applied, re-run migrations against the restored database. The runner is idempotent — it skips migrations whose IDs are already in `_migrations`.

```bash
kubectl run migrate --rm -i --restart=Never \
  --image=ghcr.io/hondoentertainment/siskelbot:1.0.0 \
  --env="DATABASE_URL=${DATABASE_URL}" \
  --command -- node bin/siskelbot.js migrate
```

If a re-applied migration fails, switch to `migration_failure.md`.

## 12. Resume application traffic

```bash
kubectl scale deployment/siskelbot --replicas=3 -n siskelbot
kubectl rollout status deployment/siskelbot -n siskelbot

# Smoke test
curl https://siskelbot.example.com/health/ready
curl https://siskelbot.example.com/health/deep
```

Watch the deployment logs for schema-mismatch errors during startup.

## 13. Post-restore

- [ ] Verify user-visible functionality (login, send a chat, list workspaces, knowledge search).
- [ ] Notify users of any data loss between the backup time and the incident time.
- [ ] Document in incident postmortem: actual RPO, actual RTO, root cause, what triggered the restore.
- [ ] Adjust backup frequency if the realized RPO was insufficient.
- [ ] Confirm the forensic dump from step 5 is still in S3 and tagged for long-term retention.

## 14. Quarterly restore drill

A restore that has not been practiced is a restore that will not work. Run a quarterly drill:

1. Spin up a staging database (separate instance, isolated network).
2. Run the full restore procedure end-to-end against it.
3. Time it; confirm RTO is met for the current dataset size.
4. Document drill results in a tracking doc and file follow-ups for any step that was unclear, slow, or required improvisation.
