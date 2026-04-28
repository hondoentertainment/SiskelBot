# Kubernetes Deployment

Helm chart: `helm/siskelbot/` — chart version `1.0.0`, app version `1.0.0`.

## Prerequisites

- Kubernetes 1.26+
- Helm 3.12+
- [cert-manager](https://cert-manager.io/) for automatic TLS certificates
- [NGINX Ingress Controller](https://kubernetes.github.io/ingress-nginx/)
- (Optional) [external-secrets-operator](https://external-secrets.io/) for secret management via AWS/GCP/Vault
- (Optional) [Prometheus Operator](https://prometheus-operator.dev/) for `ServiceMonitor` and alerting
- (Optional) External uptime probes — see [docs/SYNTHETIC_MONITORING.md](./SYNTHETIC_MONITORING.md)

## Quick install

```bash
# Create namespace
kubectl create namespace siskelbot

# If the image is on GHCR and your cluster needs pull credentials
kubectl create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io \
  --docker-username=<github-user> \
  --docker-password=<ghcr-token> \
  --namespace siskelbot

# Create the secrets Secret (simplest path — no external-secrets-operator needed)
kubectl create secret generic siskelbot-secrets \
  --from-literal=OPENAI_API_KEY=sk-... \
  --from-literal=SESSION_SECRET=$(openssl rand -hex 32) \
  --from-literal=API_KEY=$(openssl rand -hex 32) \
  --from-literal=ADMIN_API_KEY=$(openssl rand -hex 32) \
  --from-literal=DATABASE_URL=postgres://siskelbot:pass@host/db \
  --namespace siskelbot

# Install with production values
helm install siskelbot ./helm/siskelbot \
  -f helm/siskelbot/values.production.yaml \
  --set image.tag=1.0.0 \
  --set ingress.hosts[0].host=siskelbot.yourdomain.com \
  --set ingress.tls[0].secretName=siskelbot-tls \
  --set 'ingress.tls[0].hosts[0]=siskelbot.yourdomain.com' \
  --namespace siskelbot
```

## Production values

`values.production.yaml` sets sensible production defaults:

| Setting | Value |
|---|---|
| `replicaCount` | 3 |
| `autoscaling` | enabled, 3–20 replicas, 70% CPU / 75% memory |
| `podDisruptionBudget.minAvailable` | 2 |
| `topologySpreadConstraints` | zone + host spread |
| `resources.requests` | 500m CPU / 512Mi memory |
| `resources.limits` | 2000m CPU / 2Gi memory |
| `persistence` | 50Gi on `gp3` StorageClass |
| `networkPolicy` | enabled |
| `metrics.serviceMonitor` | enabled |
| `terminationGracePeriodSeconds` | 60 |

To override specific values on upgrade:

```bash
helm upgrade siskelbot ./helm/siskelbot \
  -f helm/siskelbot/values.production.yaml \
  --set image.tag=1.2.0 \
  --reuse-values \
  --namespace siskelbot
```

## Database migrations

Migrations run automatically as a `pre-install,pre-upgrade` Helm hook before pods start — no manual step is needed.

Check whether the migration job ran and succeeded:

```bash
kubectl get jobs -n siskelbot
kubectl logs job/siskelbot-migration -n siskelbot
```

To manage migrations externally (e.g. via a CI step) and skip the hook:

```bash
helm install siskelbot ./helm/siskelbot \
  -f helm/siskelbot/values.production.yaml \
  --set migrations.enabled=false \
  --namespace siskelbot
```

## Secrets via external-secrets-operator

When `externalSecrets.enabled=true` the chart creates an `ExternalSecret` resource that pulls values from your secret store and materializes them as a Kubernetes `Secret`. Leave the `secrets: {}` map empty in this case.

AWS Secrets Manager example:

```bash
# 1. Create your ClusterSecretStore pointing at AWS Secrets Manager (one-time setup).
#    See https://external-secrets.io/latest/provider/aws-secrets-manager/

# 2. Install with external secrets enabled
helm install siskelbot ./helm/siskelbot \
  -f helm/siskelbot/values.production.yaml \
  --set externalSecrets.enabled=true \
  --set externalSecrets.secretStoreRef.name=aws-secrets-manager \
  --set 'externalSecrets.secrets[0].secretKey=OPENAI_API_KEY' \
  --set 'externalSecrets.secrets[0].remoteRef.key=siskelbot/production' \
  --set 'externalSecrets.secrets[0].remoteRef.property=openai_api_key' \
  --namespace siskelbot --create-namespace
```

All keys in the remote secret are synced into the generated Kubernetes Secret and injected via `envFrom`. The `envFrom.secretRefs` entry in `values.production.yaml` points to this generated Secret by default.

## Verifying the deployment

```bash
kubectl rollout status deployment/siskelbot -n siskelbot
kubectl get pods -n siskelbot
curl https://siskelbot.yourdomain.com/health/live
curl https://siskelbot.yourdomain.com/health/ready
```

Tail logs across all replicas:

```bash
kubectl logs -l app.kubernetes.io/name=siskelbot -n siskelbot -f
```

Port-forward for local testing without ingress:

```bash
kubectl port-forward svc/siskelbot 3000:3000 -n siskelbot
```

## Upgrading

```bash
helm upgrade siskelbot ./helm/siskelbot \
  -f helm/siskelbot/values.production.yaml \
  --set image.tag=<new-tag> \
  --namespace siskelbot
```

The deployment uses `RollingUpdate` with `maxUnavailable: 0` — zero-downtime by default. The PDB (`minAvailable: 2`) ensures at least two pods remain healthy during a rollout.

## Rollback

```bash
helm history siskelbot -n siskelbot
helm rollback siskelbot <revision> -n siskelbot
```

## Uninstall

```bash
helm uninstall siskelbot -n siskelbot
# PVCs are not deleted automatically. Remove them manually if needed:
kubectl delete pvc -l app.kubernetes.io/name=siskelbot -n siskelbot
```

## Key values reference

| Value | Default | Production default | Description |
|---|---|---|---|
| `replicaCount` | `2` | `3` | Number of pod replicas |
| `image.tag` | `""` (uses appVersion) | `"1.0.0"` | Image tag to deploy; always pin in production |
| `ingress.enabled` | `false` | `true` | Enable Ingress resource |
| `ingress.hosts` | `siskelbot.example.com` | — | Hostname(s) for the Ingress |
| `persistence.enabled` | `false` | `true` | Mount a PVC at `/data` for workspace storage |
| `persistence.size` | `10Gi` | `50Gi` | PVC capacity |
| `externalSecrets.enabled` | `false` | `false` | Create an ExternalSecret instead of a static Secret |
| `migrations.enabled` | `true` | `true` | Run the migration Job as a pre-install/pre-upgrade hook |
| `autoscaling.enabled` | `false` | `true` | Enable HorizontalPodAutoscaler |
| `autoscaling.minReplicas` | `2` | `3` | HPA minimum replica count |
| `autoscaling.maxReplicas` | `10` | `20` | HPA maximum replica count |
| `metrics.serviceMonitor.enabled` | `false` | `true` | Create a Prometheus Operator ServiceMonitor |
