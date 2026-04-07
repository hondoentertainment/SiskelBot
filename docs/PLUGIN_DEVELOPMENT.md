# Plugin Development Guide

This guide covers everything you need to build, test, publish, and manage SiskelBot plugins. Plugins extend SiskelBot with custom actions that can be used in recipes, automations, and agent workflows.

## Getting Started

### What Plugins Can Do

SiskelBot supports two plugin systems:

1. **Action packs** (marketplace plugins) -- Declarative manifests that define webhook and builtin actions. These are installed per-workspace through the marketplace.
2. **JS plugins** -- Sandboxed JavaScript modules that run in isolated worker threads. These provide custom logic beyond simple HTTP calls.

Plugins can:

- Send HTTP requests to external services when recipes complete (webhook actions)
- Alias built-in actions like `build`, `deploy`, and `copy` under custom names (builtin actions)
- Run arbitrary JavaScript logic in a sandboxed environment (JS plugins)
- Integrate with Slack, Discord, Jira, Linear, and other services via webhooks

### Plugin Structure

An action pack plugin lives in a directory under `plugins/packs/` and contains a `manifest.json` file:

```
plugins/packs/my-plugin/
  manifest.json
  README.md          (optional)
```

A JS plugin is a single `.js` file in `plugins/examples/` or any directory:

```
plugins/examples/my-plugin.plugin.js
```

### Creating a Plugin

Use the CLI to scaffold a new plugin:

```bash
siskelbot plugin create my-plugin
```

Or create the files manually. The minimum viable action pack is a directory with a valid `manifest.json`.

## Manifest Format

Every action pack plugin requires a `manifest.json` that conforms to the schema in `plugins/manifest-schema.json`.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Does something useful",
  "author": "Your Name",
  "tags": ["utility"],
  "actions": [
    {
      "name": "my_action",
      "type": "webhook",
      "config": {
        "url": "https://api.example.com/hook",
        "method": "POST",
        "headers": { "Authorization": "Bearer {{env.MY_API_KEY}}" }
      }
    }
  ]
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique identifier. Lowercase alphanumeric with hyphens only (`^[a-z0-9-]+$`). |
| `name` | `string` | Human-readable display name. |
| `version` | `string` | Semver version string (e.g. `1.0.0`). |
| `description` | `string` | Short description of what the plugin does. |
| `author` | `string` | Author name or organization. |
| `actions` | `array` | At least one action definition (see below). |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `category` | `string` | Category for marketplace filtering (e.g. `"analytics"`, `"notification"`, `"deployment"`). Defaults to `"uncategorized"`. |
| `signature` | `string` | HMAC-SHA256 signature for manifest verification (see Signing below). |

### Action Definitions

Each action in the `actions` array must have:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Action name (used in recipe steps). |
| `type` | `string` | Yes | Either `"webhook"` or `"builtin"`. |
| `config` | `object` | No | Type-specific configuration. |

## Action Types

### Webhook Actions

Webhook actions send HTTP requests to external URLs when triggered. Set `ALLOW_WEBHOOK_ACTIONS=1` in your environment to enable webhook execution.

```json
{
  "name": "notify_slack",
  "type": "webhook",
  "config": {
    "url": "https://hooks.slack.com/services/T00/B00/xxxx",
    "headers": { "Content-Type": "application/json" },
    "body": { "text": "Recipe completed successfully" }
  }
}
```

**Config fields for webhook actions:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | Yes | Target URL. Must be HTTPS. Localhost and private IPs are rejected. |
| `headers` | `object` | No | HTTP headers to include in the request. |
| `body` | `object` or `string` | No | Request body. Objects are serialized as JSON. |

**Security constraints:**

- HTTPS only; localhost and private IPs are rejected.
- Rate limited to 5 requests per minute per unique URL.
- All webhook calls are logged to the execution audit trail.

### Builtin Actions

Builtin actions create aliases for SiskelBot's built-in actions: `build`, `deploy`, and `copy`.

```json
{
  "name": "ship",
  "type": "builtin",
  "config": { "target": "deploy" }
}
```

**Config fields for builtin actions:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | `string` | Yes | The built-in action to alias. One of: `build`, `deploy`, `copy`. |

**Available builtin targets:**

| Target | Description |
|--------|-------------|
| `build` | Run `npm run build` or a custom command. Payload: `{ cwd?, command? }` |
| `deploy` | Deploy to Vercel via deploy hook or API. Payload: `{ deployHookUrl?, project?, env? }` |
| `copy` | No-op server-side; the client performs clipboard copy. |

## JS Plugins

For custom logic beyond webhooks and builtins, write a JS plugin. JS plugins run in sandboxed worker threads with memory and time limits.

### Plugin Contract

A JS plugin is a `.js` file that exports:

| Export | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | Yes | Unique plugin name |
| `version` | `string` | Yes | Semver version string |
| `description` | `string` | No | Short description |
| `execute` | `function` | Yes | `async execute(context) => { output, metadata? }` |

### Example JS Plugin

```js
// plugins/examples/word-count.plugin.js
export const name = "word-count";
export const version = "1.0.0";
export const description = "Counts words in the input text";

export async function execute(context) {
  const text = context.input || "";
  const count = text.split(/\s+/).filter(Boolean).length;
  return {
    output: `Word count: ${count}`,
    metadata: { wordCount: count },
  };
}
```

### Context Object

The `execute` function receives a context object:

| Field | Type | Description |
|-------|------|-------------|
| `input` | `string` | User-provided input text |
| `workspaceId` | `string` or `null` | Current workspace ID |
| `userId` | `string` or `null` | Current user ID |
| `config` | `object` | Plugin-specific configuration |
| `fetch` | `function` | Sandboxed HTTPS-only fetch (10s timeout) |

### Sandbox Constraints

| Constraint | Default | Environment Variable |
|------------|---------|---------------------|
| Execution timeout | 30 seconds | `PLUGIN_TIMEOUT_MS` |
| Memory limit | 64 MB | `PLUGIN_MEMORY_MB` |

Restricted APIs inside the worker:

- `process` is removed from the global scope.
- `require()` is not available (ESM only).
- `fs`, `child_process`, and other Node.js built-ins should not be imported.
- Only HTTPS fetch is available through the sandboxed wrapper.

## Plugin Lifecycle

### Marketplace Discovery

On startup, SiskelBot scans `plugins/packs/` and loads all valid manifests into the in-memory registry. Packs appear in the marketplace automatically.

### Installation

Install a pack into a workspace:

```
POST /api/v1/marketplace/:packId/install
Content-Type: application/json

{ "workspaceId": "my-workspace" }
```

**Response:**

```json
{ "ok": true, "packId": "my-plugin", "workspaceId": "my-workspace", "alreadyInstalled": false }
```

### Listing Available Packs

```
GET /api/v1/marketplace
```

Returns all discovered packs. Optionally filter by category:

```
GET /api/v1/marketplace?category=notification
```

**Response:**

```json
{
  "_version": 1,
  "packs": [
    {
      "id": "my-plugin",
      "name": "My Plugin",
      "version": "1.0.0",
      "description": "Does something useful",
      "author": "Your Name",
      "category": "uncategorized",
      "actionCount": 1
    }
  ]
}
```

### Viewing Pack Details

```
GET /api/v1/marketplace/:packId
```

Returns the full manifest with action definitions.

### Listing Installed Packs

```
GET /api/v1/workspaces/:workspaceId/plugins
```

Returns packs installed for a specific workspace.

### Uninstallation

```
DELETE /api/v1/marketplace/:packId/install
Content-Type: application/json

{ "workspaceId": "my-workspace" }
```

Or via query parameter:

```
DELETE /api/v1/marketplace/:packId/install?workspaceId=my-workspace
```

### Workspace Scope

Plugins are installed per-workspace. Different workspaces can have different sets of plugins installed. Installation data is stored in `data/marketplace-installed.json`.

## Using Plugin Actions in Recipes

Once a plugin's actions are registered, use them as recipe step actions:

```json
{
  "action": "notify_slack",
  "payload": {
    "body": { "text": "Custom message override" }
  }
}
```

For webhook actions, payload fields merge with the plugin's configured defaults. You can override `headers` and `body` at the recipe step level.

For JS plugins, use the `plugin` action type:

```json
{
  "action": "plugin",
  "payload": {
    "pluginId": "word-count",
    "input": "Count these words"
  }
}
```

## Plugin Config (Non-Marketplace)

For simpler setups without the marketplace, define actions directly in `plugins/config.json`:

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
    },
    {
      "name": "ship",
      "type": "builtin",
      "config": { "target": "deploy" }
    }
  ]
}
```

Actions defined here are loaded at startup and available globally (not scoped to a workspace).

**Integrity verification:** Set `PLUGINS_CONFIG_SHA256` to the SHA-256 hash of your `config.json` file. If the hash does not match at startup, plugins are not loaded.

```bash
# Generate the hash
sha256sum plugins/config.json
# Set in environment
export PLUGINS_CONFIG_SHA256=abc123...
```

## Publishing to a Remote Registry

### Setting Up a Registry

Set `PLUGIN_REGISTRY_URL` to point to your registry server. The registry serves an `index.json` file listing available plugins and individual manifest files under `/packs/<packId>/manifest.json`.

```bash
export PLUGIN_REGISTRY_URL=https://registry.example.com/plugins
```

### Registry Index Format

The registry must serve `index.json` at its root:

```json
{
  "version": "1.0.0",
  "updated": "2026-04-07T00:00:00Z",
  "plugins": [
    {
      "id": "my-plugin",
      "name": "My Plugin",
      "version": "1.0.0",
      "description": "Does something useful",
      "author": "Your Name",
      "tags": ["utility"],
      "checksum": "optional-hmac-sha256-hex"
    }
  ]
}
```

### Installing from a Remote Registry

```
POST /api/v1/marketplace/registry/install
Content-Type: application/json

{ "packId": "my-plugin" }
```

This fetches the manifest from the registry, validates it, saves it locally to `plugins/packs/<packId>/manifest.json`, and registers it in the in-memory registry.

### Publishing a Local Pack

Use the marketplace publish API:

```js
import { publishPack } from "./lib/plugin-marketplace.js";

const result = await publishPack("my-plugin", "https://registry.example.com/plugins", "your-auth-token");
```

The registry must accept `POST /packs` with the manifest JSON body.

### Searching the Registry

The marketplace supports searching remote plugins by name, description, or tags:

```js
import { searchRemotePlugins } from "./lib/plugin-marketplace.js";

const results = await searchRemotePlugins("notification", { tag: "slack" });
```

Registry responses are cached in memory for 5 minutes.

## Manifest Signing

For security, manifests can be signed with HMAC-SHA256. Set `PLUGIN_SIGNING_KEY` in your environment.

### Signing a Manifest

```js
import { signManifest } from "./lib/plugin-marketplace.js";

const manifest = { id: "my-plugin", name: "My Plugin", /* ... */ };
const signature = signManifest(manifest, process.env.PLUGIN_SIGNING_KEY);
manifest.signature = signature;
```

### Verification

When a pack with a `signature` field is discovered at startup, SiskelBot verifies it against `PLUGIN_SIGNING_KEY`. If the signature does not match, the pack is not loaded.

If `PLUGIN_SIGNING_KEY` is not set, signature verification is skipped with a warning.

## API Reference

### Action Pack / Marketplace Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/marketplace` | List all available packs |
| `GET` | `/api/v1/marketplace/:packId` | Get pack details |
| `POST` | `/api/v1/marketplace/:packId/install` | Install a pack into a workspace |
| `DELETE` | `/api/v1/marketplace/:packId/install` | Uninstall a pack from a workspace |
| `GET` | `/api/v1/workspaces/:id/plugins` | List installed packs for a workspace |
| `GET` | `/api/v1/plugins/actions` | List all registered action names |

### JS Plugin Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/plugins` | List loaded JS plugins |
| `POST` | `/api/v1/plugins/execute` | Execute a JS plugin |

All endpoints also exist under the legacy `/api/` prefix (returns `X-API-Deprecated: use /api/v1/` header).

## Best Practices

- **Keep manifests small.** Only include the actions your plugin needs. Avoid large inline `body` payloads.
- **Use HTTPS for webhook URLs.** HTTP and localhost URLs are rejected for security.
- **Include clear descriptions.** Both the top-level `description` and individual action names should be self-explanatory.
- **Version with semver.** Follow semantic versioning: bump the major version for breaking changes, minor for new features, patch for fixes.
- **Set a category.** Categorize your plugin (`notification`, `deployment`, `analytics`, `utility`, etc.) so users can find it in the marketplace.
- **Sign production manifests.** Use `PLUGIN_SIGNING_KEY` and include a `signature` field to prevent tampering.
- **Test locally first.** Place your plugin in `plugins/packs/` and restart the server. Verify it appears in `GET /api/v1/marketplace` before publishing.
- **Scope JS plugins carefully.** JS plugins run in a sandbox but should still follow the principle of least privilege. Only use `fetch` for necessary external calls.
- **Handle errors gracefully.** JS plugins should catch exceptions and return meaningful error messages in the `output` field rather than throwing unhandled errors.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Pack not appearing in marketplace | Invalid `manifest.json` | Check server logs for validation errors. Verify required fields and `id` format. |
| Webhook action not firing | `ALLOW_WEBHOOK_ACTIONS=1` not set | Add `ALLOW_WEBHOOK_ACTIONS=1` to your environment. |
| Signature mismatch on startup | `PLUGIN_SIGNING_KEY` changed or manifest modified | Re-sign the manifest or update the signing key. |
| JS plugin timeout | Execution exceeds 30s default | Increase `PLUGIN_TIMEOUT_MS` or optimize the plugin. |
| JS plugin memory error | Exceeds 64 MB default | Increase `PLUGIN_MEMORY_MB` or reduce memory usage. |
| Config plugins not loading | SHA-256 mismatch | Regenerate `PLUGINS_CONFIG_SHA256` after editing `plugins/config.json`. |
