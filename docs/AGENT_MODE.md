# Phase 15: Agentic Autonomy Mode

Agent mode lets the LLM call tools to search context, list documents, fetch recipes, and (when enabled) execute build/deploy steps. The server runs a tool-call loop and streams the final response.

## How it works

1. **Client**: Enable "Agent mode" in Settings (default: off).
2. **Request**: When agent mode is on, the client sends `agentMode: true` and `agentOptions: { allowExecution, workspace }` to `POST /v1/chat/completions`.
3. **Server**: Injects the tool schema, calls the LLM with `stream: false`, and runs a loop:
   - If the LLM returns `tool_calls`, execute each tool (in parallel when multiple), append results as `role: "tool"` messages, and call the LLM again.
   - Repeat until the LLM returns no `tool_calls`, or `MAX_AGENT_ITERATIONS` is reached.
4. **Response**: Streams the final text content to the client as SSE (same format as normal chat).

## Tools

| Tool | Description | Approval |
|------|-------------|----------|
| `execute_step` | Run build, deploy, or copy step. Uses existing `executeStep` from action-executor. | Requires `allowExecution` + `ALLOW_RECIPE_STEP_EXECUTION=1` |
| `search_context` | Search indexed knowledge/context by query. | Read-only, no approval |
| `list_context` | List titles of indexed context documents. | Read-only, no approval |
| `get_recipe` | Fetch a saved recipe by name. Returns steps for inspection or execution. | Read-only, no approval |

## Safety

- **execute_step** needs two things:
  - Client has "Allow recipe step execution" enabled in Settings.
  - Server has `ALLOW_RECIPE_STEP_EXECUTION=1`.
- **Read-only tools** (search_context, list_context, get_recipe) run without approval.
- Optional per-call approval for execute_step can be added later (modal before running).

## Swarm mode

When `ENABLE_AGENT_SWARM=1`, you can use **swarm mode** for multi-specialist orchestration: intent detection, parallel specialist execution, and synthesis.

### Specialists

| Specialist | Tools | Role |
|------------|-------|------|
| `researcher` | search_context, list_context | Search and list knowledge/context |
| `executor` | execute_step, get_recipe | Run recipe steps, fetch saved recipes |
| `synthesizer` | (none) | Combines specialist outputs into final response |

### Flow

1. **Intent detection**: The user message is analyzed (keywords) to pick eligible specialists (researcher, executor, or both).
2. **Parallel execution**: Eligible specialists run their tool loops concurrently. Tool calls within a specialist are also executed in parallel.
3. **Synthesis**: The synthesizer (no tools) receives aggregated outputs and produces the final answer.

### Enabling swarm mode

- **Server**: Set `ENABLE_AGENT_SWARM=1`. When unset, agent mode behaves as before (single-agent loop).
- **Client**: Send `agentMode: true` and `swarmMode: true` in the request body.

### API (swarm)

- **POST /v1/chat/completions** with `agentMode: true`, `swarmMode: true`, and `agentOptions` (same as agent mode).
- **POST /v1/agent/swarm** (optional): Accepts same body as chat completions and forces swarm mode. Same SSE response format.

Both require `ENABLE_AGENT_SWARM=1`.

### Response headers (swarm)

- `X-Swarm-Agents`: Number of specialists that ran.
- `X-Swarm-Duration-Ms`: Total swarm duration in milliseconds.
- `X-Agent-Iteration`: Same as agent mode (specialists + synthesizer).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_AGENT_ITERATIONS` | `5` | Maximum tool-call loop iterations per request. |
| `ALLOW_RECIPE_STEP_EXECUTION` | (unset) | Set `1` to allow `execute_step` when the client also enables it. |
| `ENABLE_AGENT_SWARM` | (unset) | Set `1` to enable swarm mode when `agentMode` and `swarmMode` are both true. When unset, agent mode behaves as today. |

## Debugging

- **X-Agent-Iteration** header: Included in agent responses; shows how many iterations were run.
- **X-Swarm-Agents**, **X-Swarm-Duration-Ms**: Included when swarm mode is used.
- Server logs: Log iteration count when running the agent loop (optional enhancement).

## API

Reuses `POST /v1/chat/completions`:

- **Request body (when agent mode)**:
  - `agentMode: true`
  - `agentOptions: { allowExecution: boolean, workspace?: string }`
  - `messages`, `model`, etc. (same as normal chat)
- **Request body (when swarm mode)**:
  - `agentMode: true`, `swarmMode: true`
  - Same `agentOptions` and `messages`
- **Response**: SSE stream of final content; same format as non-agent chat.

## Backend support

Tool-calling support depends on the LLM backend:

- **OpenAI**: Supports tools.
- **Ollama**: Supports tools in recent versions.
- **vLLM**: Supports OpenAI-compatible tool format.

If the backend does not support tools, the agent loop may fail or return a non-tool response.
