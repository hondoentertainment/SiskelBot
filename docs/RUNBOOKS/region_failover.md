# Region Failover

**Severity:** critical — entire region is unavailable; user-visible outage in scope.

**Time to resolve:** 15 – 30 minutes for DNS-based failover. 45 – 90 minutes if database promotion is required.

> Assumptions for this runbook: active-passive topology between two regions, primary in `us-east-1`, secondary (warm standby) in `us-west-2`. Cross-region Postgres replication is in place (managed RDS read replica or self-managed streaming replication). The public hostname `siskelbot.example.com` resolves through Route 53 with a 60-second TTL. See `docs/MULTI_REGION_HA.md` for the architecture this runbook operates on.

## 1. Symptoms

- Users in or routed to the affected region report 5xx responses or timeouts for `/v1/chat/completions` and `/api/*`.
- Synthetic probes from the `Probe` CRD / blackbox-exporter show `probe_success == 0` for the primary region's `/health/live` and `/health/deep` targets.
- Cloud provider status page reports a region-wide incident (compute, networking, EBS, or RDS).
- In-cluster pods in the primary region appear healthy on `kubectl get pods` but external connectivity (ingress, NAT gateway, public LB) is broken.
- Region-health endpoint shows the primary as down: `GET /api/regions` (admin-only) returns `status: "unhealthy"` for `us-east-1`.

## 2. Severity

**Critical** — the entire primary region is unavailable. Failover is a last-resort remediation; prefer scaling down primary traffic via load-balancer weights when the primary is only degraded.

## 3. Pre-flight verification (do not fail over for partial outages)

```bash
# Confirm primary is actually unreachable, secondary is healthy
curl -fsS --max-time 10 https://siskelbot-us-east-1.example.com/health/live
curl -fsS --max-time 10 https://siskelbot-us-west-2.example.com/health/live

# Synthetic probe results from blackbox-exporter
kubectl logs -n monitoring deploy/blackbox-exporter --tail=50

# Cross-region health view from a surviving region's admin API
curl -fsS -H "Authorization: Bearer $ADMIN_KEY" \
  https://siskelbot-us-west-2.example.com/api/regions | jq .

# Cloud provider status (open in a browser; do not block the runbook on it)
#   AWS:   https://health.aws.amazon.com/health/status
#   GCP:   https://status.cloud.google.com
#   Azure: https://azure.status.microsoft
```

Decision rule:

- **Primary returns 2xx for some traffic, errors for the rest** → degraded, not down. Reduce primary weight in the load balancer (e.g. set primary `weight=10`, secondary `weight=90`) and investigate; do **not** execute full failover.
- **Primary returns no response within 10 seconds and synthetic probes are red for ≥ 3 minutes** → proceed to failover.

Dashboards to confirm scope (replace placeholders for your environment):

- Primary region overview: `<replace>https://grafana.example.com/d/siskelbot-region/us-east-1</replace>`
- Cross-region health: `<replace>https://grafana.example.com/d/siskelbot-multiregion</replace>`
- Synthetic probes: `<replace>https://grafana.example.com/d/blackbox/siskelbot</replace>`

## 4. Declare the incident

```text
/incident declare severity:critical title:"us-east-1 region down — failing over to us-west-2"
```

Post in `#incidents` and page the on-call SRE and the database on-call. Capture timestamps at every step — they become the postmortem timeline.

## 5. DNS-based failover (preferred when both regions have writable DB)

This is the path when the database in the primary region is **already replicated** to the secondary and either (a) is still reachable for replication catch-up, or (b) the secondary read replica is current within the RPO target.

```bash
# 1. Update Route 53 to point siskelbot.example.com at us-west-2
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch file://failover-to-us-west-2.json

# 2. Verify the change was accepted
aws route53 get-change --id /change/<change-id-from-previous-output>

# 3. Confirm DNS propagation against multiple resolvers
dig +noall +answer siskelbot.example.com
dig @1.1.1.1 +noall +answer siskelbot.example.com
dig @8.8.8.8 +noall +answer siskelbot.example.com
```

Minimal `failover-to-us-west-2.json` change batch:

```json
{
  "Comment": "Failover siskelbot.example.com to us-west-2",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "siskelbot.example.com.",
        "Type": "CNAME",
        "TTL": 60,
        "ResourceRecords": [
          { "Value": "siskelbot-us-west-2.example.com." }
        ]
      }
    }
  ]
}
```

**TTL caveat.** Failover speed is bounded by DNS TTL. The production record must already be at 60 s — verify with `dig +noall +answer siskelbot.example.com` before assuming clients have moved over. Some corporate resolvers and mobile carriers ignore TTLs below ~5 minutes; expect a long tail of stragglers.

## 6. Database promotion (only if the primary DB is in the failed region and unreachable)

**Promote the database before pointing traffic at the secondary**, otherwise the secondary region's pods fail readiness checks against a read-only replica and crash-loop.

```bash
# Path A: AWS RDS managed multi-AZ failover (within a region)
aws rds failover-db-cluster --db-cluster-identifier siskelbot-prod

# Path B: cross-region read replica → standalone primary (no auto-failback)
aws rds promote-read-replica \
  --db-instance-identifier siskelbot-prod-us-west-2

# Wait for the instance to leave 'modifying' state
aws rds describe-db-instances \
  --db-instance-identifier siskelbot-prod-us-west-2 \
  --query 'DBInstances[0].DBInstanceStatus'
```

Once the secondary DB is writable, update the secondary region's secret and roll the deployment so pods reconnect to the new primary:

```bash
# Update the secret (redact the actual URL — use a sealed/sops secret in real life)
kubectl -n siskelbot create secret generic siskelbot-secrets \
  --from-literal=DATABASE_URL='postgres://siskelbot:****@siskelbot-prod-us-west-2.<id>.us-west-2.rds.amazonaws.com:5432/siskelbot' \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n siskelbot rollout restart deploy/siskelbot
kubectl -n siskelbot rollout status deploy/siskelbot --timeout=5m
```

If the deployment uses an env-var override directly:

```bash
kubectl -n siskelbot set env deploy/siskelbot \
  DATABASE_URL='postgres://siskelbot:****@siskelbot-prod-us-west-2....:5432/siskelbot'
kubectl -n siskelbot rollout restart deploy/siskelbot
```

After the DB is promoted and the app is rolled, return to step 5 to flip DNS.

## 7. Pre-scale the secondary region

The secondary should already be sized to ≥ 80% of primary capacity. Confirm and bump if not:

```bash
# Current state
kubectl --context us-west-2 -n siskelbot get hpa,deploy

# Temporarily raise the floor so HPA does not have to ramp from 3 replicas
kubectl --context us-west-2 -n siskelbot scale deploy/siskelbot --replicas=12

# Or patch the HPA min replicas
kubectl --context us-west-2 -n siskelbot patch hpa siskelbot \
  -p '{"spec":{"minReplicas":12}}'
```

Watch CPU and request rate for 2 – 3 minutes — secondary should absorb traffic without saturating before declaring success.

## 8. Verify failover succeeded

```bash
# 1. App responds end-to-end against the public hostname
curl -fsS https://siskelbot.example.com/health/deep | jq .

# 2. Database is writable (POST hits the primary, not a replica)
curl -fsS -X POST https://siskelbot.example.com/api/v1/conversations \
  -H "Authorization: Bearer $TEST_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"failover-test"}'

# 3. Background workers are running (scheduler, webhook deliverer, audit archiver)
kubectl --context us-west-2 -n siskelbot logs \
  -l app.kubernetes.io/name=siskelbot --tail=100 | grep -Ei 'scheduler|leader|webhook'

# 4. Leader election picked a leader in the secondary region
curl -fsS -H "Authorization: Bearer $ADMIN_KEY" \
  https://siskelbot.example.com/api/regions/leader | jq .

# 5. Synthetic probes recovered (probe_success == 1 for siskelbot.example.com)
#    Check the synthetic-probes dashboard above.
```

A real chat completion is the strongest end-to-end signal:

```bash
curl -fsS https://siskelbot.example.com/v1/chat/completions \
  -H "Authorization: Bearer $TEST_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"failover smoke test"}],"stream":false}' \
  | jq '.choices[0].message.content'
```

## 9. What to say to leadership

Post once the failover is complete and verified:

```text
Update — siskelbot region failover

Status:    Mitigated. Traffic serving from us-west-2.
Started:   <UTC start time>
Mitigated: <UTC mitigation time>
Impact:    ~<N> minutes of elevated 5xx for users routed through us-east-1.
           <X>% of requests in the impact window failed.
Action:    Failed over to us-west-2 via Route 53 (DNS) and promoted the
           cross-region Postgres replica. All health checks green.
Next:      Monitoring secondary capacity. Failback is NOT planned during
           the incident; we will schedule it once us-east-1 is stable for
           24 h. Postmortem within 5 business days.
Owner:     <on-call SRE name>
```

## 10. Post-incident actions

- Update statuspage to **Monitoring** once health is green; move to **Operational** after 30 minutes of stability.
- Notify customers via email if the incident breached SLA (> 4 hours of impact or > 99.9% monthly budget burn).
- File a postmortem within 5 business days. Include the realized RTO, the realized RPO, and any DNS stragglers observed beyond TTL.
- Test the failback procedure (step 11) in the next maintenance window — **do not fail back during the incident**, it adds risk.
- Restore HPA `minReplicas` on the secondary back to its production default once load has normalized (otherwise you will pay for over-provisioned capacity indefinitely).

## 11. Failback procedure (after the primary region recovers)

Failback is a planned change, not an incident response.

1. Verify primary region health for **24 hours** of green synthetic probes and zero alert noise.
2. Schedule a maintenance window (low-traffic period; notify customers if user-visible).
3. **Set up reverse replication first.** If step 6 promoted the secondary DB to standalone primary, configure the original primary as a replica of the new primary. Verify replication lag is `< 1 s` for at least 30 minutes before cutover.
4. Lower the public DNS TTL to 60 s (it should already be 60 s — confirm) **24 hours before** the failback to ensure clients pick up the change quickly.
5. Reverse the Route 53 change (point the public CNAME back at the primary region's regional hostname). Use the same change-batch pattern as step 5.
6. Watch error rates and synthetic probes for 1 hour. If anything regresses, immediately reverse DNS again.
7. Once stable, promote the original primary back to standalone and re-establish secondary as the read replica.

## 12. Common pitfalls

| Pitfall | Mitigation |
|---|---|
| Cached DNS at clients (browsers, JVM apps, mobile carriers) | Document the 60 s TTL and a long tail of stragglers; advise SDK consumers to use the cloud LB DNS or a CNAME they re-resolve frequently. Plan for ~10 minutes of trickling primary traffic after cutover. |
| Database split-brain after failback | Always set up reverse replication **before** failback; verify replication lag `< 1 s` for 30 minutes before cutover. Never have two writable Postgres primaries serving the same dataset. |
| Asymmetric region capacity | Pre-scale secondary to ≥ 80% of primary capacity in steady state. Document the exact `kubectl scale` / HPA-patch commands (step 7). |
| Rate limiters reset on failover | `lib/tenant-quotas.js` is in-memory and per-process; quotas reset whenever pods restart in a new region. Document and accept — this is a transient soft-quota over-grant in the failover window. |
| Sessions invalidated | Use Postgres-backed sessions (already the default with `STORAGE_BACKEND=postgres`). Confirm the session table replicates cross-region; if it doesn't, users are forced to re-authenticate after failover. |
| Scheduler runs twice during overlap | Leader election (`lib/leader-election.js`) is TTL-based at `LEADER_TTL_MS` (default 30 s). After a failover, expect up to 30 s where no leader is elected; scheduled jobs in that window are skipped, not duplicated. |
| WebSocket connections do not migrate | WebSockets are sticky to the process. All clients reconnect after failover; ensure the client SDK retries with backoff. |
| `INTERNAL_SECRET` mismatch between regions | If replication was being used (`ENABLE_REPLICATION=1`), confirm both regions share the same `INTERNAL_SECRET`. A mismatch silently drops sync writes. |

## 13. Related runbooks

- `docs/RUNBOOKS/database_restore.md` — if data loss is suspected and you need a point-in-time restore rather than a replica promotion.
- `docs/RUNBOOKS/backend_down.md` — if the LLM backend (Ollama / vLLM / OpenAI) is the failing dependency rather than the region itself.
- `docs/RUNBOOKS/high_error_rate.md` — if the symptom is elevated 5xx but the region is reachable; failover is usually the wrong tool there.
- `docs/MULTI_REGION_HA.md` — architecture and configuration reference for the multi-region setup this runbook assumes.
