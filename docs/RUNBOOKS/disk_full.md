# Runbook: Disk Full

## Symptoms
- Write failures in the JSON storage layer.
- Log rotation or backup jobs failing with ENOSPC.
- Alerts on disk utilisation above 90%.

## Severity
**high** — writes stall, storage-backed APIs begin to fail.

## Investigation Steps
1. Check disk usage: `df -h`.
2. Identify the largest consumers: `du -sh data/* backups/* logs/*`.
3. Determine whether growth is data, logs, backups, or audit archives.
4. Check for runaway trace or audit files that should have been trimmed.
5. Confirm backup pruning jobs are still running.

## Remediation
- Delete old backups and audit archives after confirming they're archived elsewhere.
- Rotate and compress logs immediately.
- Run audit-trim CLI to prune the active audit file.
- Extend the underlying volume if available (cloud disk resize, LVM extend).

## Prevention
- Alert on disk utilisation above 80%, not 95%.
- Schedule periodic audit trim and backup retention jobs.
- Archive old data to object storage (S3) instead of keeping it on the local volume.
- Capture disk-growth rate so capacity can be planned proactively.
