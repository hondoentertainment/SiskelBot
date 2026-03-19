# Phase 22: Event Webhooks & Notifications

SiskelBot can POST event payloads to external URLs when certain actions occur. Use webhooks to integrate with Slack, Discord, monitoring systems, or custom backends.

## Events

| Event | When emitted |
|-------|--------------|
| `message_sent` | After chat completion (streaming or agent mode) |
| `plan_created` | After `POST /v1/tasks/plan` returns 200 |
| `recipe_executed` | After `executeStep` or `POST /api/execute-step` runs |
| `schedule_completed` | After the scheduler runs a recipe |

## Payload schema

All events use this envelope:

```json
{
  "event": "message_sent",
  "timestamp": "2025-03-18T12:00:00.000Z",
  "workspaceId": "default",
  "userId": "user-1",
  "data": {}
}
```

- `event` — One of: `message_sent`, `plan_created`, `recipe_executed`, `schedule_completed`
- `timestamp` — ISO 8601
- `workspaceId` — Workspace where the action happened
- `userId` — User (when available; may be omitted)
- `data` — Event-specific payload

### `message_sent`

```json
{
  "event": "message_sent",
  "timestamp": "2025-03-18T12:00:00.000Z",
  "workspaceId": "default",
  "userId": "user-1",
  "data": {
    "content": "Assistant response text (truncated to 500 chars)...",
    "model": "llama3.2",
    "iteration": 1
  }
}
```

### `plan_created`

```json
{
  "event": "plan_created",
  "timestamp": "2025-03-18T12:00:00.000Z",
  "workspaceId": "default",
  "data": {
    "plan": { "type": "task", "name": "...", "steps": [...] },
    "raw": "Raw LLM output snippet..."
  }
}
```

### `recipe_executed`

```json
{
  "event": "recipe_executed",
  "timestamp": "2025-03-18T12:00:00.000Z",
  "workspaceId": "default",
  "data": {
    "step": { "action": "build", "payload": {} },
    "ok": true,
    "error": null
  }
}
```

### `schedule_completed`

```json
{
  "event": "schedule_completed",
  "timestamp": "2025-03-18T12:00:00.000Z",
  "workspaceId": "default",
  "data": {
    "recipeId": "uuid",
    "recipeName": "Daily build",
    "stepCount": 2
  }
}
```

## Signing (HMAC)

When you add a webhook with a secret, SiskelBot signs each POST body with HMAC-SHA256 and sends the signature in `X-Webhook-Signature: sha256=<hex>`.

Verify in your handler:

```js
const crypto = require('crypto');
const sig = req.headers['x-webhook-signature'];
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
if (sig !== expected) return res.status(401).send('Invalid signature');
```

## API

| Method | Endpoint | Auth | Description |
|--------|----------|------|--------------|
| GET | `/api/webhooks?workspace=` | userAuth | List webhooks for workspace |
| POST | `/api/webhooks` | userAuth | Add webhook `{ url, events, secret? }` |
| DELETE | `/api/webhooks/:id?workspace=` | userAuth | Remove webhook |

## Security

- **URL validation** — HTTPS only; localhost and private IPs blocked unless `ALLOW_WEBHOOK_LOCALHOST=1`
- **Rate limit** — 5 requests/min per URL (same as Phase 17)
- **Auth** — Webhook CRUD requires user auth when Phase 14 is configured

## Configuration

| Env var | Description |
|---------|--------------|
| `ALLOW_WEBHOOK_LOCALHOST=1` | Allow http://localhost and private IPs (for local dev) |

## Storage

Webhooks are stored in `data/webhooks.json`, keyed by `workspaceId`:

```json
{
  "default": [
    {
      "id": "uuid",
      "url": "https://example.com/webhook",
      "events": ["message_sent", "plan_created"],
      "workspaceId": "default",
      "createdAt": "..."
    }
  ]
}
```

Secrets are stored in the file but never returned by the API.
