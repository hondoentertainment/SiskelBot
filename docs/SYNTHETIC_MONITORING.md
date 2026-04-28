# Synthetic Monitoring

External uptime probes for SiskelBot, driven by the Prometheus Operator
`Probe` CRD and [blackbox-exporter](https://github.com/prometheus/blackbox_exporter).

See also: [docs/RUNBOOK.md](./RUNBOOK.md) for incident response when probes fire.

## Overview

In-cluster monitoring (the `ServiceMonitor` shipped in this chart) scrapes
SiskelBot pods directly. That answers "is my process serving 200s on its pod
IP?", but it cannot detect the failure modes that real users hit:

- DNS resolution failures for the public hostname
- Ingress controller misconfiguration / 502s from the LB
- TLS certificates that expired, are missing intermediates, or have wrong SAN
- Regional network outages between users and the cluster
- CDN / WAF / proxy layers in front of the ingress dropping traffic

Synthetic monitoring closes that gap. A blackbox-exporter sitting outside the
SiskelBot pods (ideally outside the cluster, or at least in a different node /
network zone) issues real HTTP requests against the public URL and records
success, latency, and TLS expiry. The Prometheus Operator `Probe` CRD wires
those targets into Prometheus as a scrape job.

## Prerequisites

- [Prometheus Operator](https://prometheus-operator.dev/) installed (the
  kube-prometheus-stack chart is the easiest path).
- [blackbox-exporter](https://github.com/prometheus/blackbox_exporter)
  reachable from your Prometheus instance. Most clusters install it in the
  `monitoring` namespace next to Prometheus.
- The SiskelBot ingress / load balancer is reachable from wherever
  blackbox-exporter runs.

## blackbox-exporter setup

A minimal `http_2xx` module is enough for SiskelBot's `/health/live` and
`/health/deep` endpoints. Install via the
[prometheus-blackbox-exporter Helm chart](https://github.com/prometheus-community/helm-charts/tree/main/charts/prometheus-blackbox-exporter):

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

cat > blackbox-values.yaml <<'YAML'
config:
  modules:
    http_2xx:
      prober: http
      timeout: 10s
      http:
        method: GET
        valid_http_versions: ["HTTP/1.1", "HTTP/2.0"]
        valid_status_codes: [200]
        follow_redirects: true
        preferred_ip_protocol: ip4
        fail_if_ssl: false
        fail_if_not_ssl: true
    http_post_2xx:
      prober: http
      timeout: 10s
      http:
        method: POST
        valid_status_codes: [200, 201, 202]
        headers:
          Content-Type: application/json
        body: '{}'
serviceMonitor:
  enabled: false  # this chart's own SM; not needed for SiskelBot's Probe CRD
YAML

helm install blackbox-exporter prometheus-community/prometheus-blackbox-exporter \
  -n monitoring -f blackbox-values.yaml
```

The exporter Service ends up at
`http://blackbox-exporter.monitoring.svc.cluster.local:9115` — the default in
`values.yaml`.

## Enabling synthetic probes on SiskelBot

The chart ships a `Probe` template gated on `metrics.synthetic.enabled`:

```bash
helm upgrade siskelbot ./helm/siskelbot \
  -f helm/siskelbot/values.production.yaml \
  --set metrics.synthetic.enabled=true \
  --set 'metrics.synthetic.targets[0]=https://siskelbot.yourdomain.com/health/live' \
  --set 'metrics.synthetic.targets[1]=https://siskelbot.yourdomain.com/health/deep' \
  -n siskelbot
```

Useful values:

| Value | Default | Notes |
|---|---|---|
| `metrics.synthetic.enabled` | `false` | Toggle the `Probe` resource on/off. |
| `metrics.synthetic.blackboxExporterUrl` | `http://blackbox-exporter.monitoring.svc.cluster.local:9115` | Service URL Prometheus will hit. |
| `metrics.synthetic.module` | `http_2xx` | Must exist in your blackbox config. |
| `metrics.synthetic.interval` | `30s` | How often Prometheus runs the probe. |
| `metrics.synthetic.scrapeTimeout` | `15s` | Per-scrape timeout (must exceed blackbox `timeout`). |
| `metrics.synthetic.targets` | `[]` | Public URLs to probe. |
| `metrics.synthetic.staticLabels` | `{}` | Labels attached to every series (e.g. `region`, `environment`). |

The `values.production.yaml` enables synthetic probing by default with the
example domain `siskelbot.example.com`. Replace it with your real public
hostname before deploying.

### Alerts

`prometheusrule.yaml` adds three alerts driven by the probe metrics:

- **SiskelBotProbeDown** — `probe_success == 0` for 2m (severity: critical).
- **SiskelBotProbeSlowResponse** — `probe_duration_seconds > 5` for 5m.
- **SiskelBotTLSCertExpiringSoon** — `probe_ssl_earliest_cert_expiry - time() < 14d`.

### Dashboard

The bundled Grafana dashboard adds two panels:

- **Synthetic uptime (24h)** — `avg_over_time(probe_success{...}[24h])`,
  formatted as percent, green at 0.99, brighter green at 0.999.
- **Probe duration** — `probe_duration_seconds`, one series per target.

## Multi-region probing

To detect regional outages and routing problems, deploy blackbox-exporter in
each region (e.g. `monitoring-us-east-1`, `monitoring-eu-west-1`) and create
one `Probe` CRD per region with regional `staticLabels`. The
`metrics.synthetic` block in this chart is single-region; deploy multiple
SiskelBot releases or use a sibling chart that creates a `Probe` per region:

```yaml
# Region 1
metrics:
  synthetic:
    enabled: true
    blackboxExporterUrl: "http://blackbox-exporter.monitoring-us-east-1.svc.cluster.local:9115"
    targets:
      - https://siskelbot.yourdomain.com/health/deep
    staticLabels:
      region: us-east-1
      prober: in-cluster

# Region 2 (separate release / values)
metrics:
  synthetic:
    enabled: true
    blackboxExporterUrl: "http://blackbox-exporter.monitoring-eu-west-1.svc.cluster.local:9115"
    targets:
      - https://siskelbot.yourdomain.com/health/deep
    staticLabels:
      region: eu-west-1
      prober: in-cluster
```

Federate the regional Prometheis into a global Prometheus / Thanos / Mimir to
alert when *any* region sees `probe_success == 0`. Combine with `region`
label routing in Alertmanager so on-call gets only their region's pages.

See `docs/MULTI_REGION_HA.md` for the broader multi-region story.

## External services vs in-cluster blackbox

| Tool | When to use | Tradeoffs |
|---|---|---|
| **In-cluster blackbox-exporter (this chart)** | You already run Prometheus Operator and want a single pane of glass. Cheap, no external SaaS. | Probes only from where blackbox runs; if your cluster's egress is broken the probe is also broken. |
| **[Pingdom](https://www.pingdom.com/)** | You want truly external probes from many global PoPs and a hosted status page. Mature, simple. | Costs per check; metrics live in Pingdom, not Prometheus (use their exporter to bridge). |
| **[Datadog Synthetics](https://www.datadoghq.com/product/synthetic-monitoring/)** | You already pay for Datadog and want browser-based scripted checks (login flows, end-to-end agent calls). | Most expensive option; locked into Datadog's data model. |
| **[Better Uptime](https://betteruptime.com/)** | Small teams, want a hosted status page and simple HTTP/keyword checks with phone-call escalation. | Less depth than Datadog; fewer probe locations than Pingdom. |

A pragmatic combo: in-cluster blackbox-exporter for fast, free, high-cardinality
probes feeding Alertmanager, plus *one* external service (Pingdom or Better
Uptime) running a simple `/health/live` check from outside your cloud
provider. The external service catches the case where your cloud region (and
therefore your cluster *and* your in-cluster prober) goes dark together.
