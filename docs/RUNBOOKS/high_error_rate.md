# Runbook: High Error Rate

## Symptoms
- 5xx errors exceed 5% of total requests.
- User-facing chat completion failures.
- Error-rate alerts firing in Grafana / Prometheus.

## Severity
**high** — user-visible impact, SLO at risk.

## Investigation Steps
1. Confirm the server is reachable: `curl http://localhost:3000/health/ready`.
2. Inspect error-rate trend over the last hour via `/metrics` (filter on `http_requests_total{status=~"5.."}`).
3. Check circuit breaker state: `GET /api/v1/admin/routing/stats`.
4. Check backend health for Ollama, vLLM, or OpenAI (status pages / direct probe).
5. Correlate with recent deployments — if the error-rate rise lines up with a release, lean toward rollback.
6. Inspect the audit log for repeated failures from a single workspace or user; a runaway client can skew the error rate.

## Remediation
- Rollback the most recent deployment if the error-rate shift is correlated.
- If the backend is flapping, manually open the circuit breaker via the admin endpoint until it stabilises.
- Scale replicas horizontally if the increase is traffic-driven.
- Shed load via `chatRateLimiter` / per-key limits if the problem is abuse.

## Prevention
- Keep circuit-breaker thresholds conservative and tuned per backend.
- Enable canary deploys with automated rollback when the error-rate SLO is violated.
- Enforce per-API-key rate limits to protect downstream backends.
- Add synthetic health checks that exercise `/v1/chat/completions` from an external prober.
