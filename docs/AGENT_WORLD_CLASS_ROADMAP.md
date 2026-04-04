# World-class agent roadmap (OpenClaw-class bar)

**Purpose:** Ordered program to evolve SiskelBot’s agent layer from strong production orchestration into a **broad-capability agent platform**: environment access, durable sessions, rich connectors, interoperability (MCP), and enterprise-grade safety.

**Companion docs:** Product scope and shipped phases live in [PRD.md](./PRD.md). Desktop phases (97–116 there) can run **in parallel** with this roadmap; they improve reach (local-first, drag-drop) but are not substitutes for tool breadth or session runtime.

**North star:** A user can attach a workspace (or repo), describe a multi-step goal, and the system **plans, acts with tools, recovers from errors, and finishes** with citations and audit — optionally across **chat, API, and messaging channels** — without sacrificing tenancy, quotas, or policy.

---

## 1. Guiding principles

1. **Safety before scale:** Every new tool ships with policy, audit, and opt-in defaults.
2. **Workspace is the trust boundary:** Tools, secrets, and data paths resolve inside tenant scope.
3. **Interop beats one-off integrations:** Prefer MCP and OpenAPI-shaped connectors over bespoke code per vendor where possible.
4. **Observable by default:** Each session and tool call is traceable (existing trajectory/eval foundation).
5. **Progressive autonomy:** Read-only → propose → execute with approval → full auto per workspace.

---

## 2. Current foundation (do not regress)

These capabilities are already in place and are the **base layer** for everything below:

- Agent loop, parallel tools, budgets, stagnation stop, HITL, hooks, tool allowlists.
- Swarm, routing v2, configurable specialists, streaming synthesizer.
- Knowledge / RAG v2, semantic search, `fetch_allowed_url`, citations/grounding.
- Recipes, `execute_step`, schedules, webhooks, GitHub/Vercel toolchain.
- Workspaces, teams, RBAC, quotas, durable storage (JSON/SQLite/Postgres paths).
- Eval harness (golden traces, judge, live agent cases), durable trajectories.
- Plugins + sandbox direction (`plugin-sandbox.js`).

**Program assumption:** Roadmap work **extends** `lib/agent-tools.js`, session/trajectory storage, and policy — it does not replace the existing architecture.

---

## 3. Workstreams (run in parallel after Phase 0)

| Track | Objective |
|-------|-----------|
| **A. Session runtime** | Long-lived runs, checkpoints, resume, cancellation, concurrency caps per workspace. |
| **B. Environment tools** | Filesystem, git, sandboxed code, browser, structured shell — all policy-gated. |
| **C. Intelligence** | Stronger planning, reflection, error recovery, specialist selection grounded in telemetry. |
| **D. Connectors** | Messaging and productivity surfaces; OAuth/token vault pattern; rate limits. |
| **E. Interop** | MCP client (consume servers); optional MCP server (export Siskel tools). |
| **F. Safety & compliance** | ABAC, secret handling, injection-resistant prompts, enterprise retention. |
| **G. Product & DX** | CLI, templates, onboarding, operator docs for sandbox providers. |

---

## 4. Phased roadmap (ordered)

Each phase lists **exit criteria** (what “done” means) and **depends on** prior phases.

### Phase 0 — Program setup (1–2 weeks)

**Deliverables**

- Naming and ownership for tracks A–G; one DRI per track.
- Threat model sketch for **filesystem**, **browser**, and **code execution** tools.
- Test strategy: extend eval harness with **negative tests** (policy denial, path escape).
- KPI baseline: tool success rate, truncation rate (`X-Agent-Truncated`), mean steps per successful run.

**Exit criteria**

- Documented RACI + KPI dashboard fields (even if manual at first).
- CI still green; no user-facing change required.

---

### Phase 1 — Session runtime v1 (4–8 weeks)

**Goal:** First-class **agent sessions** distinct from a single HTTP request.

**Deliverables**

- Session entity: id, workspace, user, created/updated, status (`running`, `paused`, `completed`, `failed`).
- Persisted step log linked to existing trajectory/durable store patterns.
- APIs: create session, append event, pause/resume, final summary; align with `X-Agent-Run-Id` story.
- Server-side **cancellation** token propagated into tool execution and LLM streaming where possible.
- Concurrency: max concurrent sessions per workspace (quota hook).

**Exit criteria**

- A run can be **interrupted** and **resumed** without losing the step history.
- Admin or workspace owner can list sessions and inspect trajectory for audit.

**Depends on:** Phase 0.

---

### Phase 2 — Policy engine v1 (4–8 weeks, overlap Phase 1)

**Goal:** Move from env allowlists alone to **structured policy** (per workspace + role).

**Deliverables**

- Policy model: tool groups, path prefixes, URL patterns, network egress class, max risk tier.
- Enforcement at `runTool` / hooks boundary with **consistent error codes** for evals.
- UI/API: workspace policy editor (minimal); defaults deny risky tools.
- Metrics: policy denial count by rule id.

**Exit criteria**

- Two workspaces with **different** tool profiles behave predictably in automated tests.
- No secret material in tool args logged (verify with regression tests).

**Depends on:** Phase 0. **Parallel with** Phase 1.

---

### Phase 3 — Environment tools: read-first (6–10 weeks)

**Goal:** OpenClaw-class **workspace grounding** — read the project like an engineer.

**Deliverables**

- **Filesystem read**: list, read file, search (ripgrep-like or Node impl), strict path canonicalization, size limits.
- **Git read**: status, diff, log (configurable depth), branch name; no write in this phase.
- Optional: **single-root attachment** model for serverless (explicit `WORKSPACE_ROOT` or uploaded bundle).

**Exit criteria**

- Golden evals: “summarize this repo structure”, “what changed since last commit” using only read tools.
- Fuzz tests for path traversal; 100% blocked in CI.

**Depends on:** Phase 2 (policy). **Uses** Phase 1 (session) if long tasks.

---

### Phase 4 — Environment tools: act (8–14 weeks)

**Goal:** Safe **mutation** and execution.

**Deliverables**

- **Filesystem write** behind approval tier: patch/diff apply or scoped write with backup snapshot (workspace-local).
- **Git write** (opt-in): commit with message template; never force-push by default.
- **Structured command runner**: allowlisted prefixes or recipe-bound commands; full stdout/stderr capture; timeouts.
- **Sandboxed code execution** (preferred): container or isolated subprocess with CPU/mem/time/network policy; integrate with plugin story rather than one-off.

**Exit criteria**

- Demo flow: clone or attach repo → agent runs tests → proposes patch → human approves → commit.
- Automated test proves **denied** commands do not execute.

**Depends on:** Phase 3.

---

### Phase 5 — Browser & live web (8–12 weeks)

**Goal:** Research and UI validation with **high** abuse risk — ship carefully.

**Deliverables**

- Playwright (or equivalent) tool suite: open URL (allowlisted), extract text, screenshot, simple forms.
- Human-in-the-loop gate for new domains or credential contexts.
- Integration with citations (page title, URL, excerpt).

**Exit criteria**

- Eval: “price on allowed page” with **expected URL host**; fails closed if host not allowed.
- Rate limits and per-session browser hours documented for operators.

**Depends on:** Phase 2, Phase 1.

---

### Phase 6 — Data & API connectors (6–12 weeks)

**Goal:** Structured enterprise data without giving the model raw connection strings.

**Deliverables**

- **SQL read-only** path (or BigQuery/Snowflake read-only) with row caps, statement class limits, workspace-bound credentials via secret references.
- **OpenAPI import → tools** (generated descriptions and parameter schemas; server executes with auth injection).

**Exit criteria**

- Sample connector passes eval: natural question → SQL tool → grounded answer with table/row citation pattern.
- Fails closed on `DROP`, `DELETE`, multi-statement when not explicitly allowed.

**Depends on:** Phase 2.

---

### Phase 7 — Intelligence v2 (ongoing 8–16 weeks, can start after Phase 1)

**Goal:** Reliability and planning beyond keyword routing.

**Deliverables**

- **Planner** produces explicit task DAG (dependencies), rollback hints, and stop conditions.
- **Critic/repair loop**: on tool failure, structured retry policy; optional small “diagnostician” model.
- Telemetry-driven **specialist selection** (replace pure keywords over time).

**Exit criteria**

- A/B or offline eval: ↑ success rate on multi-tool benchmark set; ↓ useless repeats (stagnation already mitigated — measure remaining loops).

**Depends on:** Phase 1; benefits from Phases 3–4 data.

---

### Phase 8 — Channels & notifications (10–20 weeks)

**Goal:** Same session runtime across surfaces.

**Deliverables**

- **Slack** and/or **Discord** bot: map channel/thread to workspace session; OAuth apps; rate limits.
- Optional: email ingest/outbound (later; higher phishing/legal risk).
- Desktop synergy: native notifications already planned in PRD phases — wire session events.

**Exit criteria**

- User can start a run from Slack, continue from web, same session id and audit trail.

**Depends on:** Phase 1, Phase 2.

---

### Phase 9 — MCP & skill packaging (8–14 weeks)

**Goal:** Ecosystem parity with modern agent hosts.

**Deliverables**

- **MCP client**: register remote tool servers; merge into tool schema with namespacing; policy applies per tool.
- **MCP server** (optional): expose core Siskel tools to external clients.
- **Skill bundles**: versioned zip or manifest — prompt + tools + policy + eval cases (extends plugins/recipes).

**Exit criteria**

- One external MCP server’s tools appear in agent mode and respect workspace allowlist.
- Publish skill bundle template and one reference bundle in-repo.

**Depends on:** Phase 2; best after Phase 3 (clear value demo).

---

### Phase 10 — Enterprise hardening (continuous, heavy 12–24 weeks)

**Deliverables**

- SSO/SAML alignment if not already complete for target customers.
- Per-region residency hooks (you have design notes — operational runbooks).
- Backup/restore drills for session + workspace data.
- Pentest fixes, dependency review SBOM, bug bounty prep (as appropriate).

**Exit criteria**

- Checklist sign-off for “safe to enable filesystem + browser + code exec in production” with policy defaults.

**Depends on:** Phases 2, 4, 5.

---

## 5. Suggested calendar (compact)

This is **sequencing**, not headcount-adjusted capacity planning.

| Quarter | Focus |
|---------|--------|
| **Q1** | Phase 0–1–2: sessions + policy MVP |
| **Q2** | Phase 3–4: read filesystem/git; write/exec with sandbox |
| **Q3** | Phase 5–6: browser + SQL/OpenAPI; start Phase 7 |
| **Q4** | Phase 8–9: Slack/Discord + MCP; Phase 10 continuous |

Parallelism: **Phase 7** and **Phase 8** can start mid-year once Phase 1–2 land. **Desktop** work (PRD 97–116) overlaps Q1–Q4 without blocking core server capabilities.

---

## 6. KPIs (review monthly)

| Metric | Why it matters |
|--------|----------------|
| Task success rate (eval + sampled prod) | Overall agent usefulness |
| Mean tool calls per successful task | Efficiency |
| Policy denial rate | Safety vs friction tuning |
| Truncation rate (budget/time) | Capacity planning |
| P95 session wall time | UX and cost |
| Mean time to recovery after tool error | Intelligence track health |
| Integration uptime (Slack, MCP) | Platform readiness |

---

## 7. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Prompt injection via RAG/browser | Separate control plane; tool confirmations; domain allowlists |
| Sandbox escape | Minimal images, non-root, seccomp, regular base image refreshes |
| Credential exfiltration | Secret references; no paste of keys into model; egress policies |
| Scope creep on integrations | MCP-first; ship 2 channels well before dozens |
| Serverless constraints (Vercel) | Explicit “attached workspace” limits; direct users to always-on or desktop for heavy runs |

---

## 8. Definition of “world class” for this program

The program is successful when:

1. A **typical** software team can attach a repo and get **read/write/code/test** loops with audit.
2. **Sessions** survive network blips and support human handoff.
3. **Policy** is understandable by a security reviewer without reading all application code.
4. **MCP** unlocks long-tail tools faster than bespoke routes.
5. Evals and trajectories prove **regression safety** on every release.

---

## 9. Implementation status (April 2026)

| Phase | Status |
|-------|--------|
| **0** | **Shipped:** [AGENT_THREAT_MODEL.md](./AGENT_THREAT_MODEL.md), `lib/workspace-path-guard.js`, tests (`workspace-path-guard.test.js`, `agent-policy-denied-tools.test.js`, `workspace-fs-tools.test.js`). |
| **1** | **Shipped:** `lib/agent-session.js` (durable store), `lib/agent-run-control.js` (concurrency + in-process cancel), `routes/agent-sessions.js`, `agent-loop` integration: `agentOptions.sessionId`, headers `X-Agent-Session-Id`, `POST /api/v1/agent/sessions/:id/cancel`, env `AGENT_SESSION_API` (default on), optional `AGENT_MAX_CONCURRENT_RUNS_PER_WORKSPACE`. |
| **2** | **Shipped:** `agentPolicy.deniedTools` in workspace agent-settings; enforcement in `checkPolicyBeforeTool` and `runTool`; metric `siskelbot_agent_policy_denials_total` when `ENABLE_METRICS=1`. |
| **3** | **Shipped (read-only FS):** `WORKSPACE_FILE_TOOLS=1` and `WORKSPACE_ROOT` — `workspace_list_dir`, `workspace_read_file`, `workspace_search_text` (`lib/workspace-fs-tools.js`). |
| **4** | **Shipped (MVP):** `lib/workspace-act-tools.js` — `workspace_write_file` (`WORKSPACE_FILE_WRITE_TOOLS=1`, backup before overwrite), `workspace_git_*` read (`WORKSPACE_GIT_TOOLS=1`), `workspace_git_commit` (`WORKSPACE_GIT_WRITE=1`, explicit paths only), `workspace_run_command` (`WORKSPACE_COMMAND_ALLOWLIST`, no shell). Audit log + category caps (`write`) apply. Tests: `workspace-act-tools.test.js`. **Deferred from MVP:** patch/diff-apply format, Docker-isolated code execution, HITL gate per mutation (use `deniedTools` + `execute_step` HITL today). |
| **5** | **Partial (B5.1):** `lib/browser-agent-tools.js`, tool `browser_open_extract_text`, env `AGENT_BROWSER_TOOLS=1`; reuses `BROWSER_URL_ALLOWLIST` or `AGENT_FETCH_ALLOWLIST`; Playwright optional dependency. |
| **6–10** | *Planned* — see **§10** for the next milestones. |

`/config` exposes session, filesystem, git, command-runner, and **browser tools** (`agentBrowserToolsEnabled`) flags for clients.

---

## 10. Forward plan (Phase 5–10 milestones)

Use this as a rolling backlog; re-prioritize each quarter.

### Phase 5 — Browser (incremental)

| Milestone | Outcome |
|-----------|---------|
| B5.1 | **Shipped (in-repo):** text extraction + allowlist via `browser_open_extract_text` (`lib/browser-agent-tools.js`, `AGENT_BROWSER_TOOLS=1`; allowlist via `BROWSER_URL_ALLOWLIST` / `AGENT_FETCH_ALLOWLIST`; Playwright optional). **B5.2+** still planned (screenshot, HITL, golden evals). |
| B5.2 | Screenshot + storage in workspace; attach to trajectory. |
| B5.3 | HITL for first visit to new registrable domain; per-workspace domain policy in agent-settings. |
| B5.4 | Golden evals with fixed URL fixture or recorded HTTP mocks. |

### Phase 6 — Data plane

| Milestone | Outcome |
|-----------|---------|
| D6.1 | Read-only SQL proxy: one connection string per workspace via env/secret ref; `SELECT` only validator. |
| D6.2 | Row/column caps + explain-only mode. |
| D6.3 | OpenAPI import: generate tool defs + server-side auth injection (Bearer from vault). |

### Phase 7 — Intelligence

| Milestone | Outcome |
|-----------|---------|
| I7.1 | Structured planner output (JSON DAG) stored on session; optional re-plan after tool failure. |
| I7.2 | Offline benchmark set for planner + regression in eval harness. |
| I7.3 | Replace/enrich swarm routing with embedding + telemetry features (build on `swarm-intent-v2`). |

### Phase 8 — Channels

| Milestone | Outcome |
|-----------|---------|
| C8.1 | Slack OAuth + event URL → map to `sessionId` + `workspaceId`. |
| C8.2 | Discord parity; shared connector abstraction (`lib/channel-connectors/`). |
| C8.3 | Desktop/native notifications for session completion (align with PRD desktop phases). |

### Phase 9 — MCP & skills

| Milestone | Outcome |
|-----------|---------|
| M9.1 | MCP client (stdio + SSE transport); namespace tools `mcp__<server>__<tool>`. |
| M9.2 | Optional MCP server exporting `runTool` subset for Claude Desktop etc. |
| M9.3 | Skill manifest v1: zip with `skill.json` (tools, policy hints, eval cases) + import API. |

### Phase 10 — Enterprise

| Milestone | Outcome |
|-----------|---------|
| E10.1 | Production checklist doc + pre-flight `GET /admin/agent-capabilities` summary. |
| E10.2 | Per-region session + trajectory retention; export for compliance. |
| E10.3 | SBOM + automated dep review gate on release. |

---

*Last updated: April 2026*
