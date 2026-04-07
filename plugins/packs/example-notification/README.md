# Example Notification Plugin

A sample SiskelBot plugin that sends webhook notifications when recipes complete. Use this as a starting point for building your own notification plugins.

## Setup

1. Set the `NOTIFICATION_WEBHOOK_URL` environment variable to your webhook endpoint:

   ```bash
   export NOTIFICATION_WEBHOOK_URL=https://hooks.slack.com/services/T00/B00/xxxx
   ```

   This works with any service that accepts JSON POST requests: Slack incoming webhooks, Discord webhooks, Zapier, Make, or your own API.

2. Enable webhook actions:

   ```bash
   export ALLOW_WEBHOOK_ACTIONS=1
   ```

3. Start (or restart) the SiskelBot server. The plugin is discovered automatically from `plugins/packs/example-notification/manifest.json`.

4. Verify the plugin appears in the marketplace:

   ```bash
   curl http://localhost:3000/api/v1/marketplace
   ```

## Installing into a Workspace

Install the plugin for your workspace via the API:

```bash
curl -X POST http://localhost:3000/api/v1/marketplace/example-notification/install \
  -H "Content-Type: application/json" \
  -d '{ "workspaceId": "my-workspace" }'
```

## Using in Recipes

Add the `notify_completion` action to a recipe step:

```json
{
  "action": "notify_completion",
  "payload": {}
}
```

To override the default message:

```json
{
  "action": "notify_completion",
  "payload": {
    "body": {
      "event": "recipe_completed",
      "message": "Build and deploy finished for project X"
    }
  }
}
```

## Customization

Edit `manifest.json` to change the default notification payload, add additional actions, or point to a different webhook URL. The `{{env.NOTIFICATION_WEBHOOK_URL}}` template references the environment variable at runtime.

## Uninstalling

```bash
curl -X DELETE "http://localhost:3000/api/v1/marketplace/example-notification/install?workspaceId=my-workspace"
```
