# SiskelBot Grafana Dashboard

Pre-built Grafana dashboard for monitoring SiskelBot via Prometheus metrics.

## Prerequisites

- SiskelBot running with `ENABLE_METRICS=1`
- Prometheus scraping the SiskelBot `/metrics` endpoint
- Grafana with a configured Prometheus data source

## Import Instructions

1. Open Grafana and navigate to **Dashboards > Import**
2. Either upload `dashboard.json` or paste its contents into the JSON field
3. Select your Prometheus data source when prompted
4. Click **Import**

The dashboard will be available as **SiskelBot Overview** (uid: `siskelbot-overview`).

## Dashboard Rows

| Row | Panels |
|-----|--------|
| **Overview** | Request rate, 5xx error rate, active WebSocket connections |
| **Chat & Agent** | Chat requests/s, tokens used, agent phase durations, tool timeouts, agent runs by stop reason, swarm specialist success/failure |
| **Latency** | Request latency p50/p95/p99 histogram quantiles, average backend response time by path, per-path p95 breakdown |
| **Quotas & Rate Limiting** | HTTP 429 rate-limit hits by path, status code distribution |
| **System** | Resident memory, CPU usage rate, circuit breaker state (current + over time) |

## Metric Names Used

All queries reference the exact metric names exported by `lib/metrics.js`:

- `http_requests_total{method, path, status}` -- counter
- `http_request_duration_seconds_bucket{method, path, le}` -- histogram
- `http_request_duration_seconds_sum{method, path}` -- histogram sum
- `http_request_duration_seconds_count{method, path}` -- histogram count
- `siskelbot_chat_requests_total` -- counter
- `siskelbot_tokens_used_total` -- counter
- `siskelbot_active_connections` -- gauge
- `siskelbot_agent_phase_milliseconds_sum{mode, phase}` -- counter
- `siskelbot_agent_phase_samples_total{mode, phase}` -- counter
- `siskelbot_agent_runs_total{mode, stop_reason}` -- counter
- `siskelbot_agent_tool_timeouts_total{tool}` -- counter
- `experimentagent_circuit_breaker_open{backend}` -- gauge
- `experimentagent_swarm_invocations_total` -- counter
- `experimentagent_swarm_specialist_success_total` -- counter
- `experimentagent_swarm_specialist_failure_total` -- counter
- `process_resident_memory_bytes` -- gauge
- `process_cpu_seconds_total` -- counter

## Templating Variables

- **instance** -- Filter by Prometheus `instance` label (multi-select, defaults to All)
- **datasource** -- Select Prometheus data source

## Alerting Rules

Pre-built alerting rules are provided in `alerts.json` for Grafana 10+ unified alerting.

### Import Alerts

**Via provisioning (recommended):**

1. Copy `alerts.json` to your Grafana provisioning directory:
   ```bash
   cp grafana/alerts.json /etc/grafana/provisioning/alerting/siskelbot-alerts.json
   ```
2. Restart Grafana. The alert rules will be created automatically.

**Via the Grafana UI:**

1. Navigate to **Alerting > Alert rules**
2. Click **Import** or create a new rule group named "SiskelBot Alerts"
3. Paste the rules from `alerts.json` into the JSON editor

**Via the Grafana HTTP API:**

```bash
curl -X POST http://localhost:3000/api/v1/provisioning/alert-rules \
  -H "Authorization: Bearer $GRAFANA_API_KEY" \
  -H "Content-Type: application/json" \
  -d @grafana/alerts.json
```

### Alert Rules

| Rule | Condition | Severity | For |
|------|-----------|----------|-----|
| **Error Rate Spike** | 5xx error rate > 5% of total requests | critical | 5m |
| **Latency Degradation** | p95 request latency > 5 seconds | warning | 5m |
| **Quota Exhaustion** | Any workspace > 90% token quota | warning | 5m |
| **Circuit Breaker Open** | Any backend circuit breaker opens | critical | 0s (instant) |
| **Agent Tool Timeouts** | Tool timeouts > 10 per minute | warning | 1m |
| **Webhook DLQ Growth** | Dead-letter queue size > 50 | warning | 5m |

### Notification Channels

After importing alerts, configure contact points in **Alerting > Contact points** to route notifications to Slack, email, PagerDuty, or other channels. The rules include labels (`severity`, `category`) you can use for routing policies.

### Custom Metrics Note

The quota exhaustion alert uses `siskelbot_workspace_tokens_used` and `siskelbot_workspace_quota_limit` metrics. The webhook DLQ alert uses `siskelbot_webhook_dlq_size`. If these metrics are not yet exported by your SiskelBot instance, add custom instrumentation in `lib/metrics.js` or monitor via the admin API (`/api/admin/quotas`).

## Notes

- Rate-limit tracking uses HTTP 429 status codes from `http_requests_total` since SiskelBot does not export a dedicated rate-limit counter.
- Quota usage per workspace is not currently exported as a Prometheus metric. Monitor via the admin API (`/api/admin/quotas`) or add custom instrumentation.
- Circuit breaker state uses the legacy `experimentagent_circuit_breaker_open` metric name as exported by `lib/metrics.js`.
- Default time range is 1 hour with 30-second auto-refresh.
