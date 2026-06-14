# Runbook: Latency Spike

## Symptoms
- p95 latency is at or above 2x baseline.
- Streaming responses stall; clients time out mid-stream.
- Latency SLO alerts firing.

## Severity
**medium** — degraded experience, can escalate to **high** if sustained.

## Investigation Steps
1. Pull `http_request_duration_seconds` from `/metrics` and inspect p50/p95/p99 histograms.
2. Check backend inference latency (Ollama/vLLM token generation time).
3. Check CPU, memory, and event-loop utilisation on the Node process.
4. Check for ongoing scheduled jobs or batch workflows consuming resources.
5. Replay recent chat-completion trace spans via the Trace Explorer to find slow segments.
6. Check database pool health: `GET /api/v1/admin/pool-health`.

## Remediation
- Pause non-critical scheduled jobs via the scheduler until latency recovers.
- Route traffic away from the slowest backend via the smart router.
- Shed load by temporarily lowering rate limits for low-priority workspaces.
- Restart a Node replica if event-loop starvation is suspected.

## Prevention
- Enforce per-request timeouts via `REQUEST_TIMEOUT_MS`.
- Autoscale workers on latency targets, not just CPU.
- Stagger scheduled job windows so heavy jobs don't overlap peak traffic.
- Keep trace sampling high enough to diagnose intermittent slowdowns.
