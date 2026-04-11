# SiskelBot API Cookbook

Practical curl examples for the most common operations. All examples assume the server is running on `http://localhost:3000`. If you configured an `API_KEY`, add `-H "Authorization: Bearer YOUR_KEY"` to each request.

Routes are available at both `/api/v1/` (current) and `/api/` (legacy, deprecated). This cookbook uses `/api/v1/` throughout.

---

## Chat

### 1. Basic chat completion

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3",
    "messages": [
      { "role": "user", "content": "What is the capital of France?" }
    ]
  }'
```

**Expected response:**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "The capital of France is Paris." },
      "finish_reason": "stop"
    }
  ]
}
```

### 2. Streaming chat

Set `"stream": true` to receive Server-Sent Events:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3",
    "messages": [
      { "role": "user", "content": "Write a haiku about code." }
    ],
    "stream": true
  }'
```

**Expected response:** Each chunk arrives as an SSE line:

```
data: {"choices":[{"delta":{"content":"Lines "},"index":0}]}

data: {"choices":[{"delta":{"content":"of logic "},"index":0}]}

data: [DONE]
```

### 3. Chat with a specific model

Pass the model name to route to a specific model on your backend:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codellama:13b",
    "messages": [
      { "role": "user", "content": "Write a Python function to reverse a string." }
    ]
  }'
```

**Note:** The model must be available on your configured backend (e.g., pulled in Ollama).

### 4. Agent mode (tool loop)

Agent mode lets the LLM call tools (search knowledge, list recipes, execute steps, etc.) in a loop until it produces a final text answer:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3",
    "messages": [
      { "role": "user", "content": "Look up our knowledge base for deployment instructions and summarize them." }
    ],
    "agentMode": true,
    "agentOptions": {
      "workspace": "default",
      "maxIterations": 5
    }
  }'
```

**Response headers of interest:**
- `X-Agent-Iteration` -- number of tool-call rounds used
- `X-Agent-Run-Id` -- unique identifier for this agent run

**Response body:** SSE stream with `agent_activity` events showing tool calls, followed by the final answer.

### 5. Swarm mode (multi-agent)

Swarm mode dispatches your request to specialist agents (researcher, executor, synthesizer) that run in parallel:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3",
    "messages": [
      { "role": "user", "content": "Research our knowledge base about deployment, then create a step-by-step checklist." }
    ],
    "agentMode": true,
    "swarmMode": true,
    "agentOptions": {
      "workspace": "default",
      "maxIterations": 5
    }
  }'
```

**Note:** Requires `ENABLE_AGENT_SWARM=1` in your `.env`.

---

## Knowledge

### 6. Add a document

```bash
curl -X POST http://localhost:3000/api/v1/context \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Deployment Guide",
    "content": "Step 1: Pull the image. Step 2: Run docker compose up. Step 3: Verify health endpoint."
  }'
```

**Expected response (201):**

```json
{
  "id": "a1b2c3d4-...",
  "title": "Deployment Guide",
  "content": "Step 1: Pull the image. Step 2: Run docker compose up...",
  "createdAt": "2026-04-10T12:00:00.000Z"
}
```

### 7. List all documents

```bash
curl http://localhost:3000/api/v1/context?workspace=default
```

**Expected response:**

```json
{
  "_version": 1,
  "items": [
    { "id": "a1b2c3d4-...", "title": "Deployment Guide", "content": "...", "createdAt": "..." }
  ]
}
```

### 8. Search documents (keyword)

```bash
curl "http://localhost:3000/api/v1/knowledge/search?q=deployment&workspace=default"
```

**Expected response:**

```json
{
  "items": [
    { "id": "a1b2c3d4-...", "title": "Deployment Guide", "score": 0.85, "snippet": "...deployment..." }
  ]
}
```

### 9. Search documents (semantic)

Requires `OPENAI_API_KEY` for embedding generation:

```bash
curl "http://localhost:3000/api/v1/knowledge/search?q=how+to+ship+code&workspace=default&semantic=1"
```

### 10. Hybrid search

Combines keyword and semantic ranking. Supports `mode=hybrid`, `mode=keyword`, or `mode=semantic`:

```bash
curl "http://localhost:3000/api/v1/knowledge/search?q=deploy+to+production&workspace=default&mode=hybrid&limit=5"
```

**Expected response:**

```json
{
  "items": [...],
  "mode": "hybrid",
  "keywordCount": 3,
  "semanticCount": 4
}
```

### 11. Index a document with embeddings

Index a document into the knowledge store and compute its embedding vector in one call:

```bash
curl -X POST http://localhost:3000/api/v1/knowledge/index \
  -H "Content-Type: application/json" \
  -d '{
    "text": "SiskelBot supports three LLM backends: Ollama, vLLM, and OpenAI.",
    "title": "Backend Overview",
    "workspace": "default",
    "computeEmbedding": true
  }'
```

---

## Recipes & Workflows

### 12. Create a recipe

```bash
curl -X POST http://localhost:3000/api/v1/recipes \
  -H "Content-Type: application/json" \
  -d '{
    "name": "deploy-staging",
    "description": "Deploy to staging environment",
    "steps": [
      { "action": "build", "target": "frontend" },
      { "action": "deploy", "target": "staging", "args": { "region": "us-east-1" } }
    ]
  }'
```

**Expected response (201):**

```json
{
  "id": "r1b2c3d4-...",
  "name": "deploy-staging",
  "description": "Deploy to staging environment",
  "steps": [...],
  "createdAt": "2026-04-10T12:00:00.000Z"
}
```

### 13. List recipes

```bash
curl http://localhost:3000/api/v1/recipes?workspace=default
```

### 14. Run a recipe step

```bash
curl -X POST http://localhost:3000/api/v1/execute \
  -H "Content-Type: application/json" \
  -d '{
    "action": "build",
    "target": "frontend",
    "workspace": "default"
  }'
```

### 15. Create a workflow

Workflows are DAG-based pipelines where nodes can have dependencies:

```bash
curl -X POST http://localhost:3000/api/v1/workflows \
  -H "Content-Type: application/json" \
  -H "X-Workspace-Id: default" \
  -d '{
    "name": "CI Pipeline",
    "nodes": [
      { "id": "lint", "type": "action", "action": "build", "target": "lint" },
      { "id": "test", "type": "action", "action": "build", "target": "test", "dependsOn": ["lint"] },
      { "id": "deploy", "type": "action", "action": "deploy", "target": "staging", "dependsOn": ["test"] }
    ]
  }'
```

**Expected response (201):**

```json
{
  "ok": true,
  "workflow": {
    "id": "wf-abc123",
    "name": "CI Pipeline",
    "nodes": [...],
    "createdAt": "..."
  }
}
```

### 16. Execute a workflow with variables

```bash
curl -X POST http://localhost:3000/api/v1/workflows/wf-abc123/run \
  -H "Content-Type: application/json" \
  -H "X-Workspace-Id: default" \
  -d '{
    "variables": {
      "environment": "staging",
      "version": "1.2.3"
    },
    "triggeredBy": "manual"
  }'
```

**Expected response:**

```json
{
  "ok": true,
  "run": {
    "runId": "run-xyz789",
    "workflowId": "wf-abc123",
    "status": "running",
    "startedAt": "..."
  }
}
```

### 17. Check workflow run status

```bash
curl http://localhost:3000/api/v1/workflows/runs/run-xyz789 \
  -H "X-Workspace-Id: default"
```

---

## Agent Memory

### 18. Store a memory

```bash
curl -X POST http://localhost:3000/api/v1/memory \
  -H "Content-Type: application/json" \
  -d '{
    "workspace": "default",
    "content": "The production database is on db-prod-01.internal",
    "category": "infrastructure",
    "importance": 8
  }'
```

**Expected response (201):**

```json
{
  "id": "mem-abc123",
  "content": "The production database is on db-prod-01.internal",
  "category": "infrastructure",
  "importance": 8,
  "createdAt": "..."
}
```

### 19. List memories

```bash
curl "http://localhost:3000/api/v1/memory?workspace=default&category=infrastructure&limit=10"
```

**Expected response:**

```json
{
  "_version": 1,
  "items": [
    { "id": "mem-abc123", "content": "...", "category": "infrastructure", "importance": 8 }
  ],
  "total": 1
}
```

### 20. Search memories

```bash
curl "http://localhost:3000/api/v1/memory/search?q=database&workspace=default&minImportance=5"
```

**Expected response:**

```json
{
  "_version": 1,
  "items": [
    { "id": "mem-abc123", "content": "The production database is on db-prod-01.internal", "score": 0.92 }
  ]
}
```

### 21. Get memory stats

```bash
curl "http://localhost:3000/api/v1/memory/stats?workspace=default"
```

**Expected response:**

```json
{
  "totalMemories": 12,
  "categories": { "infrastructure": 3, "process": 5, "general": 4 },
  "avgImportance": 6.5
}
```

---

## Workspaces & Teams

### 22. Create a workspace

```bash
curl -X POST http://localhost:3000/api/v1/workspaces \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "name": "Engineering",
    "type": "team"
  }'
```

**Expected response (201):**

```json
{
  "id": "ws-abc123",
  "name": "Engineering",
  "type": "team",
  "createdAt": "..."
}
```

**Note:** `type` can be `"personal"` (default) or `"team"`.

### 23. List workspaces

```bash
curl http://localhost:3000/api/v1/workspaces \
  -H "Authorization: Bearer YOUR_KEY"
```

### 24. Invite a team member

Generate an invite code for a team workspace:

```bash
curl -X POST http://localhost:3000/api/v1/workspaces/ws-abc123/invite \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "expiresInHours": 48,
    "maxUses": 10
  }'
```

**Expected response (201):**

```json
{
  "code": "INV-a1b2c3",
  "inviteLink": "http://localhost:3000?join=INV-a1b2c3",
  "expiresAt": "2026-04-12T12:00:00.000Z",
  "maxUses": 10
}
```

### 25. Join a workspace with invite code

```bash
curl -X POST http://localhost:3000/api/v1/workspaces/join \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{
    "code": "INV-a1b2c3"
  }'
```

### 26. List workspace members

```bash
curl http://localhost:3000/api/v1/workspaces/ws-abc123/members \
  -H "Authorization: Bearer YOUR_KEY"
```

**Expected response:**

```json
{
  "ownerId": "user-001",
  "members": [
    { "userId": "user-001", "role": "admin", "joinedAt": "..." },
    { "userId": "user-002", "role": "member", "joinedAt": "..." }
  ]
}
```

---

## Admin

All admin endpoints require the `ADMIN_API_KEY` header.

### 27. Get admin summary

```bash
curl http://localhost:3000/api/admin/summary \
  -H "Authorization: Bearer ADMIN_SECRET"
```

**Expected response:**

```json
{
  "users": [...],
  "workspaces": [...],
  "usage": { "totalTokens": 150000, "totalRequests": 42 },
  "auditLog": [...],
  "apiKeys": [...],
  "system": { "health": { "status": "ok" }, "quotaConfigured": false }
}
```

### 28. Create an API key

```bash
curl -X POST http://localhost:3000/api/admin/keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ADMIN_SECRET" \
  -d '{
    "userId": "dev-team",
    "scopes": ["read", "write"]
  }'
```

**Expected response (201):**

```json
{
  "ok": true,
  "key": "sk-generated-key-here",
  "userId": "dev-team",
  "scopes": ["read", "write"]
}
```

**Important:** Save the `key` value -- it is not retrievable after creation.

### 29. Revoke an API key

```bash
curl -X DELETE http://localhost:3000/api/admin/keys/sk-generated-key-here \
  -H "Authorization: Bearer ADMIN_SECRET"
```

**Expected response:** `204 No Content`

### 30. Get usage summary

```bash
curl "http://localhost:3000/api/v1/usage/summary?days=7&workspace=default"
```

**Expected response:**

```json
{
  "totalTokens": 150000,
  "totalRequests": 42,
  "dailyBreakdown": [...],
  "quota": {
    "limit": 100000,
    "used": 50000,
    "remaining": 50000,
    "resetAt": "2026-05-01T00:00:00.000Z"
  }
}
```

### 31. Set a quota override

Override the default token quota for a specific workspace:

```bash
curl -X POST http://localhost:3000/api/admin/quotas/override \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ADMIN_SECRET" \
  -d '{
    "workspace": "engineering",
    "limit": 500000
  }'
```

**Note:** Pass `"limit": null` to remove the override and revert to the default.

---

## Search

### 32. Unified search

Search across conversations and knowledge simultaneously:

```bash
curl "http://localhost:3000/api/v1/search?q=deployment&type=all&limit=20&workspace=default"
```

**Parameters:**
- `type` -- `all` (default), `conversations`, or `knowledge`
- `limit` -- max results (1-100, default 20)
- `offset` -- pagination offset
- `dateFrom`, `dateTo` -- ISO date range filters

---

## Webhooks

### 33. Register a webhook

```bash
curl -X POST http://localhost:3000/api/v1/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/webhook",
    "events": ["message_sent", "recipe_executed"],
    "secret": "my-webhook-secret",
    "workspace": "default"
  }'
```

**Expected response (201):**

```json
{
  "id": "wh-abc123",
  "url": "https://example.com/webhook",
  "events": ["message_sent", "recipe_executed"],
  "createdAt": "..."
}
```

**Supported events:** `message_sent`, `plan_created`, `recipe_executed`, `schedule_completed`

**Note:** Webhook URLs must use HTTPS unless `ALLOW_WEBHOOK_LOCALHOST=1` is set.

### 34. List webhooks

```bash
curl "http://localhost:3000/api/v1/webhooks?workspace=default"
```

---

## Integrations

### 35. Check integration status

See which integrations are configured:

```bash
curl http://localhost:3000/api/v1/integrations/status
```

**Expected response:**

```json
{
  "github": true,
  "vercel": false,
  "email": true,
  "jira": true,
  "linear": false,
  "slack": true,
  "discord": false
}
```

### 36. Send a test email

Requires SMTP configuration (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`):

```bash
curl -X POST http://localhost:3000/api/v1/integrations/email/test \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ADMIN_SECRET" \
  -d '{
    "to": "team@example.com"
  }'
```

**Expected response:**

```json
{
  "ok": true,
  "messageId": "<abc123@mail.example.com>"
}
```

### 37. Create a Jira issue

Requires `JIRA_URL`, `JIRA_API_TOKEN`, `JIRA_EMAIL`:

```bash
curl -X POST http://localhost:3000/api/v1/integrations/jira/issues \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ADMIN_SECRET" \
  -d '{
    "projectKey": "ENG",
    "summary": "Fix login timeout bug",
    "description": "Users report 30-second timeout on the login page.",
    "issueType": "Bug",
    "priority": "High",
    "labels": ["backend", "auth"]
  }'
```

**Expected response (201):**

```json
{
  "id": "10042",
  "key": "ENG-123",
  "self": "https://your-org.atlassian.net/rest/api/2/issue/10042"
}
```

### 38. Search Jira issues

```bash
curl "http://localhost:3000/api/v1/integrations/jira/search?jql=project%3DENG+AND+status%3DOpen" \
  -H "Authorization: Bearer ADMIN_SECRET"
```

### 39. Create a Linear issue

Requires `LINEAR_API_KEY`:

```bash
curl -X POST http://localhost:3000/api/v1/integrations/linear/issues \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ADMIN_SECRET" \
  -d '{
    "title": "Implement caching layer",
    "description": "Add Redis caching for knowledge search results.",
    "priority": 2
  }'
```

**Expected response (201):**

```json
{
  "id": "lin-abc123",
  "title": "Implement caching layer",
  "url": "https://linear.app/team/issue/LIN-42"
}
```

---

## Conversations

### 40. List conversations

```bash
curl "http://localhost:3000/api/v1/conversations?workspace=default" \
  -H "Authorization: Bearer YOUR_KEY"
```

### 41. Search conversations

```bash
curl "http://localhost:3000/api/v1/search?q=deployment&type=conversations&workspace=default"
```

---

## Embeddings

### 42. Generate embeddings

Requires `OPENAI_API_KEY`:

```bash
curl -X POST http://localhost:3000/api/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "text": "SiskelBot is an AI assistant proxy."
  }'
```

**Expected response:**

```json
{
  "embedding": [0.0123, -0.0456, 0.0789, ...]
}
```

Batch mode:

```bash
curl -X POST http://localhost:3000/api/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "texts": ["First document", "Second document"]
  }'
```

---

## Health & Monitoring

### 43. Health check

```bash
curl http://localhost:3000/health
```

**Expected response:**

```json
{
  "status": "ok"
}
```

### 44. Analytics dashboard

```bash
curl "http://localhost:3000/api/v1/analytics/dashboard?days=7&workspace=default"
```

---

## CLI Equivalents

Many API operations are also available via the CLI:

```bash
# Chat
npx siskelbot chat "Hello, world!"

# Agent mode
npx siskelbot chat "Search our docs" --agent

# Swarm mode
npx siskelbot chat "Research and summarize" --swarm

# Knowledge
npx siskelbot context list
npx siskelbot context add --file ./README.md

# Recipes
npx siskelbot recipes list
npx siskelbot recipes run deploy-staging

# Search
npx siskelbot search "deployment"

# Health
npx siskelbot health

# Admin
npx siskelbot admin users
```

---

## Error Handling

All error responses follow a consistent format:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE",
  "hint": "Suggestion for fixing the problem"
}
```

Common error codes:

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `INVALID_INPUT` | 400 | Missing or malformed request body |
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `FORBIDDEN` | 403 | Insufficient permissions or scopes |
| `NOT_FOUND` | 404 | Resource does not exist |
| `RATE_LIMITED` | 429 | Too many requests -- wait and retry |
| `QUOTA_EXCEEDED` | 429 | Workspace token quota exhausted |
| `INTERNAL_ERROR` | 500 | Server error -- check logs |
| `BACKEND_UNREACHABLE` | 502 | LLM backend not responding |
| `INTEGRATION_UNAVAILABLE` | 503 | Integration not configured |

---

## API Versioning

| Prefix | Status |
|--------|--------|
| `/api/` | Legacy -- returns `X-API-Deprecated: use /api/v1/` header |
| `/api/v1/` | Current stable API |
| `/api/v2/` | Next-generation with structured errors, stricter validation |

The chat endpoint lives at `/v1/chat/completions` (no `/api/` prefix) for OpenAI compatibility.
