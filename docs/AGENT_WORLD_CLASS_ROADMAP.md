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

## 3. Workstreams (run in parallel after Phase 1)

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

## 4. Twenty-phase feature roadmap (full program)

Each phase lists **goal**, **deliverables**, **exit criteria**, and **dependencies**. Phases **1–5** are largely **in progress or shipped** in-repo; **6–20** extend the bar to **OpenClaw-class breadth** (connectors, MCP, enterprise).

**Recommended next steps (highest leverage)** — do these in parallel where possible:

1. **Finish Phase 6 (browser):** screenshots, per-workspace domain allowlists, HITL for new registrable domains, golden evals with mocks — closes the highest-risk surface with product-grade gates.
2. **Unify budgets:** **Done** for browser tools vs `fetch_allowed_url` via `toolConsumesExternalFetchBudget` (still tune **network** category caps separately if needed).
3. **Phase 8 — planner persistence then failure-driven re-plan:** **Phase 8a (landed / in progress):** with `AGENT_UPFRONT_PLAN=1`, persist planner/upfront DAG on the session; checkpoints carry `upfrontPlanDag` on supported paths — **partially shipped** (not guaranteed on every resume/serialization edge yet). **Phase 8b (next):** deterministic **re-plan after tool failure** / failed step with capped loops; golden eval proving the plan revises after a controlled failure.
4. **Phase 16 continuously:** treat **`eval:ci`** and offline eval sets as the enforcement backbone — expand golden traces / judges so every new tool category ships with negative + positive coverage wired into those gates.
5. **Phase 7 when act tools see production traffic:** **sandboxed** code/plugins (container or hardened subprocess), not host-native execution — before expanding allowlists.

---

### Phase 1 — Program foundation & threat modeling (1–2 weeks)

**Goal:** Baselines for safety and measurement before expanding the tool surface.

**Deliverables:** RACI / ownership for tracks A–G; threat model for filesystem, browser, code execution; KPI definitions; negative tests (policy denial, path escape) in CI.

**Exit:** Documented RACI + KPI fields; CI green; baseline metrics captured (tool success, truncation, steps/run).

**Depends on:** —

---

### Phase 2 — Durable agent sessions (4–8 weeks)

**Goal:** Sessions are first-class, not a single HTTP request.

**Deliverables:** Session entity (id, workspace, user, status, timestamps); persisted step/event log; APIs (create, append, pause/resume, summary); cancel propagated into tools/streaming; max concurrent sessions per workspace.

**Exit:** Runs can be interrupted and resumed without losing history; operators can list sessions and inspect trajectory.

**Depends on:** 1

---

### Phase 3 — Policy engine & tool governance (4–8 weeks, overlap with 2)

**Goal:** Structured policy per workspace and role, not env-only allowlists.

**Deliverables:** Tool groups, path/URL/network classes, risk tiers; enforcement at `runTool` with stable error codes; workspace policy editor (minimal API/UI); metrics on denials by rule.

**Exit:** Two workspaces with different profiles behave predictably in tests; no secrets in tool-arg logs.

**Depends on:** 1. **Parallel with** 2.

---

### Phase 4 — Workspace read surface (6–10 weeks)

**Goal:** Ground the agent in the repo like an engineer (read-only).

**Deliverables:** Filesystem list/read/search with strict canonical paths and size limits; git status/diff/log/branch; optional single-root attachment for serverless (`WORKSPACE_ROOT` / bundle).

**Exit:** Golden evals: repo structure summary, “what changed since last commit” using only read tools; path traversal fuzz tests 100% blocked.

**Depends on:** 3 (uses 2 for long runs).

---

### Phase 5 — Workspace mutations & commands (8–14 weeks)

**Goal:** Safe writes and bounded execution.

**Deliverables:** Scoped writes with backup; git commit (no force-push by default); structured command runner (allowlisted argv, no arbitrary shell); full audit and timeouts.

**Exit:** Demo: attach repo → run tests → propose patch → approve → commit; tests prove denied commands never execute.

**Depends on:** 4

---

### Phase 6 — Browser & live web (8–12 weeks)

**Goal:** JS-rendered research and UI checks with **high** abuse risk — ship incrementally.

**Deliverables:** Allowlisted navigation; text extraction (shipped), screenshots, simple forms; HITL for new domains / credential contexts; citations (title, URL, excerpt); operator docs for rate limits and session “browser budgets.”

**Exit:** Eval on fixed allowlisted host; fails closed off-allowlist; documented limits.

**Depends on:** 2, 3

---

### Phase 7 — Sandboxed code & plugin execution (8–16 weeks)

**Goal:** Run untrusted or third-party code **off the host process** with clear quotas.

**Deliverables:** Container or hardened subprocess integration; CPU/memory/time/network policy; bridge to existing plugin/recipe model; default-off + workspace opt-in.

**Exit:** Escape/abuse tests and resource limit tests pass; production checklist section for “code execution enabled.”

**Depends on:** 3, 5

---

### Phase 8 — Structured planning & task graphs (8–16 weeks)

**Goal:** Explicit plans the runtime can re-use, not only implicit tool chains.

**Deliverables:** Planner emits DAG (nodes, edges, stop conditions, rollback hints) stored on session; optional checkpoint before risky steps; re-plan after tool failure.

**Exit:** Offline benchmark for planning; regression suite in eval harness; measure ↓ redundant tool loops.

**Depends on:** 2 (strong benefit from 4–5 for grounding).

---

### Phase 9 — Recovery, critique & routing (ongoing, 8–16 weeks)

**Goal:** Reliability when tools fail or the model drifts.

**Deliverables:** Structured retry/backoff policies; optional small “diagnostician” or critic step; telemetry-driven swarm/specialist selection (beyond keyword routing).

**Exit:** A/B or offline eval: ↑ task success on multi-tool benchmarks; ↓ useless repeats after stagnation controls.

**Depends on:** 8; benefits from 4–7.

---

### Phase 10 — Governed SQL & analytics (6–12 weeks)

**Goal:** Enterprise data without pasting connection strings into prompts.

**Deliverables:** Read-only SQL (or BigQuery/Snowflake read) with workspace secret references; statement validator (`SELECT`-class); row/column caps; explain-only mode.

**Exit:** Eval: natural question → governed SQL → grounded answer; `DROP`/`DELETE`/multi-statement blocked unless explicitly allowed.

**Depends on:** 3

---

### Phase 11 — OpenAPI & HTTP tool factory (6–12 weeks)

**Goal:** Internal and partner APIs become first-class tools.

**Deliverables:** OpenAPI import → tool definitions + schemas; server-side auth injection (Bearer from vault); per-host rate limits and policy class.

**Exit:** One real internal API integrated end-to-end with policy and an eval case.

**Depends on:** 3

---

### Phase 12 — MCP client & federated tools (8–14 weeks)

**Goal:** Long-tail integrations without bespoke routes for every vendor.

**Deliverables:** MCP client (stdio + SSE); merge remote tool catalogs with namespacing (`mcp__server__tool`); policy applies per tool; health and version introspection.

**Exit:** At least one external MCP server’s tools run under workspace allowlists in production-like env.

**Depends on:** 3; best after 4 (clear demo).

---

### Phase 13 — MCP server & portable skill packages (6–12 weeks)

**Goal:** SiskelBot participates in the wider MCP ecosystem and ships portable “skills.”

**Deliverables:** Optional MCP server exposing a curated subset of tools; skill manifest format (tools + policy hints + eval cases); import/versioning API; reference bundle in-repo.

**Exit:** External client (e.g. desktop agent) can call Siskel tools with OAuth/API key; one reference skill ships in docs.

**Depends on:** 12

---

### Phase 14 — Messaging & async channels (10–20 weeks)

**Goal:** Same session and audit trail across chat products.

**Deliverables:** Slack and/or Discord OAuth; map thread/channel to `workspaceId` + `sessionId`; shared connector abstraction; optional email patterns (later; legal/phishing review).

**Exit:** Start in Slack, continue in web UI, same session id and trajectory.

**Depends on:** 2, 3

---

### Phase 15 — Human-in-the-loop product layer (6–12 weeks)

**Goal:** Progressive autonomy as a **product**, not only recipes.

**Deliverables:** Approval tiers (read → propose → execute); pending tool queue UI + API; escalation rules by risk tier and role; integration with existing HITL resume.

**Exit:** Defaults differ by role; security reviewer can understand tiers without reading all tool code.

**Depends on:** 3, 5 (6 strengthens story).

---

### Phase 16 — Observability, evals & regression gates (continuous)

**Goal:** Every release proves it did not break agent behavior.

**Deliverables:** Golden traces per phased capability; judge + thresholds in CI; trajectory export for debugging; dashboards for tool latency, denial rate, truncation.

**Exit:** Release policy: merge blocked if eval regression exceeds threshold (after burn-in period).

**Depends on:** 1; tightens all other phases.

---

### Phase 17 — Secrets, vault & ABAC (8–16 weeks)

**Goal:** Credentials and fine-grained access at enterprise depth.

**Deliverables:** Secret references only (no raw keys in model context); workspace-bound vault integration; ABAC rules mapping identity + workspace attributes to tool groups.

**Exit:** Pentest scenarios for exfiltration pass; compliance narrative for session/trajectory retention.

**Depends on:** 3

---

### Phase 18 — Multimodal & rich documents (8–16 weeks)

**Goal:** Agents reason over how work **looks**, not only plaintext.

**Deliverables:** Image/chart inputs in agent loop with policy; OCR/document pipeline alignment with knowledge/RAG; size and PII redaction policies for uploads.

**Exit:** Evals on fixed multimodal fixtures with citations; abuse tests for oversized or malicious uploads.

**Depends on:** 4, 16

---

### Phase 19 — Cost, latency & model routing (ongoing)

**Goal:** Right model and spend per step without sacrificing quality on hard tasks.

**Deliverables:** Router policies (intent, risk, token estimate); small/large model split; caching hooks; streaming and token budgets coordinated with existing circuit breaker and quotas.

**Exit:** P95 wall time and cost per successful task improve on benchmark without quality regression.

**Depends on:** 8, 9

---

### Phase 20 — Enterprise readiness & operational excellence (12–24 weeks, continuous)

**Goal:** Safe defaults for filesystem + browser + code in regulated environments.

**Deliverables:** SSO/SAML alignment for target customers; data residency and retention/export; backup/restore drills for sessions/workspaces; SBOM and automated dependency review; runbooks and on-call paths.

**Exit:** Signed checklist: “risky tools allowed in production” with default-deny policy and operator training.

**Depends on:** 6, 7, 17 (and maturity of 16)

---

## 5. Suggested calendar (compact, 20-phase view)

This is **sequencing**, not headcount-adjusted capacity planning.

| Quarter | Focus |
|---------|--------|
| **Q1** | **1–3:** foundation, sessions, policy — **4–5:** read + act MVP |
| **Q2** | **6–7:** browser suite + sandboxed execution — start **8–9** planning/recovery |
| **Q3** | **10–11:** SQL + OpenAPI — **12–13:** MCP client/server and skills |
| **Q4** | **14–15:** channels + HITL productization — deepen **16–17** |
| **Year 2** | **18–20:** multimodal, routing/cost polish, enterprise hardening (continuous **16**) |

Parallelism: **8–9** and **14** can start once **2–3** are solid. **Desktop** (PRD 97–116) runs in parallel and improves reach but does not replace server-side tool breadth.

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

## 9. Implementation status (April 2026, vs 20-phase map)

| Phase | Theme | Status |
|-------|--------|--------|
| **1** | Foundation & threat model | **Shipped:** [AGENT_THREAT_MODEL.md](./AGENT_THREAT_MODEL.md), `lib/workspace-path-guard.js`, tests (`workspace-path-guard.test.js`, `agent-policy-denied-tools.test.js`, `workspace-fs-tools.test.js`). |
| **2** | Durable sessions | **Shipped:** `lib/agent-session.js`, `lib/agent-run-control.js`, `routes/agent-sessions.js`, `agent-loop` + `agentOptions.sessionId`, `X-Agent-Session-Id`, `POST .../cancel`, optional **`planSummary` / `planDag`** on create and **`POST .../sessions/:id/plan`** to update (Phase 8 storage hook). |
| **3** | Policy engine | **Shipped (MVP):** `agentPolicy.deniedTools`; `checkPolicyBeforeTool` / `runTool`; `siskelbot_agent_policy_denials_total` when `ENABLE_METRICS=1`. *Next:* tool groups, URL/path classes in agent-settings UI. |
| **4** | Workspace read | **Shipped:** `WORKSPACE_FILE_TOOLS=1`, `WORKSPACE_ROOT`, `workspace_list_dir` / `workspace_read_file` / `workspace_search_text` (`lib/workspace-fs-tools.js`). |
| **5** | Mutations & commands | **Shipped (MVP):** `lib/workspace-act-tools.js` — write, git read/commit, `workspace_run_command` with allowlist. **Deferred:** structured patch apply, per-step HITL product layer (Phase 15). |
| **6** | Browser & web | **Partial:** `browser_open_extract_text`, `browser_capture_screenshot`; workspace `agentPolicy.browserAllowedHosts`; browser tools share **`maxExternalFetches`** with `fetch_allowed_url`. **Next:** HITL for new domains, golden evals. |
| **7** | Sandboxed execution | *Planned* — container/hardened subprocess; plugin bridge. |
| **8** | Planning & DAGs | **Partial (I8.1 + I8.2):** Tool `update_agent_session_plan` (session runs only); `tool_failed` session events; optional `AGENT_SESSION_REPLAN_NUDGE=1` user nudge after `ok:false`. **I8.2:** `lib/agent-session-plan-dag.js` — offline lint for graph-shaped `planDag` (`nodes`/`edges`), cycle + reference checks; opt-in `AGENT_SESSION_PLAN_DAG_LINT=strict` in `validateAgentSessionPlanInput` / `POST …/plan`. **Next:** planner golden evals + harness thresholds. |
| **9** | Recovery & routing | **Partial (I9.1):** Transient retries for allowlisted tools (`AGENT_TOOL_RETRY_MAX`, workspace `agentPolicy.transientToolRetryLimit`); metrics `siskelbot_agent_tool_retries_total`. **Next:** critic pass; telemetry-driven swarm routing (I9.2). |
| **10** | Governed SQL | *Planned* — read-only proxy, caps, secret refs. |
| **11** | OpenAPI tools | *Planned* — import + auth injection. |
| **12** | MCP client | *Planned* — stdio/SSE, namespaced tools. |
| **13** | MCP server & skills | *Planned* — export tools; skill bundles. |
| **14** | Channels | *Planned* — Slack/Discord abstraction. |
| **15** | HITL product | *Planned* — approval tiers, pending queue. |
| **16** | Evals & gates | **Partial** — existing trajectory/eval harness; expand per-phase golden sets + merge gates. |
| **17** | Vault & ABAC | *Planned* — secret references, fine-grained access. |
| **18** | Multimodal | *Planned* — images/docs in loop with policy. |
| **19** | Cost & routing | **Partial** — budgets, circuit breaker; formalize router + caching. |
| **20** | Enterprise ops | *Planned* — residency, SBOM, DR, checklist. |

`/config` exposes session, filesystem, git, command-runner, and browser tool flags for clients.

---

## 10. Near-term milestones (rolling backlog)

Re-prioritize each quarter; milestones nest under **§4** phases above.

### Phase 6 — Browser (incremental)

| Milestone | Outcome |
|-----------|---------|
| B6.1 | **Shipped:** `browser_open_extract_text` + allowlists (`lib/browser-agent-tools.js`). |
| B6.2 | **Shipped:** `browser_capture_screenshot`; workspace file under `.siskelbot/browser-screenshots/` when `WORKSPACE_ROOT` set, else capped base64 JPEG. |
| B6.3 | HITL for new registrable domains; per-workspace domain policy in agent-settings. |
| B6.4 | Golden evals with fixtures or recorded HTTP mocks. |
| B6.5 | **Shipped:** `maxExternalFetches` / `AGENT_MAX_EXTERNAL_FETCHES` counts `fetch_allowed_url` + browser tools (`toolConsumesExternalFetchBudget` in `lib/agent-policy.js`). |

### Phase 8–9 — Intelligence

| Milestone | Outcome |
|-----------|---------|
| I8.1 | **Shipped:** `update_agent_session_plan` + session `tool_failed` events + optional replan nudge env. |
| I8.2 | **Partial:** DAG structural lint + strict persist gate (`AGENT_SESSION_PLAN_DAG_LINT`); tests in `tests/agent-session-plan-dag.test.js`. **Next:** golden planner traces + CI threshold. |
| I9.1 | **Shipped:** Transient tool retries (`lib/agent-tool-retry.js`, `executeAgentToolBatch`, swarm specialists); deploy + workspace merge. |
| I9.2 | Enrich swarm routing with embeddings + telemetry (extends `swarm-intent-v2`). |

### Phase 10–11 — Data & APIs

| Milestone | Outcome |
|-----------|---------|
| D10.1 | Read-only SQL proxy; `SELECT`-only validator; secret ref per workspace. |
| D10.2 | Row/column caps + explain-only mode. |
| D11.1 | OpenAPI import → tools + server-side Bearer from vault. |

### Phase 12–13 — MCP

| Milestone | Outcome |
|-----------|---------|
| M12.1 | MCP client (stdio + SSE); `mcp__<server>__<tool>` namespacing. |
| M13.1 | Optional MCP server for external clients. |
| M13.2 | Skill manifest + import API; reference `skill.zip` in-repo. |

### Phase 14–15 — Channels & HITL

| Milestone | Outcome |
|-----------|---------|
| C14.1 | Slack OAuth + session mapping. |
| C14.2 | Discord parity; `lib/channel-connectors/`. |
| H15.1 | Approval tiers API + UI; pending tool queue. |

### Phase 16–20 — Hardening

| Milestone | Outcome |
|-----------|---------|
| O16.1 | CI merge gate on golden trace regression (threshold tuning). |
| E17.1 | Vault integration + ABAC rules for tool groups. |
| E18.1 | Multimodal ingest policy + eval fixtures. |
| E19.1 | Router/cost dashboard + policies per workspace. |
| E20.1 | Production checklist + `GET /admin/agent-capabilities` summary; SBOM gate. |

---

*Last updated: April 2026 (I8.2 lint + I9.1 retries documented)*
