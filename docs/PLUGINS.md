# Plugins & Extensions (Phase 17)

SiskelBot supports extensible recipe step actions via a plugin config. Built-in actions (`build`, `deploy`, `copy`) and the configurable `webhook` action can be extended with named webhook plugins and builtin aliases.

## Built-in actions

| Action | Description |
|--------|-------------|
| `build` | Run `npm run build` or `npm run <script>`. Payload: `{ cwd?, command? }` |
| `deploy` | Deploy to Vercel (deploy hook or API). Payload: `{ deployHookUrl?, project?, env? }` |
| `copy` | No-op server-side; client performs clipboard copy |
| `webhook` | POST to URL (requires `ALLOW_WEBHOOK_ACTIONS=1`). Payload: `{ url, headers?, body? }` |

## Webhook action

The `webhook` action POSTs to a URL. **Security:** Set `ALLOW_WEBHOOK_ACTIONS=1` in the environment to enable.

### Config (in recipe step payload)

```json
{
  "action": "webhook",
  "payload": {
    "url": "https://example.com/hook",
    "headers": { "X-Custom": "value" },
    "body": { "event": "deploy" }
  }
}
```

- `url` (required): HTTPS only; localhost and private IPs are rejected.
- `headers` (optional): Object merged with `Content-Type: application/json`.
- `body` (optional): Object or string; serialized as JSON if object.

### Limits

- **Rate limit:** 5 requests per minute per unique URL.
- **Audit:** All webhook calls are logged to `data/execution-audit.json`.

## Plugin config

Optionally load custom actions at startup from `plugins/config.json` or the path given by `PLUGINS_PATH` (must point to a directory containing `config.json`).

### Schema

```json
{
  "actions": [
    {
      "name": "notify-slack",
      "type": "webhook",
      "config": {
        "url": "https://hooks.slack.com/services/xxx",
        "headers": {},
        "body": { "text": "Deployment complete" }
      }
    },
    {
      "name": "ship",
      "type": "builtin",
      "config": { "target": "deploy" }
    }
  ]
}
```

- `name`: Action name (lowercase).
- `type`: `webhook` or `builtin`.
- `config`:
  - **webhook:** `url` (required), `headers`, `body`.
  - **builtin:** `target` – aliases to existing builtin (`build`, `deploy`, `copy`).

### Example: Slack notification

1. Set `ALLOW_WEBHOOK_ACTIONS=1`.
2. Create `plugins/config.json`:

```json
{
  "actions": [
    {
      "name": "notify-slack",
      "type": "webhook",
      "config": {
        "url": "https://hooks.slack.com/services/YOUR/WEBHOOK/URL",
        "body": { "text": "Recipe completed" }
      }
    }
  ]
}
```

3. Add to a recipe step: `{ "action": "notify-slack", "payload": {} }` or override body: `{ "action": "notify-slack", "payload": { "body": { "text": "Custom message" } } }`.

## API

### GET /api/plugins/actions

Returns the list of registered action names (for recipe step dropdowns).

**Response:** `{ "actions": ["build", "copy", "deploy", "webhook", ...] }`

**Auth:** Uses `userAuth` when Phase 14 auth is configured. Anonymous when not.

## Security

- **No eval**, **no require(userPath)**. Only config-driven plugins.
- **Webhooks:** HTTPS only; localhost and private IPs are rejected.
- Custom JS plugins (Phase 17.1) are not implemented yet.
