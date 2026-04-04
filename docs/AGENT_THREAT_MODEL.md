# Agent platform threat model (sketch)

Companion to [AGENT_WORLD_CLASS_ROADMAP.md](./AGENT_WORLD_CLASS_ROADMAP.md). This document captures primary threats for **filesystem**, **browser**, and **code execution** capabilities and how mitigations map to implementation.

## Trust boundaries

- **Workspace** (tenant + owner storage user id) scopes settings, policies, and audit.
- **Tool host** enforces timeouts, allowlists, and per-workspace policy before side effects.
- **Deployment** may cap tools globally (`AGENT_TOOLS_ALLOWLIST`, category caps, `WORKSPACE_ROOT`).

## Filesystem tools

| Threat | Mitigation |
|--------|------------|
| Path traversal (`../`, UNC) | `lib/workspace-path-guard.js` — relative paths only, resolve under root |
| Symlink escape | Prefer disabling follow-symlinks in production; document OS-specific residual risk |
| Reading secrets (`.env`, keys) | Deny patterns (future); keep root narrow; `deniedTools` / read-only tiers |
| Large file / DoS | Max bytes per read; max matches per search |

## Browser automation (future phase)

| Threat | Mitigation |
|--------|------------|
| Drive-by credential harvest | Host allowlist + HITL for new domains |
| SSRF to internal services | Same allowlist; block RFC1918/metadata IPs in fetch layer |
| Prompt injection from page content | Separate control/tools from retrieved page text in prompts |

## Code execution (future phase)

| Threat | Mitigation |
|--------|------------|
| Sandbox escape | Containers / non-root / seccomp; minimal images |
| Network egress abuse | Default deny egress; explicit egress policy per workspace |
| Cryptomining / CPU abuse | CPU/time quotas; agent run budgets already exist |

## Browser tool (Phase 5 B5.1)

| Threat | Mitigation |
|--------|------------|
| SSRF / internal network | Same allowlist entries as knowledge/agent fetch; **re-check `page.url()` after redirects**. |
| Headless abuse | Opt-in `AGENT_BROWSER_TOOLS=1`; `network` category caps apply; timeouts + max extract size. |
| Drive-by in page | JS runs in browser context — treat as **trusted code execution** for the page; narrow allowlists. |

## Phase 4 tools (write, git, subprocess)

| Threat | Mitigation |
|--------|------------|
| Arbitrary shell | `workspace_run_command` uses **no shell**; only `WORKSPACE_COMMAND_ALLOWLIST` executables; argv only. |
| Destructive git | No `git push`, `reset --hard`, or `checkout` tools exposed; commit requires explicit paths. |
 | Overwrite data | `workspace_write_file` optional backup of prior file; size caps. |

## Policy denial observability

Workspace **denied tools** return `POLICY_TOOL_DENIED` with metric `siskelbot_agent_policy_denials_total{code=...}` when metrics enabled.

## Review cadence

Revisit when enabling `WORKSPACE_FILE_TOOLS`, browser tools, or remote code execution in production.

*Last updated: April 2026*
