# Custom JS Plugin API (Phase 17.1)

SiskelBot supports sandboxed JavaScript plugins that run in isolated worker threads. Plugins can perform custom logic on user input and return structured output.

## Plugin Contract

A plugin is a `.js` file that exports the following:

| Export | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | Yes | Unique plugin name (lowercase, no spaces recommended) |
| `version` | `string` | Yes | Semver version string (e.g. `"1.0.0"`) |
| `description` | `string` | No | Short human-readable description |
| `execute` | `function` | Yes | `async execute(context) => { output, metadata? }` |

### `execute(context)` Function

**Input — `context` object:**

| Field | Type | Description |
|-------|------|-------------|
| `input` | `string` | The user-provided input text |
| `workspaceId` | `string \| null` | Current workspace ID |
| `userId` | `string \| null` | Current user ID |
| `config` | `object` | Plugin-specific configuration |
| `fetch` | `function` | HTTPS-only fetch (10s timeout) |

**Return value:**

```js
{
  output: "string (required)",
  metadata: { /* optional object with arbitrary data */ }
}
```

- `output` (required): A string result.
- `metadata` (optional): An object with additional data (counts, flags, IDs, etc.).

## Sandbox Constraints

Plugins run in a Node.js `worker_threads` Worker with the following restrictions:

| Constraint | Default | Env Variable |
|------------|---------|--------------|
| Execution timeout | 30 seconds | `PLUGIN_TIMEOUT_MS` |
| Memory limit | 64 MB | `PLUGIN_MEMORY_MB` |

**Restricted APIs:**
- `process` is removed from the global scope
- `require()` is not available (ESM only)
- `fs`, `child_process`, and other Node.js built-ins should not be imported by plugins
- `fetch` is provided as a sandboxed wrapper (HTTPS only, 10s timeout)

## Example Plugin

```js
// plugins/examples/hello-world.plugin.js
export const name = "hello-world";
export const version = "1.0.0";
export const description = "Returns a friendly greeting";

export async function execute(context) {
  const who = context.input?.trim() || "World";
  return {
    output: `Hello, ${who}!`,
    metadata: { greeted: who },
  };
}
```

## Loading Plugins

Plugins are loaded via the API or at startup:

```js
import { loadPlugin, executePlugin } from "./lib/plugin-sandbox.js";

// Load
const meta = await loadPlugin("./plugins/examples/hello-world.plugin.js");
// meta = { id: "hello-world", name: "hello-world", version: "1.0.0", description: "..." }

// Execute
const result = await executePlugin("hello-world", { input: "Alice" });
// result = { output: "Hello, Alice!", metadata: { greeted: "Alice" } }
```

## API Endpoints

### `GET /api/plugins`

Returns the list of loaded JS plugins.

**Response:**
```json
{
  "plugins": [
    { "id": "hello-world", "name": "hello-world", "version": "1.0.0", "description": "Returns a friendly greeting" }
  ]
}
```

### `POST /api/plugins/execute`

Executes a loaded plugin with the given input.

**Request body:**
```json
{
  "pluginId": "hello-world",
  "input": "Alice",
  "workspaceId": "ws-1",
  "config": {}
}
```

**Response (success):**
```json
{
  "ok": true,
  "output": "Hello, Alice!",
  "metadata": { "greeted": "Alice" }
}
```

**Response (error):**
```json
{
  "ok": false,
  "error": "Plugin not loaded: unknown-plugin"
}
```

## Using Plugins as Recipe Actions

Plugins can be used as recipe step actions with `action: "plugin"`:

```json
{
  "action": "plugin",
  "payload": {
    "pluginId": "word-count",
    "input": "Count these words please"
  }
}
```

## Security Notes

- Plugins run in isolated worker threads with memory and time limits.
- The `process` global is removed inside the worker.
- Only HTTPS fetch is available; no filesystem or subprocess access.
- Plugin files are validated at load time (must export `name`, `version`, `execute`).
