# Logging

Operational guide for the log pipeline from SiskelBot to your aggregator.

## 1. Overview

SiskelBot writes structured JSON logs to stdout/stderr by default. PII and
secrets are scrubbed by `lib/log-sanitizer.js` before any request body or
header is logged.

The server does **not** ship logs directly under normal operation — your
container runtime (Kubernetes kubelet, Docker daemon, ECS agent) captures
stdout/stderr and forwards it to your log aggregator. An optional in-process
log shipper (`LOG_SHIP_*` env vars) is available for environments where
sidecar/daemonset collection isn't possible; prefer runtime collection where
you can.

For trace-log correlation, see [docs/TRACING](/docs/TRACING). The
`siskel.request_id` attribute and the `requestId` log field link logs to
spans.

## 2. Configuration

All log-related environment variables (verified against `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | When set to `production`, enables stricter defaults and arms `initErrorReporting`. |
| `ERROR_REPORT_WEBHOOK_URL` | unset | POST uncaught exceptions and unhandled rejections to this URL (production only). See `lib/error-reporting.js`. |
| `LOG_SHIP_PROVIDER` | unset | Optional in-process shipper. One of `datadog`, `splunk`, `loki`, `elasticsearch`, `http`. Leave unset to rely on container-runtime collection. |
| `LOG_SHIP_ENDPOINT` | unset | Endpoint URL (required for all providers except `datadog`, which has a built-in default). |
| `LOG_SHIP_API_KEY` | unset | Authentication token: DD-API-KEY for Datadog, HEC token for Splunk, basic-auth value for Loki, etc. |
| `LOG_SHIP_BATCH_SIZE` | `100` | Flush when the in-memory batch reaches this many events. |
| `LOG_SHIP_FLUSH_INTERVAL_MS` | `5000` | Flush every N ms even if the batch isn't full. |
| `LOG_SHIP_DD_TAGS` | unset | Datadog only: comma-separated `ddtags`, e.g. `env:prod,service:siskelbot`. |

There is intentionally no `LOG_LEVEL` knob in the current build — log volume
is controlled by what call sites choose to emit and by sampling at the
collector. If you need quieter prod logs, suppress at the collector layer
(see section 7).

## 3. PII scrubbing

`lib/log-sanitizer.js` exports two helpers, both of which run synchronously
and return sanitized copies (the original object is never mutated):

- **`sanitizeForLog(obj)`** — recursively walks objects/arrays and replaces
  values for any key matching the sensitive set: `api_key`, `apikey`,
  `apiKey`, `authorization`, `password`, `passwd`, `pwd`, `secret`, `token`,
  `access_token`, `refresh_token`, `session_secret`, `x-api-key`,
  `x-admin-api-key`, `x-user-api-key`, `x-backup-admin-key`, `bearer`,
  `cookie`, `session`. Any key matching the regex
  `/^(x-)?(api-?key|auth|token|secret|password|cookie|bearer)/i` is also
  redacted. Replacement is the literal string `[REDACTED]`.
- **`sanitizeRequestForLog(req)`** — produces `{ method, path, headers?,
  body? }` with headers redacted (any header name containing `auth`, `key`,
  `token`, `cookie`, `secret`, or `password`) and body run through
  `sanitizeForLog`.

**Always run a sanitizer before logging request bodies, headers, or any
object that may carry user credentials.** This is mandatory in production
— bypassing it can leak API keys into your aggregator and is a compliance
violation under SOC2/GDPR.

The sanitizer does not strip raw email addresses or arbitrary user content
in message bodies; if a code path logs free-form chat content, that content
will appear in the log. Limit body logging to error paths and short
metadata.

## 4. Kubernetes log collection

Three common patterns. Pick one — running multiple in parallel doubles your
egress cost.

### Loki (Grafana stack)

Lightest-weight option. Run Promtail (or Grafana Alloy) as a DaemonSet that
tails `/var/log/pods/`.

```yaml
# promtail-values.yaml (snippet)
config:
  clients:
    - url: http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push
  snippets:
    pipelineStages:
      - cri: {}
      - json:
          expressions:
            level:
            timestamp:
            msg:
            requestId:
            traceId:
      - labels:
          level:
          namespace:
          pod:
      - timestamp:
          source: timestamp
          format: RFC3339Nano
```

In Grafana, the LogQL query for SiskelBot errors:

```logql
{namespace="siskelbot"} |= "error" | json | level="error"
```

Correlate with a trace ID from Tempo:

```logql
{namespace="siskelbot"} | json | traceId="4bf92f3577b34da6a3ce929d0e0e4736"
```

### Datadog Agent

Install the Datadog Helm chart with log collection enabled.

```yaml
# datadog-values.yaml (snippet)
datadog:
  apiKeyExistingSecret: datadog-secret
  logs:
    enabled: true
    containerCollectAll: true
    containerCollectUsingFiles: true
  containerExclude: "kube_namespace:kube-system"
  tags:
    - env:prod
    - service:siskelbot
```

Filter in the Datadog UI:

```
service:siskelbot status:error
service:siskelbot @requestId:abc123
```

### Splunk (OTel Collector or HEC)

Run the OpenTelemetry Collector as a DaemonSet with the `filelog` receiver
and the `splunk_hec` exporter.

```yaml
# otel-collector-config.yaml (snippet)
receivers:
  filelog:
    include: [/var/log/pods/siskelbot_*/*/*.log]
    operators:
      - type: container
      - type: json_parser
        parse_from: attributes.log

exporters:
  splunk_hec:
    token: ${env:SPLUNK_HEC_TOKEN}
    endpoint: https://splunk.example.com:8088/services/collector
    source: siskelbot
    sourcetype: _json
    index: siskelbot_prod

service:
  pipelines:
    logs:
      receivers: [filelog]
      exporters: [splunk_hec]
```

## 5. AWS CloudWatch (for EKS)

Run the AWS-distributed Fluent Bit DaemonSet (`aws-for-fluent-bit`) with
the `cloudwatch_logs` output. Minimal config:

```ini
# fluent-bit.conf (snippet)
[INPUT]
    Name              tail
    Tag               siskelbot.*
    Path              /var/log/containers/siskelbot-*.log
    Parser            docker
    DB                /var/fluent-bit/state/flb_container.db
    Mem_Buf_Limit     50MB
    Skip_Long_Lines   On

[OUTPUT]
    Name              cloudwatch_logs
    Match             siskelbot.*
    region            us-east-1
    log_group_name    /aws/eks/siskelbot
    log_stream_prefix ${HOSTNAME}-
    auto_create_group true
    log_format        json/emf
```

For EKS-managed setups the AWS docs cover the IRSA service-account binding
and node IAM permissions; this guide doesn't duplicate that. Verify the
DaemonSet has `logs:CreateLogStream` and `logs:PutLogEvents` on the
`/aws/eks/siskelbot:*` ARN.

Query in CloudWatch Logs Insights:

```
fields @timestamp, level, msg, requestId
| filter level = "error"
| sort @timestamp desc
| limit 100
```

## 6. Local development

For local dev, just `tail` the server output. Pretty-print JSON with `jq`:

```bash
npm run dev | jq -R 'fromjson? // .'
```

The `fromjson? // .` pattern parses JSON lines when possible and falls back
to plain text for non-JSON output (startup banners, watch-mode notices).

To follow only errors:

```bash
npm run dev | jq -R 'fromjson? // empty | select(.level=="error")'
```

## 7. Sampling and cost control

There is no `LOG_LEVEL` env var (see section 2). Reduce log volume in
production via the collector:

- **Promtail**: drop debug-level entries with a `match` stage and
  `action: drop`.
- **OTel Collector**: use the `filter` processor with an OTTL expression
  like `severity_number < SEVERITY_NUMBER_WARN`.
- **Datadog**: configure exclusion filters per service in the Logs UI.

Always retain `error` and `warn` regardless of sampling. Sampling debug/info
is fine; sampling errors masks incidents.

For trace sampling, see [docs/TRACING — sampling](/docs/TRACING#sampling-in-production).
The `traceId` field in logs links to the trace; if you tail-sample traces,
keep the corresponding logs unsampled so post-hoc investigation still
works.

## 8. Required logs for incident response

Runbooks under `docs/RUNBOOKS/` (e.g. `high_error_rate.md`,
`backend_down.md`, `agent_loop_runaway.md`) assume the following fields
are present in production logs:

- **`requestId`** — correlates a single HTTP request across middleware,
  agent loop, tool calls, and downstream backend fetches. Same value as the
  `siskel.request_id` span attribute.
- **`userId` / `workspaceId`** — for tenant scoping. These are the resolved
  storage IDs from `resolveStorageUserId`, not raw OAuth subjects. Already
  considered safe to log per `lib/log-sanitizer.js` (they are opaque IDs,
  not PII).
- **`backend`** — name of the upstream LLM provider (`openai`, `ollama`,
  `vllm`, etc.) for the request, plus circuit-breaker state transitions
  (`open`, `half-open`, `closed`) emitted by `lib/circuit-breaker.js`.
- **`agentRunId`** — for `agent_loop_runaway.md`. Lets you reconstruct an
  entire single-agent or swarm run from the trajectory store.
- **`error.name`, `error.message`, `error.stack`** — present on all caught
  errors. Uncaught exceptions are additionally posted to
  `ERROR_REPORT_WEBHOOK_URL` if configured.

## 9. Retention recommendations

| Log type | Retention | Reason |
|---|---|---|
| Application logs (info/warn) | 30 days | Debugging recent issues, postmortem windows |
| Error logs | 90 days | Trend analysis, regression detection across releases |
| Audit logs | 7 years | Compliance (SOC2, GDPR Article 30) |
| Access logs | 1 year | Security forensics, abuse investigation |

SiskelBot's audit log (see [docs/COMPLIANCE](/docs/COMPLIANCE)) is
written to the storage backend, **not** to stdout, and has its own
retention configuration independent of container log retention. Don't
collapse the two: deleting old container logs does not affect audit
records, and vice versa.
