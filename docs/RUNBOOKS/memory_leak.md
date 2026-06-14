# Runbook: Memory Leak

## Symptoms
- Process RSS growing unbounded over hours or days.
- Recurring OOM kills from the container runtime.
- GC pause durations increasing.

## Severity
**high** — eventually causes instance restarts and dropped requests.

## Investigation Steps
1. Chart `process_resident_memory_bytes` over time in Grafana; note whether growth is linear or sawtooth.
2. Capture a heap snapshot with the Node inspector: `node --inspect=0.0.0.0:9229 server.js` and attach Chrome DevTools.
3. Correlate growth with a specific deployed version or workload (e.g. streaming-heavy traffic).
4. Check for unbounded in-process caches or leaked event listeners.
5. Restart affected instances to restore capacity while investigating.

## Remediation
- Rolling restart of affected replicas to reclaim memory.
- Roll back to the last known-good version if a regression is suspected.
- Set `--max-old-space-size` to a conservative value aligned with the container limit.
- Disable suspect caches or plugins via config flags while hunting the root cause.

## Prevention
- Run periodic heap-growth regression tests in CI (`npm run test:load`).
- Alert on RSS growth trend across restart cycles, not just absolute values.
- Use `WeakRef` or bounded LRU caches for anything keyed on user input.
- Require code review sign-off on new in-process caches.
