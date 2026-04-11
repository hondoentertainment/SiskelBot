# Runbook: Quota Exhausted

## Symptoms
- 429 responses from `/v1/chat/completions`.
- Workspaces reporting "quota exceeded" errors in the UI.
- Usage dashboard shows one or more workspaces at 100% of their allocation.

## Severity
**medium** — blocks affected users but does not threaten the platform overall.

## Investigation Steps
1. Identify the affected workspaces: `GET /api/v1/usage?workspace=...`.
2. Inspect the workspace's quota configuration via the admin endpoint.
3. Confirm the user is running against the workspace they believe they are using (not a shared/default workspace).
4. Look for runaway agent loops by listing active agent sessions and trajectory logs.
5. Check if a recent workflow or schedule inflated usage.

## Remediation
- Raise the quota limit temporarily for legitimate growth (document and ticket the increase).
- Cancel runaway agent sessions via the agent-session admin endpoint.
- Apply stricter per-user rate limits inside the workspace to prevent one user from consuming the whole quota.

## Prevention
- Alert at 80% quota consumption rather than 100% so operators have time to react.
- Cap agent-loop iterations and require human-in-the-loop approval for high-cost tools.
- Surface usage-trend charts in the workspace dashboard to help customers self-manage.
