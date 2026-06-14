# Distributed Tracing

SiskelBot emits OpenTelemetry spans for HTTP requests, outgoing `undici`
calls, PostgreSQL queries, and hand-instrumented code paths (agent loop,
swarm dispatch, knowledge base, etc.). Spans can be exported to any
OTLP-compatible backend **and** optionally captured in-process for quick
visual inspection.

## Quick start

### Option 1 — In-process trace explorer (no backend required)

Useful for local development and debugging:

```bash
OTEL_ENABLED=1 \
TRACE_EXPLORER=1 \
npm start
```

Then open [`http://localhost:3000/traces.html`](http://localhost:3000/traces.html)
to see recent traces, click a row to view the waterfall of spans, and click
any span in the waterfall to see its attributes.

What you get:

- Last ~1000 traces in a bounded in-memory buffer (no disk writes)
- Waterfall visualization with colored bars (green = ok, red = error)
- Filters by name, service, status, and minimum duration
- Auto-refresh every 10 seconds
- Aggregate stats (trace count, span count, errors, services)

What it's **not**: a production tracing backend. Traces live in process
memory only, there is no cross-instance aggregation, retention is a rolling
hour by default, and the buffer is wiped on restart.

### Option 2 — Export to Jaeger

```bash
# Start Jaeger locally (all-in-one)
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest

# Run SiskelBot pointed at Jaeger's OTLP HTTP endpoint
OTEL_ENABLED=1 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces \
OTEL_SERVICE_NAME=siskel-bot \
npm start
```

Browse to [`http://localhost:16686`](http://localhost:16686) and select the
`siskel-bot` service to explore traces with full Jaeger search, tag filters,
and trace comparison.

### Option 3 — Export to Grafana Tempo

```bash
OTEL_ENABLED=1 \
OTEL_EXPORTER_OTLP_ENDPOINT=https://tempo.example.com/v1/traces \
OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic <base64>" \
OTEL_SERVICE_NAME=siskel-bot \
npm start
```

### Option 4 — Export to Honeycomb

```bash
OTEL_ENABLED=1 \
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces \
OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=$HONEYCOMB_API_KEY,x-honeycomb-dataset=siskel-bot" \
OTEL_SERVICE_NAME=siskel-bot \
npm start
```

Note: standard OpenTelemetry environment variables (`OTEL_*`) are respected
by the upstream `@opentelemetry/sdk-node` package. See the
[OTel spec](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/)
for the full list.

## You can combine the two

The explorer and the OTLP exporter coexist. Leave `TRACE_EXPLORER=1` on in
development even when you also export to Jaeger; the explorer adds a
`SimpleSpanProcessor` in front of the batch exporter, so it doesn't affect
what gets shipped upstream.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OTEL_ENABLED` | `0` | Master switch. Must be `1` for any tracing at all. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318/v1/traces` | OTLP HTTP endpoint. |
| `OTEL_SERVICE_NAME` | `siskel-bot` | Service name attached to spans. |
| `OTEL_SERVICE_VERSION` | `npm_package_version` | Service version attribute. |
| `OTEL_AUTO_INSTRUMENT` | `1` | Enable HTTP/undici auto-instrumentation. |
| `OTEL_PG_INSTRUMENT` | `1` | Enable PostgreSQL instrumentation. |
| `OTEL_PG_ENHANCED` | `0` | Include full SQL text in span attributes. |
| `OTEL_TRACES_SAMPLER` | unset | `always_on`, `always_off`, `traceidratio`, etc. |
| `OTEL_TRACE_SAMPLING_RATIO` | `1.0` | Head-based sampler ratio (0..1). |
| `TRACE_EXPLORER` | `0` | Enable the in-process explorer page. |
| `TRACE_EXPLORER_MAX_TRACES` | `1000` | Maximum traces retained in memory. |
| `TRACE_EXPLORER_RETENTION_MS` | `3600000` | Retention window for `prune()`. |

## HTTP API

When the explorer is enabled, these endpoints are available:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/traces/explorer` | List recent traces (query filters: `limit`, `service`, `status`, `name`, `minDuration`, `startTime`). |
| `GET` | `/api/v1/traces/explorer/stats` | Totals by service and status. |
| `GET` | `/api/v1/traces/explorer/:traceId` | Flat list of spans for a trace, sorted by start time. |
| `GET` | `/api/v1/traces/explorer/:traceId/tree` | Parent/child tree structure (used by the waterfall UI). |

Example:

```bash
curl -s http://localhost:3000/api/v1/traces/explorer?status=error | jq .
curl -s http://localhost:3000/api/v1/traces/explorer/stats | jq .
```

## Sampling in production

For high-volume deployments, head-sample at source and tail-sample in the
OpenTelemetry Collector. A typical setup:

```bash
OTEL_ENABLED=1
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACE_SAMPLING_RATIO=0.1           # keep 10%
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318/v1/traces
TRACE_EXPLORER=0                        # don't buffer on production replicas
```

Then run the Collector with a `tail_sampling` processor that always keeps
error traces and a sample of fast ones. See
`docs/otel-collector-config.yaml` for a reference config.

## How spans are enriched

The `otelHttpEnrichmentMiddleware` in `lib/otel-context.js` attaches
request-scoped attributes to every HTTP server span without leaking raw PII:

- `siskel.workspace_id` — from query, body, or agent options
- `siskel.user_id_hash` — first 16 hex chars of `sha256(userId)`
- `siskel.request_id` / `http.request_id` — request correlation id

The agent loop adds its own spans via the helpers in `lib/tracing-spans.js`:

```js
import { withSpan, addSpanEvent, recordSpanError } from "./tracing-spans.js";

await withSpan("agent.tool.execute", { tool: name }, async (span) => {
  span.setAttribute("agent.iteration", i);
  addSpanEvent("tool.call.start");
  return await tool.run(args);
});
```

## Troubleshooting

**The explorer page shows "disabled" banner.** Make sure both `OTEL_ENABLED=1`
and `TRACE_EXPLORER=1` are set before starting the server.

**No traces appear even after issuing requests.** Check the server log for
`[otel] Tracing enabled` at startup. If it's missing, the SDK failed to
initialize — verify the `@opentelemetry/*` packages are installed.

**Traces are captured but parent/child links look wrong.** Make sure you
aren't mixing `http` and `undici` instrumentation with custom spans started
outside an active context. Use `withSpan()` rather than raw `tracer.startSpan`
when possible so the active context is preserved.

**Memory usage grows over time.** The explorer is bounded by
`TRACE_EXPLORER_MAX_TRACES` (default 1000). Lower the limit or disable the
explorer on long-running production replicas and use an external backend.
