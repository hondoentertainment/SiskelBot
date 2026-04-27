# Production Go-Live Checklist

Sign off on every item below before cutting production traffic. Each item is a binary YES/NO — if you can't answer YES with evidence, the item blocks launch.

Owner: ____________________  Target launch date: ____________________

## 1. Infrastructure (sign-off: ops lead)

- [ ] Kubernetes cluster is on a supported version (1.26+)
- [ ] cert-manager + ClusterIssuer for TLS is installed and tested
- [ ] NGINX Ingress Controller is installed
- [ ] Persistent storage class for data PVC exists (e.g. `gp3`)
- [ ] Postgres database provisioned with HA replication (not single instance)
- [ ] Redis (or alternative cache) provisioned with HA
- [ ] Backup S3 bucket created with lifecycle policy
- [ ] Container registry (GHCR or other) accessible from cluster

## 2. Secrets and configuration (sign-off: security)

- [ ] Production `siskelbot-secrets` Secret created with: `OPENAI_API_KEY`, `SESSION_SECRET`, `API_KEY`, `ADMIN_API_KEY`, `DATABASE_URL`
- [ ] All secrets generated with `openssl rand -hex 32` (not weak/copy-pasted from dev)
- [ ] `SESSION_SECRET_PREVIOUS` and `API_KEY_PREVIOUS` are EMPTY (rotation flow tested but no leftover from dev)
- [ ] Secret rotation procedure rehearsed at least once (`docs/RUNBOOK.md` Secret Rotation section)
- [ ] (Optional) external-secrets-operator wired up if using AWS Secrets Manager / Vault
- [ ] No secrets in `values.yaml` checked into git

## 3. Helm chart configuration (sign-off: ops lead)

- [ ] `image.tag` is pinned to a specific version (NOT `latest`)
- [ ] `replicaCount` >= 3 OR `autoscaling.enabled=true` with `minReplicas` >= 3
- [ ] `podDisruptionBudget.enabled=true` with `minAvailable: 2`
- [ ] `topologySpreadConstraints` configured across zones
- [ ] `resources.limits` set (not just requests)
- [ ] `networkPolicy.enabled=true`
- [ ] `ingress.tls` configured with valid cert
- [ ] `migrations.enabled=true` (default)
- [ ] `persistence.size` is sized for at least 30 days of growth

## 4. Database (sign-off: ops lead + DBA)

- [ ] Postgres major version matches `pg_dump` version in backup image
- [ ] Connection pooler (PgBouncer) configured if expected traffic > 100 RPS
- [ ] `_migrations` table is empty in production DB OR manually verified to match staging
- [ ] First migration job dry-run completed successfully on staging
- [ ] Database user has minimum required privileges (no superuser in prod)
- [ ] Connection limit on the DB is at least `max_pods * 10`

## 5. Backups (sign-off: ops lead)

- [ ] `backup.enabled=true` in production values
- [ ] Backup schedule matches RPO target (default daily at 02:00 UTC)
- [ ] `backup.retentionDays=30` (or per data retention policy)
- [ ] S3 bucket has versioning enabled
- [ ] S3 bucket has cross-region replication if RPO requires it
- [ ] Restore drill performed end-to-end on staging within last 90 days (`docs/RUNBOOKS/database_restore.md`)
- [ ] Documented RTO and RPO meet business requirements

## 6. Observability (sign-off: ops lead)

- [ ] `metrics.enabled=true` and `metrics.serviceMonitor.enabled=true`
- [ ] Prometheus is scraping the SiskelBot ServiceMonitor (verify in Prometheus targets page)
- [ ] `metrics.alerting.enabled=true` and PrometheusRule applied
- [ ] All 7 alert rules visible in Prometheus alerts page
- [ ] At least one alert routed to a real channel (PagerDuty / Slack / email) — test with synthetic
- [ ] `metrics.dashboard.enabled=true` and Grafana dashboard discovered
- [ ] Log aggregation configured per `docs/LOGGING.md` (Loki / Datadog / Splunk / CloudWatch)
- [ ] OpenTelemetry traces flowing to backend (Tempo / Jaeger / Datadog APM)
- [ ] Error reporting webhook (`ERROR_REPORT_WEBHOOK_URL`) configured

## 7. Security (sign-off: security)

- [ ] CI pipeline includes Trivy container scanning (currently passing)
- [ ] CodeQL SAST scan has no unresolved CRITICAL findings
- [ ] Dependabot is enabled and outstanding security advisories reviewed
- [ ] Pod runs as non-root with `readOnlyRootFilesystem: true` (verified via `kubectl describe pod`)
- [ ] NetworkPolicy verified: pod cannot reach unrelated namespaces
- [ ] Admin API key NOT in any developer's local `.env`
- [ ] Penetration test or external security review completed (or risk accepted in writing)

## 8. Application configuration (sign-off: tech lead)

- [ ] `BACKEND` env var set to production backend (`openai`, `vllm`, etc.)
- [ ] `LOG_LEVEL=info` (not `debug` — too noisy)
- [ ] `NODE_ENV=production`
- [ ] Rate limiters configured for expected traffic (review `RATE_LIMIT_*` env vars)
- [ ] Circuit breaker thresholds tuned per backend (`docs/BACKENDS.md`)
- [ ] Agent kill switch tested (`AGENT_ENABLED=false` rollout works)
- [ ] HITL approval list configured for sensitive tools (if applicable)

## 9. CI / CD (sign-off: tech lead)

- [ ] All CI jobs passing on the release branch
- [ ] `npm run smoke-test:ci` passes against staging (`STAGING_URL` configured)
- [ ] Eval suite (`npm run eval:ci`) passes
- [ ] Load test (`npm run test:load`) at expected production RPS shows acceptable latency
- [ ] Image tag in `values.production.yaml` matches the released git tag

## 10. Operational readiness (sign-off: ops lead + on-call)

- [ ] On-call rotation defined and acknowledged (PagerDuty / Opsgenie schedule)
- [ ] Runbook URLs distributed to on-call (`docs/RUNBOOK.md`, `docs/RUNBOOKS/*.md`)
- [ ] Slack / incident channel created
- [ ] Status page configured (statuspage.io / cstate / equivalent)
- [ ] Communication plan: who notifies users of incidents, downtime
- [ ] Rollback procedure rehearsed: `helm rollback siskelbot <revision>` tested on staging

## 11. Compliance and legal (sign-off: legal / compliance)

- [ ] Data Processing Agreement signed with hosting provider
- [ ] Data residency requirements met (region selection matches)
- [ ] Privacy policy published and references SiskelBot data handling
- [ ] Terms of Service updated for new product
- [ ] Audit log retention configured per `docs/DATA_RETENTION.md` (7 years for compliance)
- [ ] User deletion endpoint tested end-to-end (`POST /api/v1/compliance/right-to-erasure`)
- [ ] Cookie consent / banner deployed (if EU users expected)

## 12. Launch day (sign-off: launch coordinator)

- [ ] Maintenance window communicated to users (if applicable)
- [ ] Pre-launch smoke test passes against production URL
- [ ] DNS cutover plan documented with rollback steps
- [ ] First 30 minutes: someone watches dashboards continuously
- [ ] First 24 hours: heightened on-call coverage
- [ ] Post-launch retro scheduled within 7 days

---

## Sign-offs

| Phase | Owner | Date | Signature |
|---|---|---|---|
| 1. Infrastructure | Ops lead | | |
| 2. Secrets | Security | | |
| 3. Helm config | Ops lead | | |
| 4. Database | DBA | | |
| 5. Backups | Ops lead | | |
| 6. Observability | Ops lead | | |
| 7. Security | Security | | |
| 8. Application config | Tech lead | | |
| 9. CI/CD | Tech lead | | |
| 10. Operational | Ops lead | | |
| 11. Compliance | Legal | | |
| 12. Launch day | Launch coordinator | | |

**Final go/no-go: ____________________**
