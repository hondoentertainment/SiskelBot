# Horizontal Scaling Guide

This document covers how to scale SiskelBot from a single instance to a multi-instance production deployment.

## Single Instance (Default)

Out of the box, SiskelBot runs as a single process with:

- **Storage:** JSON files in `data/` directory (`STORAGE_PATH=./data`)
- **Queues:** In-memory job queue (`lib/job-queue.js`) with priority, concurrency control, and retry
- **Sessions:** In-memory Express sessions
- **WebSocket:** Single-process pub/sub for realtime presence
- **Search:** In-memory inverted index
- **Cache:** In-memory LRU cache

This configuration requires zero external dependencies and is suitable for development, small teams, and low-traffic deployments.

```bash
npm start
```

## Multi-Instance Deployment

For high availability and horizontal scaling, switch to external backing services.

### Required Infrastructure

| Service | Purpose | Min Version |
|---------|---------|-------------|
| PostgreSQL | Persistent storage, leader election | 14+ |
| Redis | Sessions, caching, pub/sub, job queue | 6.2+ |

### Storage: PostgreSQL

Switch from JSON files to PostgreSQL for durable, concurrent-safe storage.

```bash
export STORAGE_BACKEND=postgres
export DATABASE_URL=postgresql://user:pass@db-host:5432/siskelbot
```

Run migrations on first deploy:

```bash
node bin/siskelbot.js migrate
```

### Sessions: Redis

Store sessions in Redis so any instance can serve any user.

```bash
export REDIS_URL=redis://redis-host:6379
export SESSION_SECRET=<strong-random-secret>
```

### WebSocket: Redis Pub/Sub

Realtime presence and notifications are already wired to use Redis pub/sub when `REDIS_URL` is set. Messages published on one instance are received by all instances, so WebSocket clients connected to different instances stay in sync.

### Queues: Job Queue

The in-memory job queue (`lib/job-queue.js`) provides concurrency control, priority scheduling, retry with exponential backoff, and dead-letter support. In a multi-instance setup, each instance runs its own queue. For distributed job coordination, use Redis-backed queues (set `REDIS_URL`).

Pre-configured queues:

| Queue | Concurrency | Timeout | Use Case |
|-------|------------|---------|----------|
| `toolQueue` | 5 | 30s | Agent tool execution |
| `webhookQueue` | 3 | 10s | Webhook delivery |
| `indexQueue` | 2 | 60s | Search index updates |

### Leader Election

Leader election (`lib/leader-election.js`) ensures only one instance runs scheduled jobs (cron, cleanup, analytics aggregation). When using PostgreSQL, the leader lock is stored in the database. No additional configuration is needed beyond `STORAGE_BACKEND=postgres`.

```bash
export LEADER_TTL_MS=30000  # Lock TTL (default 30s)
```

## Kubernetes Deployment

### Deployment Manifest

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: siskelbot
  labels:
    app: siskelbot
spec:
  replicas: 3
  selector:
    matchLabels:
      app: siskelbot
  template:
    metadata:
      labels:
        app: siskelbot
    spec:
      containers:
        - name: siskelbot
          image: your-registry/siskelbot:latest
          ports:
            - containerPort: 3000
              name: http
          env:
            - name: STORAGE_BACKEND
              value: "postgres"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: siskelbot-secrets
                  key: database-url
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: siskelbot-secrets
                  key: redis-url
            - name: SESSION_SECRET
              valueFrom:
                secretKeyRef:
                  name: siskelbot-secrets
                  key: session-secret
            - name: API_KEY
              valueFrom:
                secretKeyRef:
                  name: siskelbot-secrets
                  key: api-key
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "1000m"
              memory: "1Gi"
          livenessProbe:
            httpGet:
              path: /health/live
              port: http
            initialDelaySeconds: 10
            periodSeconds: 15
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /health/ready
              port: http
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 2
          startupProbe:
            httpGet:
              path: /health/live
              port: http
            initialDelaySeconds: 3
            periodSeconds: 5
            failureThreshold: 10
```

### Horizontal Pod Autoscaler (HPA)

Scale based on CPU utilization and custom Prometheus metrics:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: siskelbot-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: siskelbot
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
    - type: Pods
      pods:
        metric:
          name: siskelbot_http_requests_per_second
        target:
          type: AverageValue
          averageValue: "100"
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Pods
          value: 2
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

### Resource Recommendations

| Workload | CPU Request | CPU Limit | Memory Request | Memory Limit | Replicas |
|----------|------------|-----------|----------------|--------------|----------|
| Development | 100m | 500m | 128Mi | 512Mi | 1 |
| Small team (< 20 users) | 250m | 1000m | 256Mi | 1Gi | 2 |
| Medium (20-100 users) | 500m | 2000m | 512Mi | 2Gi | 3-5 |
| Large (100+ users) | 1000m | 4000m | 1Gi | 4Gi | 5-10 |

## Load Balancing

### API Requests

Use standard round-robin or least-connections load balancing for REST API endpoints. All instances are stateless when backed by PostgreSQL and Redis.

### WebSocket Connections

WebSocket connections require sticky sessions (session affinity) so that upgrade handshakes and subsequent frames go to the same instance.

**Nginx example:**

```nginx
upstream siskelbot {
    ip_hash;  # Sticky sessions for WebSocket
    server siskelbot-1:3000;
    server siskelbot-2:3000;
    server siskelbot-3:3000;
}

server {
    listen 80;

    location / {
        proxy_pass http://siskelbot;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

**Kubernetes Ingress (nginx-ingress):**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: siskelbot
  annotations:
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/session-cookie-name: "siskelbot-affinity"
    nginx.ingress.kubernetes.io/session-cookie-max-age: "3600"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "86400"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "86400"
    nginx.ingress.kubernetes.io/websocket-services: "siskelbot"
spec:
  rules:
    - host: siskelbot.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: siskelbot
                port:
                  number: 3000
```

## Database

### Connection Pool Sizing

The connection pool tuner (`lib/connection-pool-tuner.js`) automatically adjusts pool size based on utilization. Configure bounds with environment variables:

```bash
export PG_POOL_MAX=50          # Absolute maximum connections (default 50)
export PG_POOL_MIN=2           # Minimum connections kept open (default 2)
export POOL_TUNE_INTERVAL_MS=60000  # Auto-tune check interval (default 60s)
```

**Sizing guidelines:**

- Each instance maintains its own pool
- Total connections across all instances should not exceed PostgreSQL `max_connections`
- Formula: `PG_POOL_MAX = (pg_max_connections - 10) / num_instances`
- Example: 100 max_connections, 3 instances -> PG_POOL_MAX=30

### Read Replicas

For analytics-heavy workloads, route read queries to replicas:

```bash
export DATABASE_URL=postgresql://user:pass@primary:5432/siskelbot
export DATABASE_READ_URL=postgresql://user:pass@replica:5432/siskelbot
```

Analytics endpoints (`/api/v1/analytics/*`) and search queries will use the read replica when available, reducing load on the primary.

## Monitoring

Enable Prometheus metrics for scaling decisions:

```bash
export ENABLE_METRICS=1
```

Key metrics for scaling:

| Metric | Scale Signal |
|--------|-------------|
| `siskelbot_http_request_duration_seconds` | High p99 latency -> scale up |
| `siskelbot_db_pool_waiting` | Clients waiting -> increase pool or replicas |
| `siskelbot_db_pool_active` | Near max -> increase pool |
| `siskelbot_circuit_breaker_open` | Backend overloaded -> check backend scaling |
| `siskelbot_queue_pending` | Growing backlog -> scale workers |

Import the Grafana dashboard from `grafana/` for pre-built scaling panels.

## Asset Caching

Use the asset fingerprinting system (`lib/asset-fingerprint.js`) for CDN cache busting:

1. Build fingerprinted assets: `npm run build:client`
2. The build generates `client/dist/manifest.json` with content hashes
3. The `assetMiddleware()` sets `Cache-Control: public, max-age=31536000, immutable` for versioned assets
4. CDN/reverse proxy can cache these indefinitely

## Checklist

Before going multi-instance, verify:

- [ ] `STORAGE_BACKEND=postgres` and `DATABASE_URL` configured
- [ ] `REDIS_URL` configured for sessions, caching, and pub/sub
- [ ] `SESSION_SECRET` set to a strong random value (same across all instances)
- [ ] `API_KEY` set (same across all instances)
- [ ] Database migrations run (`node bin/siskelbot.js migrate`)
- [ ] Health endpoints responding (`/health/live`, `/health/ready`)
- [ ] WebSocket sticky sessions configured in load balancer
- [ ] Connection pool sizing reviewed (`PG_POOL_MAX`)
- [ ] Prometheus metrics enabled (`ENABLE_METRICS=1`)
- [ ] Grafana dashboards imported
