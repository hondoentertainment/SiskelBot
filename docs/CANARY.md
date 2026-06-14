# Canary Deployments (Argo Rollouts)

The Helm chart can replace the standard `Deployment` with an Argo Rollouts
`Rollout` that performs a progressive, SLO-gated traffic shift instead of a
plain rolling update. This document covers how to enable, operate, and tune it.

## Prerequisites

- A Kubernetes cluster with the [Argo Rollouts controller](https://argoproj.github.io/argo-rollouts/installation/)
  installed (the controller reconciles `Rollout` and `AnalysisTemplate`
  resources). Typical install:

  ```bash
  kubectl create namespace argo-rollouts
  kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml
  ```

- The optional [`kubectl argo rollouts` plugin](https://argoproj.github.io/argo-rollouts/installation/#kubectl-plugin-installation)
  for inspecting and controlling rollouts from the CLI.
- A Prometheus instance reachable from the cluster that scrapes SiskelBot
  metrics (the chart's existing `ServiceMonitor` is enough). The default
  address is `http://prometheus.monitoring.svc.cluster.local:9090`; override
  via `canary.analysis.prometheusAddress`.
- The chart's `metrics.alerting.enabled=true` so the SLO recording rules in
  `templates/prometheusrule.yaml` are applied alongside the analysis.

## Enabling

Canary mode is mutually exclusive with the standard `Deployment` — when
`canary.enabled=true` the chart renders a `Rollout`, two `Service` resources
(`<release>-canary` and `<release>-stable`), and an `AnalysisTemplate`, and
omits the `Deployment`.

```bash
helm upgrade --install siskelbot ./helm/siskelbot \
  -f helm/siskelbot/values.production.yaml \
  --set canary.enabled=true \
  --namespace siskelbot
```

The production values file already sets `canary.enabled=true`, so installing
with `-f values.production.yaml` is sufficient.

## Watching a rollout

```bash
kubectl argo rollouts get rollout siskelbot --watch -n siskelbot
```

This shows the current step, traffic weight, paused/healthy state, and any
running `AnalysisRun` results.

To list the analysis runs and inspect their metric results:

```bash
kubectl get analysisrun -n siskelbot
kubectl describe analysisrun <name> -n siskelbot
```

## Manual promotion

Each `pause` step waits indefinitely (or for the configured `duration`).
You can manually promote past a paused step at any time:

```bash
kubectl argo rollouts promote siskelbot -n siskelbot
```

Use `--full` to skip all remaining analysis and pause steps and finish the
rollout immediately:

```bash
kubectl argo rollouts promote siskelbot --full -n siskelbot
```

## Rollback during a rollout

Aborting halts the rollout at the current step and shifts all traffic back to
the stable `ReplicaSet`:

```bash
kubectl argo rollouts abort siskelbot -n siskelbot
```

To revert to the previous stable revision after aborting (or after a failed
analysis), use `undo`:

```bash
kubectl argo rollouts abort siskelbot -n siskelbot
kubectl argo rollouts undo siskelbot -n siskelbot
```

`undo` accepts `--to-revision=<n>` to roll back to a specific historical
revision (`kubectl argo rollouts history siskelbot` lists them).

## Tuning steps and analysis thresholds

Adjust `canary.steps` and `canary.analysis.*` in your values file.

- **Conservative (high-risk releases).** Smaller weight increments and longer
  pauses give the analysis more samples and let on-call eyeball the metrics
  between steps. Drop `maxErrorRate` (e.g. `0.002`) and `maxP99Seconds` to
  fail fast on regressions.

  ```yaml
  canary:
    steps:
      - setWeight: 1
      - pause: { duration: 30m }
      - setWeight: 10
      - pause: { duration: 30m }
      - setWeight: 50
      - pause: { duration: 30m }
      - setWeight: 100
    analysis:
      interval: 30s
      failureLimit: 1
      maxErrorRate: 0.002
      maxP99Seconds: 10
  ```

- **Aggressive (low-risk releases).** Fewer steps and shorter pauses for
  bug-fix or config-only rollouts. Widen the failure tolerances to avoid
  spurious aborts on noisy metrics.

  ```yaml
  canary:
    steps:
      - setWeight: 25
      - pause: { duration: 2m }
      - setWeight: 75
      - pause: { duration: 2m }
      - setWeight: 100
    analysis:
      interval: 1m
      failureLimit: 5
      maxErrorRate: 0.02
      maxP99Seconds: 20
  ```

- **`canary.analysis.startingStep`** controls which step the analysis begins
  on. Default is `1` (analysis runs from the very first weight change). Set
  higher to skip analysis for the smallest initial weight.
- **`canary.trafficRouting`** is left empty by default, which gives a
  replica-count-based traffic split. Configure it to integrate with NGINX
  Ingress, Istio, or another supported provider — see the
  [Argo Rollouts traffic routing docs](https://argoproj.github.io/argo-rollouts/features/traffic-management/).

## Troubleshooting

- **Analysis is failing immediately.** Check the `AnalysisRun` for the actual
  metric values and the rendered Prometheus query:

  ```bash
  kubectl get analysisrun -n siskelbot
  kubectl describe analysisrun <name> -n siskelbot
  ```

  Copy the query from the `metric` block and run it directly against
  Prometheus to confirm it returns data. The most common causes are:

  - Wrong `prometheusAddress` (Argo Rollouts cannot reach Prometheus).
  - Service label not matching — the analysis filters on
    `service="<release>-canary"`. Verify the canary `Service` exists and is
    being scraped by the `ServiceMonitor`.
  - Empty result set early in the rollout because the canary has no traffic
    yet. Increase `canary.analysis.startingStep` so analysis only runs once
    real traffic is shifted.

- **Rollout stuck on a `pause` step.** Pauses with no `duration` wait
  forever; promote manually with `kubectl argo rollouts promote siskelbot`.

- **Old `Deployment` still present after enabling canary.** The chart only
  omits the `Deployment` when `canary.enabled=true` is rendered. If you
  enabled it but the `Deployment` is still in the cluster, run
  `helm upgrade` again or delete the legacy `Deployment` manually:

  ```bash
  kubectl delete deployment siskelbot -n siskelbot
  ```

- **HPA conflicts.** When `autoscaling.enabled=true` the chart already omits
  the `replicas` field from the `Rollout`, so the HPA owns scaling. The HPA's
  `scaleTargetRef` must point at the `Rollout` (`apiVersion: argoproj.io/v1alpha1`,
  `kind: Rollout`); update `templates/hpa.yaml` if you have customized it.

## Related

- `helm/siskelbot/templates/rollout.yaml` — the `Rollout` resource.
- `helm/siskelbot/templates/canary-services.yaml` — canary/stable `Service`s.
- `helm/siskelbot/templates/analysistemplate.yaml` — SLO analysis metrics.
- `helm/siskelbot/templates/prometheusrule.yaml` — recording rules and SLO alerts.
