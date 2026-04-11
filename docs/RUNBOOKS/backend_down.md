# Runbook: Backend Down

## Symptoms
- All chat completions failing.
- `/health/ready` returns not ready with a backend-specific reason.
- The circuit breaker is open and not recovering.

## Severity
**critical** — core product functionality is offline.

## Investigation Steps
1. Probe the backend directly: `curl $OLLAMA_URL/api/tags` (or the vLLM / OpenAI equivalent).
2. Check the backend process/container status on its host.
3. Verify network connectivity from the SiskelBot host to the backend host.
4. Tail backend logs for crash, OOM, or GPU-driver errors.
5. If the backend is OpenAI, check https://status.openai.com.
6. Check whether a recent config change (`BACKEND`, `OLLAMA_URL`, `VLLM_URL`) points at a wrong endpoint.

## Remediation
- Restart the backend process or container.
- Failover to a healthy region via the region-health router if multi-region is configured.
- Switch `BACKEND` to a healthy provider (e.g. Ollama → OpenAI) and restart the app.
- Close the circuit breaker manually once the backend is verified healthy.

## Prevention
- Run multiple backend replicas behind a load balancer.
- Configure multi-region failover with automatic health-based routing.
- Monitor backend liveness with short-interval probes and alert on sustained failure.
- Keep a fallback provider configured and tested in staging.
