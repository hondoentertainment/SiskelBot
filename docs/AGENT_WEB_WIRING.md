# Agent Web Wiring

## Subagent tool

The `spawn_subagent` tool allows any agent inside `runAgentLoop` to delegate a subtask to a child agent. The child runs its own tool-call loop with an independent iteration budget and returns a structured result.

### Tool schema

```json
{
  "name": "spawn_subagent",
  "description": "Delegate a subtask to a child agent. The child runs its own tool-call loop with its own budget and returns a structured result. Use this when a task is large enough to benefit from decomposition.",
  "parameters": {
    "type": "object",
    "properties": {
      "goal": { "type": "string", "description": "Clear statement of what the child should accomplish" },
      "profile": { "type": "string", "description": "Named profile: researcher, executor, synthesizer, code_writer, reviewer, or 'default'" },
      "model": { "type": "string", "description": "Override model for child (optional, inherits parent if omitted)" },
      "maxIterations": { "type": "number", "description": "Max iterations for child (default 10)" },
      "toolAllowlist": { "type": "array", "items": {"type":"string"}, "description": "Tools the child may use (empty = inherit parent's allowlist)" },
      "context": { "type": "string", "description": "Additional context/instructions passed as a user message to the child" }
    },
    "required": ["goal"]
  }
}
```

### Profiles

| Profile | System prompt |
|---------|--------------|
| `researcher` | You are a research agent. Search, summarize, and return structured findings. Do not execute or modify anything. |
| `executor` | You are an execution agent. Carry out the plan step by step. Report results. |
| `synthesizer` | You are a synthesis agent. Combine inputs into a coherent output. |
| `code_writer` | You are a code-writing agent. Write clean, tested code. |
| `reviewer` | You are a review agent. Analyze for correctness, security, and quality. |
| `default` | You are a focused assistant. Complete the goal and return the result. |

### Depth limit

Subagent nesting is capped at depth 3 (0, 1, 2 are allowed; depth 3 is rejected). The depth is tracked via `agentOptions.depth` in the child request and incremented on each spawn. When the limit is exceeded, the tool returns:

```json
{ "ok": false, "code": "SUBAGENT_DEPTH_EXCEEDED", "error": "Subagent nesting depth 3 exceeds maximum of 3" }
```

The `spawn_subagent` tool is always excluded from children's tool lists to prevent infinite recursion, regardless of the depth counter.

### Event shapes

Events are published on the parent session's SSE emitter via `publishAgentRunEvent`.

**`subagent.spawned`** (emitted when the child agent starts):
```json
{
  "childSessionId": "<uuid>",
  "parentRunId": "<uuid>",
  "goal": "Clear statement of what the child should accomplish",
  "profile": "researcher"
}
```

**`subagent.done`** (emitted when the child completes or errors):
```json
{
  "childSessionId": "<uuid>",
  "result": "<truncated to 2000 chars>",
  "iterations": 3,
  "toolCallCount": 5
}
```

On error:
```json
{
  "childSessionId": "<uuid>",
  "error": "Error message"
}
```

### Return value

The tool returns a JSON object to the parent agent:

```json
{
  "ok": true,
  "result": "<last assistant message from child>",
  "childSessionId": "<uuid>",
  "iterations": 3,
  "toolCallCount": 5
}
```

On failure:
```json
{
  "ok": false,
  "error": "<error message>",
  "childSessionId": "<uuid or undefined>"
}
```
