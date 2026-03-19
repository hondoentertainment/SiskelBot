# Task Schema (Action-Oriented Agent)

This document defines the JSON schema for **suggested actions** (task plans) that the LLM can output when users request task-oriented workflows. The schema supports planning only—no arbitrary code or shell execution.

## Overview

A task plan is a structured description of steps the user could take to accomplish a goal. The client displays plans in a structured view and offers "Copy" and "Execute" (placeholder) actions. Plans with `requiresApproval: true` must show a confirmation before "Execute".

## Root Schema

```json
{
  "type": "task",
  "id": "string (optional)",
  "name": "string (required)",
  "steps": [
    {
      "action": "string (required)",
      "payload": "object (optional)"
    }
  ],
  "requiresApproval": "boolean (optional, default false)"
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Must be `"task"` |
| `id` | string | no | Unique identifier for the plan (e.g. UUID) |
| `name` | string | yes | Human-readable task name |
| `steps` | array | yes | Ordered list of action steps |
| `requiresApproval` | boolean | no | If `true`, user must confirm before "Execute" |

### Step Schema

Each element in `steps`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | yes | Action type or description (e.g. `"run_command"`, `"edit_file"`, `"deploy"`) |
| `payload` | object | no | Action-specific parameters; keys and values are application-defined |

## Example

```json
{
  "type": "task",
  "id": "plan-abc123",
  "name": "Deploy frontend to production",
  "steps": [
    {
      "action": "build",
      "payload": { "command": "npm run build" }
    },
    {
      "action": "deploy",
      "payload": { "target": "vercel", "env": "production" }
    }
  ],
  "requiresApproval": true
}
```

## Validation Rules

1. `type` must be exactly `"task"`.
2. `name` must be a non-empty string.
3. `steps` must be an array with at least one element.
4. Each step must have a non-empty `action` string.
5. `payload` (if present) must be a plain object (not arrays, null, or primitives as root).
6. `requiresApproval` must be a boolean if present.

## Security

- **No execution:** The schema describes plans only. No shell or code is executed server-side.
- **Payload semantics:** `payload` is opaque; the client may display it but does not interpret it for execution.
- **Approval gate:** Plans marked `requiresApproval` require explicit user confirmation in the UI before any "Execute" action.

## API Response Shape

The `POST /v1/tasks/plan` endpoint returns:

```json
{
  "plan": { /* validated task object per schema above */ },
  "raw": "string (raw LLM response text)"
}
```

If the LLM output cannot be parsed or validated, the API returns `400 Bad Request` with an error message.
