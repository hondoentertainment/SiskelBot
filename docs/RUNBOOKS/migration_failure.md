# Runbook: Migration Failure

**Time to resolve:** 15–45 minutes

## Symptoms
- `helm upgrade` hangs or exits non-zero.
- Migration Job in Kubernetes shows `Error` or `BackoffLimitExceeded`.
- Application pods fail to start with schema mismatch errors in logs.
- `[migrations] Failed:` lines in Job logs.

## Severity
**critical** — service will not start until the schema is consistent.

## Immediate triage

Check the migration Job status and logs:

```bash
kubectl get jobs -n siskelbot
kubectl describe job siskelbot-migration -n siskelbot
kubectl logs job/siskelbot-migration -n siskelbot
```

Look for the specific migration ID and error message in the log output. The migration runner stops on the first error, so only the failing migration needs attention.

## Check migration state in DB

Connect to the database and inspect the `_migrations` tracking table:

```sql
SELECT id, description, applied_at FROM _migrations ORDER BY applied_at;
```

Compare the last applied row against the migration files in `migrations/` to determine which migration failed and whether it was partially applied. The runner wraps each migration in a transaction; a failure triggers `ROLLBACK`, so partial writes should not persist.

## Roll back the Helm release

If the application is not running and you need to restore service immediately, revert to the last known-good revision:

```bash
helm history siskelbot -n siskelbot
helm rollback siskelbot <previous-revision> -n siskelbot
```

This reverts the Kubernetes manifests (image, config) to the previous revision. If the migration did not commit, the schema is already at the previous state and the rollback is complete.

## Manual migration rollback

If the migration committed to the DB before failing (rare — each migration runs in a transaction), roll it back manually:

```bash
siskelbot migrate db --rollback <migration-id>
```

Or directly via the Node script:

```bash
node bin/siskelbot.js migrate db --rollback <migration-id>
```

Not all migrations export a `down` function. Check `migrations/<id>.js` before attempting this. If `down` is absent, you must write and apply a compensating SQL statement manually, then delete the row from `_migrations`:

```sql
DELETE FROM _migrations WHERE id = '<migration-id>';
```

## Fix and re-deploy

1. Fix the migration file (add missing `down` if needed, correct the SQL).
2. Rebuild the Docker image and push it to the registry.
3. Re-run the Helm upgrade:
   ```bash
   helm upgrade siskelbot ./charts/siskelbot -n siskelbot \
     --set image.tag=<new-tag>
   ```
4. Confirm the migration Job completes successfully before declaring the release done.

## Prevention

- Always run `node bin/siskelbot.js migrate db` against a staging database before merging a migration PR.
- Every migration should export a `down` function unless the operation is irreversible (e.g. data backfill).
- Keep migrations small and focused — one schema change per file.
- Run `node --test tests/migrations.test.js` (if present) in CI to catch syntax errors early.
- Tag the Docker image with the migration version so Helm history maps directly to schema state.
