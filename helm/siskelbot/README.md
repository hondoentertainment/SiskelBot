# SiskelBot Helm Chart

Helm chart for deploying [SiskelBot](https://github.com/hondoentertainment/SiskelBot), a realtime streaming assistant proxy for Ollama, vLLM, and OpenAI, on Kubernetes.

## TL;DR

```bash
helm install siskelbot ./helm/siskelbot
```

## Introduction

This chart bootstraps a SiskelBot deployment on a Kubernetes cluster using the Helm package manager. It installs:

- A `Deployment` running the SiskelBot server
- A `Service` exposing the HTTP port (default 3000)
- Optional `Ingress` with TLS support
- Optional `HorizontalPodAutoscaler` with CPU, memory, and custom metrics
- Optional `PodDisruptionBudget` for high availability
- Optional `ServiceMonitor` for Prometheus Operator scraping
- Optional `NetworkPolicy` for zero-trust networking
- Optional `PersistentVolumeClaim` for workspace data
- A `ServiceAccount`, `ConfigMap`, and `Secret` for configuration

## Prerequisites

- Kubernetes 1.23+
- Helm 3.8+
- A container image registry with the SiskelBot image
- (Optional) An ingress controller (nginx, traefik, etc.) for external access
- (Optional) cert-manager for automatic TLS certificates
- (Optional) Prometheus Operator for `ServiceMonitor` support
- (Optional) A PostgreSQL cluster for production storage
- (Optional) A Redis instance for caching and pub/sub

## Installing the chart

Install the chart with the release name `siskelbot`:

```bash
helm install siskelbot ./helm/siskelbot
```

Install with production values:

```bash
helm install siskelbot ./helm/siskelbot -f values.production.yaml
```

Install with inline overrides:

```bash
helm install siskelbot ./helm/siskelbot \
  --set replicaCount=3 \
  --set ingress.enabled=true \
  --set-string ingress.hosts[0].host=siskelbot.example.com
```

Install with secrets from a file:

```bash
helm install siskelbot ./helm/siskelbot \
  -f values.production.yaml \
  --set-string secrets.OPENAI_API_KEY=$OPENAI_API_KEY \
  --set-string secrets.API_KEY=$API_KEY \
  --set-string secrets.SESSION_SECRET=$SESSION_SECRET
```

## Upgrading the chart

```bash
helm upgrade siskelbot ./helm/siskelbot --set image.tag=1.0.1
```

Upgrade with new values:

```bash
helm upgrade siskelbot ./helm/siskelbot -f values.production.yaml
```

## Uninstalling the chart

```bash
helm uninstall siskelbot
```

Note: `PersistentVolumeClaim`s are retained by default. Delete them manually if required:

```bash
kubectl delete pvc -l app.kubernetes.io/instance=siskelbot
```

## Parameters

### Image parameters

| Name                | Description                            | Default                                      |
| ------------------- | -------------------------------------- | -------------------------------------------- |
| `image.repository`  | SiskelBot image repository             | `ghcr.io/hondoentertainment/siskelbot`       |
| `image.tag`         | Image tag (defaults to `appVersion`)   | `""`                                         |
| `image.pullPolicy`  | Image pull policy                      | `IfNotPresent`                               |
| `imagePullSecrets`  | Image pull secrets for private regs    | `[]`                                         |

### Deployment parameters

| Name                           | Description                    | Default |
| ------------------------------ | ------------------------------ | ------- |
| `replicaCount`                 | Number of SiskelBot replicas   | `2`     |
| `resources.requests.cpu`       | CPU request                    | `100m`  |
| `resources.requests.memory`    | Memory request                 | `256Mi` |
| `resources.limits.cpu`         | CPU limit                      | `1000m` |
| `resources.limits.memory`      | Memory limit                   | `1Gi`   |
| `terminationGracePeriodSeconds`| Pod termination grace period   | `30`    |

### Service and ingress parameters

| Name                  | Description                    | Default     |
| --------------------- | ------------------------------ | ----------- |
| `service.type`        | Kubernetes service type        | `ClusterIP` |
| `service.port`        | Service port                   | `3000`      |
| `ingress.enabled`     | Enable ingress                 | `false`     |
| `ingress.className`   | Ingress class name             | `nginx`     |
| `ingress.hosts`       | Ingress host configuration     | See values  |
| `ingress.tls`         | Ingress TLS configuration      | `[]`        |

### Autoscaling parameters

| Name                                            | Description              | Default |
| ----------------------------------------------- | ------------------------ | ------- |
| `autoscaling.enabled`                           | Enable HPA               | `false` |
| `autoscaling.minReplicas`                       | Minimum replicas         | `2`     |
| `autoscaling.maxReplicas`                       | Maximum replicas         | `10`    |
| `autoscaling.targetCPUUtilizationPercentage`    | CPU target utilization   | `80`    |
| `autoscaling.targetMemoryUtilizationPercentage` | Memory target util       | `80`    |
| `autoscaling.customMetrics`                     | Custom Prometheus metrics| `[]`    |

### High availability parameters

| Name                              | Description             | Default |
| --------------------------------- | ----------------------- | ------- |
| `podDisruptionBudget.enabled`     | Enable PDB              | `true`  |
| `podDisruptionBudget.minAvailable`| Minimum available pods  | `1`     |

### Persistence parameters

| Name                   | Description                      | Default         |
| ---------------------- | -------------------------------- | --------------- |
| `persistence.enabled`  | Enable persistent storage        | `false`         |
| `persistence.size`     | PVC size                         | `10Gi`          |
| `persistence.storageClass` | StorageClass name            | `""`            |
| `persistence.mountPath`| Mount path inside container      | `/data`         |

### Observability parameters

| Name                                | Description                     | Default |
| ----------------------------------- | ------------------------------- | ------- |
| `metrics.enabled`                   | Enable metrics endpoint         | `true`  |
| `metrics.path`                      | Metrics scrape path             | `/metrics` |
| `metrics.serviceMonitor.enabled`    | Create Prometheus ServiceMonitor| `false` |
| `metrics.serviceMonitor.interval`   | Scrape interval                 | `30s`   |

### Security parameters

| Name                    | Description              | Default |
| ----------------------- | ------------------------ | ------- |
| `networkPolicy.enabled` | Enable NetworkPolicy     | `false` |
| `podSecurityContext`    | Pod security context     | See values |
| `securityContext`       | Container security context | See values |
| `serviceAccount.create` | Create ServiceAccount    | `true`  |

## Health checks

SiskelBot exposes the following health endpoints used by the chart's probes:

- `GET /health/live` -- liveness probe (used as startup probe too)
- `GET /health/ready` -- readiness probe
- `GET /metrics` -- Prometheus metrics (when `ENABLE_METRICS=1`)

## Secrets

The chart supports three ways to supply secrets:

1. **Inline via `secrets` value** (creates a managed `Secret`):

   ```yaml
   secrets:
     OPENAI_API_KEY: sk-...
     SESSION_SECRET: ...
   ```

2. **External secrets via `envFrom.secretRefs`**:

   ```yaml
   envFrom:
     secretRefs:
       - name: siskelbot-secrets
   ```

3. **Individual env vars via `env`**:

   ```yaml
   env:
     - name: OPENAI_API_KEY
       valueFrom:
         secretKeyRef:
           name: my-secrets
           key: openai-api-key
   ```

## Production checklist

Before deploying to production:

- [ ] Set `image.tag` to a pinned version (avoid `latest`)
- [ ] Enable `autoscaling` and set appropriate min/max replicas
- [ ] Enable `podDisruptionBudget` with `minAvailable: 2` or higher
- [ ] Enable `persistence` or use PostgreSQL (`STORAGE_BACKEND=postgres`)
- [ ] Configure `ingress` with TLS certificates
- [ ] Enable `networkPolicy` to restrict traffic
- [ ] Enable `metrics.serviceMonitor` for Prometheus scraping
- [ ] Provide secrets (`OPENAI_API_KEY`, `API_KEY`, `ADMIN_API_KEY`, `SESSION_SECRET`)
- [ ] Set resource `requests` and `limits` based on load testing
- [ ] Configure `topologySpreadConstraints` for zone HA
- [ ] Configure `affinity` (pod anti-affinity for host spread)
- [ ] Set `priorityClassName` appropriately

## Troubleshooting

Tail the logs:

```bash
kubectl logs -l app.kubernetes.io/name=siskelbot -f
```

Describe a failing pod:

```bash
kubectl describe pod -l app.kubernetes.io/name=siskelbot
```

Port-forward for local testing:

```bash
kubectl port-forward svc/siskelbot 3000:3000
```

Verify probes:

```bash
kubectl exec -it deploy/siskelbot -- wget -qO- localhost:3000/health/ready
```

## Links

- [SiskelBot on GitHub](https://github.com/hondoentertainment/SiskelBot)
- [Deployment Guide](../../docs/DEPLOYMENT.md)
- [Docker Guide](../../docs/DOCKER.md)
- [Runbook](../../docs/RUNBOOK.md)
- [Multi-Region HA](../../docs/MULTI_REGION_HA.md)
