## Agent profiles

Named persona configurations (subagent profiles) with system prompt, tool allowlist/denylist, model override, and execution budgets. Workspace-scoped CRUD so teams can define their own profiles.

### Profile schema

```js
{
  id: string,           // "researcher", "code_writer", etc. — alphanumeric + hyphens/underscores, 2-64 chars
  name: string,         // display name
  systemPrompt: string, // required, non-empty
  model: string | null, // null = inherit from caller
  toolAllowlist: string[] | null, // null = inherit all tools
  toolDenylist: string[] | null,  // explicit deny (applied after allowlist)
  budgets: {
    maxIterations: number | null,  // null = default
    maxCostUsd: number | null,
    maxWallTimeMs: number | null,
    maxToolCalls: number | null,
  },
  builtIn: boolean,     // true for the 5 defaults; false for user-defined
  createdAt: string,    // ISO 8601
  updatedAt: string,    // ISO 8601
}
```

### Built-in profiles

| id | systemPrompt (first line) | model | toolAllowlist | budgets |
|----|---------------------------|-------|---------------|---------|
| researcher | "You are a research agent. Search and summarize findings. Never modify data." | null | search_context, semantic_search_context, fetch_allowed_url, web_search, list_context, get_context_document, search_knowledge_graph | maxIterations:15, maxCostUsd:0.50 |
| executor | "You are an execution agent. Carry out the plan step by step." | null | null (all tools) | maxIterations:25, maxCostUsd:2.00 |
| synthesizer | "You are a synthesis agent. Combine inputs into coherent output." | null | search_context, get_context_document, create_document | maxIterations:5, maxCostUsd:0.20 |
| code_writer | "You are a code-writing agent. Write clean, tested code." | null | workspace_read_file, code_execute, search_context | maxIterations:20, maxCostUsd:1.00 |
| reviewer | "You are a review agent. Analyze for correctness, security, and quality. Do not modify." | null | search_context, workspace_read_file, get_context_document | maxIterations:10, maxCostUsd:0.30 |

### Endpoints

All endpoints are workspace-scoped via `?workspace=<name>` query parameter (defaults to "default").

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| GET | `/api/v1/agent/profiles` | read | List all profiles (built-ins + workspace custom) |
| GET | `/api/v1/agent/profiles/:id` | read | Get a single profile by id |
| PUT | `/api/v1/agent/profiles/:id` | write | Create or update a profile (validates schema) |
| DELETE | `/api/v1/agent/profiles/:id` | write | Delete a workspace profile or override; rejects built-in delete without override |

### Storage

Per-workspace profiles are stored via `lib/json-path-store.js` under `data/agent-profiles/<workspace>.json`. Built-in profiles are always available from in-memory defaults regardless of storage state.

### routes/index.js wiring snippet

To wire the agent profiles routes into the application, add the following to `routes/index.js`:

```js
// Import
import { mountAgentProfileRoutes } from "./agent-profiles.js";

// Add to mountFunctions array
mountAgentProfileRoutes,
```

## Memory auto-injection

`lib/agent-memory-inject.js` provides automatic injection of relevant workspace memories into the agent's context before each LLM call. Memories are scored by keyword relevance, recency, and importance, then the top-ranked subset is inserted as a system message.

### How to enable

The injection function is ready to use. In `lib/agent-loop.js`, add this one-line hook after messages are assembled (after `augmentMessagesForGrounding`) and before the first LLM call:

```js
import { injectMemories } from "./agent-memory-inject.js";

// After augmentMessagesForGrounding(messages) and before the while loop:
const memResult = await injectMemories({ messages, workspace, userId: storageUserId });
messages = memResult.messages;
```

### Scoring formula

Each memory is scored against the latest user message using a weighted combination:

```
combined = 0.5 * keyword + 0.3 * recency + 0.2 * importance
```

| Component | Calculation | Range |
|-----------|-------------|-------|
| **keyword** | Fraction of user-message keywords (words >= 3 chars) found in the memory content | 0-1 |
| **recency** | `1 / (1 + daysSinceCreated)` | 0-1 |
| **importance** | `(memory.importance - 1) / 4`, mapping 1-5 to 0-1 | 0-1 |

Memories are sorted by combined score descending; top-K are selected.

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxMemories` | 10 | Maximum number of memories to inject |
| `maxTokens` | 1000 | Token budget for the memory block (estimated at 4 chars/token) |

### Injection position

The memory block is inserted as a new system message AFTER any existing system messages at the start of the conversation but BEFORE the first user message. The original system prompt is never modified.

### Return value

`injectMemories` returns `{ messages, injectedCount, totalMemories, topScore }`:
- `messages` -- the modified message array (or original if nothing was injected)
- `injectedCount` -- number of memories actually injected
- `totalMemories` -- total memories in the store for this user+workspace
- `topScore` -- the highest combined score among all scored memories

### Error handling

If the memory store throws or is unavailable, `injectMemories` returns the original messages unchanged with `injectedCount: 0`. It never fails.
