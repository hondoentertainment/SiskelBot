# Runbook: Agent Loop Runaway

**Time to resolve:** 5–15 minutes

## Symptoms
- Agent loop timeout alert firing (`AGENT_MAX_WALL_MS` exceeded).
- Unusually high token usage on the LLM backend.
- User reports a request has been running for minutes with no response.
- `[agent-stagnation]` warnings in logs indicating repeated identical tool calls.
- High CPU or memory on the SiskelBot pod from a long-running SSE connection.

## Severity
**high** — affected user is fully blocked; uncontrolled loops waste token budget and can cascade into backend rate limits.

## Immediate mitigation

Cancel the specific run by session ID (visible in logs as `sessionId` or `run-id`):

```bash
# Via CLI
siskelbot agent cancel <run-id>

# Via API
curl -X POST https://siskelbot.example.com/api/v1/agent/runs/<run-id>/cancel \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

If the session ID is not known, find it in logs:

```bash
kubectl logs -n siskelbot -l app=siskelbot --tail=500 | grep "agent-loop\|sessionId"
```

## Pause all new agent runs

If the issue is systemic (multiple runaway loops, or a bad model deployment):

```bash
kubectl set env deployment/siskelbot AGENT_ENABLED=false -n siskelbot
```

Verify the change propagated and in-flight runs have drained before declaring the system stable.

## Root cause investigation

1. Check stagnation logs for the affected session:
   ```bash
   kubectl logs -n siskelbot -l app=siskelbot | grep "agent-stagnation\|<run-id>"
   ```
   `lib/agent-stagnation.js` emits a warning when tool calls repeat without progress and terminates the loop when the threshold is reached. If this did not fire, the stagnation detector may be disabled or the loop was not repeating — it may instead be a single very slow tool call.

2. Review the run trajectory for the full tool-call sequence:
   ```bash
   curl https://siskelbot.example.com/api/v1/agent/runs/<run-id>/trajectory \
     -H "Authorization: Bearer $ADMIN_API_KEY"
   ```

3. Check per-tool timing in the trajectory to identify which tool is blocking.

4. If the run exhausted iterations without completing, check whether `MAX_AGENT_ITERATIONS` is set high enough (or too high) for the workload.

## Resolution

Re-enable the agent system once the underlying cause is fixed:

```bash
kubectl set env deployment/siskelbot AGENT_ENABLED=true -n siskelbot
```

Confirm no other runaway sessions remain:

```bash
curl https://siskelbot.example.com/api/v1/agent/runs \
  -H "Authorization: Bearer $ADMIN_API_KEY" | jq '.[] | select(.status == "running")'
```

## Tuning

Relevant env vars (set in `.env.example` / Helm values):

| Var | Default | Purpose |
|---|---|---|
| `MAX_AGENT_ITERATIONS` | 5 | Max tool-call loop iterations per run |
| `MAX_AGENT_TOOL_CALLS` | 30 | Hard cap on total tool executions (0 = unlimited) |
| `AGENT_MAX_WALL_MS` | 120000 | Wall-clock budget per agent run in ms (0 = unlimited) |
| `AGENT_TOOL_TIMEOUT_MS` | — | Per-tool execution timeout |
| `AGENT_STAGNATION_STOP` | 1 | Terminate on repeated tool calls (default on) |
| `AGENT_MAX_CONCURRENT_RUNS_PER_WORKSPACE` | 0 | Cap concurrent runs per workspace (0 = unlimited) |

Lower `MAX_AGENT_ITERATIONS` and set `AGENT_MAX_WALL_MS` conservatively in production. Enable `AGENT_STAGNATION_STOP=1` if not already set.
