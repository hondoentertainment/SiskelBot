# SiskelBot SDK Guide

The SiskelBot JavaScript/TypeScript client SDK provides a convenient wrapper around the SiskelBot REST API. It supports chat completions (including streaming), knowledge base management, recipes, workspaces, webhooks, embeddings, and more.

## Installation

### Local (from the repository)

```bash
npm install ./sdk
```

### From npm (if published)

```bash
npm install siskelbot-client
```

### Requirements

- Node.js 18 or later (uses the built-in `fetch` API)
- Works in any environment with a global `fetch`: Node.js 18+, Deno, Bun, and modern browsers

## Quick Start

```js
import { SiskelBotClient } from "siskelbot-client";

const client = new SiskelBotClient("http://localhost:3000", "your-api-key");

// Send a chat message
const response = await client.chatCompletion([
  { role: "user", content: "Explain circuit breakers in distributed systems" }
]);

console.log(response.choices[0].message.content);
```

## Authentication

Pass your API key as the second constructor argument. The SDK sends it as a `Bearer` token in the `Authorization` header on every request.

```js
// With API key
const client = new SiskelBotClient("http://localhost:3000", "sk-your-api-key");

// Without API key (for unauthenticated endpoints like health checks)
const client = new SiskelBotClient("http://localhost:3000");
```

## Chat Completions

### Non-Streaming

```js
const response = await client.chatCompletion(
  [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What is Node.js?" }
  ],
  { model: "llama3", temperature: 0.7, max_tokens: 500 }
);

console.log(response.choices[0].message.content);
```

The options object accepts any parameter supported by the chat completions API: `model`, `temperature`, `max_tokens`, `top_p`, and backend-specific options.

### Streaming

The SDK provides an async generator for streaming responses. Each yielded chunk follows the OpenAI-compatible SSE format.

```js
const stream = client.chatCompletionStream(
  [{ role: "user", content: "Write a haiku about programming" }],
  { model: "llama3" }
);

for await (const chunk of stream) {
  const delta = chunk.choices?.[0]?.delta?.content;
  if (delta) {
    process.stdout.write(delta);
  }
}
console.log(); // newline after streaming completes
```

### Collecting a Full Streaming Response

```js
let fullContent = "";
for await (const chunk of client.chatCompletionStream(messages)) {
  const delta = chunk.choices?.[0]?.delta?.content;
  if (delta) fullContent += delta;
}
console.log(fullContent);
```

### Agent Mode

Use `planTask` to send messages with agent mode enabled:

```js
const plan = await client.planTask([
  { role: "user", content: "Research the latest Node.js release and summarize changes" }
]);
```

## Knowledge Base (Context)

### List Context Items

```js
const items = await client.listContext("my-workspace");
console.log(items);
```

### Search Context

```js
const results = await client.searchContext("deployment guide", "my-workspace");
console.log(results);
```

### Add a Context Item

```js
await client.addContext(
  "Deployment Runbook",
  "Step 1: Build the project. Step 2: Run tests. Step 3: Deploy to staging.",
  "my-workspace"
);
```

## Recipes

### List Recipes

```js
const recipes = await client.listRecipes("my-workspace");
console.log(recipes);
```

### Run a Recipe

```js
const result = await client.runRecipe("build-and-deploy", "my-workspace");
console.log(result);
```

## Conversations

### List Conversations

```js
const conversations = await client.listConversations("my-workspace");
```

### Get a Conversation

```js
const conversation = await client.getConversation("conv-123", "my-workspace");
```

### Export a Conversation

```js
// As JSON
const jsonExport = await client.exportConversation("conv-123", "json");

// As Markdown
const mdExport = await client.exportConversation("conv-123", "markdown");
```

## Workspaces

### List Workspaces

```js
const workspaces = await client.listWorkspaces();
```

### Create a Workspace

```js
const workspace = await client.createWorkspace({
  name: "My Project",
  description: "Workspace for the main project"
});
```

## Webhooks

### List Webhooks

```js
const webhooks = await client.listWebhooks("my-workspace");
```

### Add a Webhook

```js
await client.addWebhook(
  "https://example.com/webhook",
  ["recipe.completed", "chat.message"],
  { secret: "my-webhook-secret", workspace: "my-workspace" }
);
```

## Embeddings

### Compute Embeddings

```js
// Single text
const result = await client.embed("What is SiskelBot?");

// Multiple texts
const results = await client.embed([
  "First document",
  "Second document",
  "Third document"
]);
```

## Usage and Analytics

### Usage Summary

```js
const usage = await client.getUsageSummary({ days: 30, workspace: "my-workspace" });
console.log(usage);
```

### Analytics Dashboard

```js
const analytics = await client.getAnalyticsDashboard({ days: 7 });
console.log(analytics);
```

## Admin and Health

### Health Check

```js
const health = await client.getHealth();
console.log(health.status); // "ok"
```

### Server Config

```js
const config = await client.getConfig();
console.log(config.backend); // "ollama", "vllm", or "openai"
```

### Admin Summary

Requires an admin API key:

```js
const adminClient = new SiskelBotClient("http://localhost:3000", "admin-api-key");
const summary = await adminClient.getAdminSummary();
```

## Error Handling

All API methods throw an error when the server returns a non-2xx status code. The error object includes the HTTP status and response body.

```js
try {
  await client.chatCompletion([{ role: "user", content: "Hello" }]);
} catch (err) {
  console.error(`HTTP ${err.status}: ${err.body}`);

  if (err.status === 401) {
    console.error("Check your API key");
  } else if (err.status === 429) {
    console.error("Rate limited, retry after a delay");
  } else if (err.status === 503) {
    console.error("Backend unavailable (circuit breaker open)");
  }
}
```

### Streaming Errors

Streaming requests can also throw if the initial HTTP response fails:

```js
try {
  for await (const chunk of client.chatCompletionStream(messages)) {
    // process chunk
  }
} catch (err) {
  console.error("Stream error:", err.message);
}
```

## TypeScript Support

The SDK ships with TypeScript declarations in `siskelbot-client.d.ts`. Types are picked up automatically when you import the package.

```ts
import { SiskelBotClient } from "siskelbot-client";
import type { ChatMessage, ChatCompletionOptions, StreamChunk } from "siskelbot-client";

const client = new SiskelBotClient("http://localhost:3000", "sk-key");

const messages: ChatMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "Hello" }
];

const options: ChatCompletionOptions = {
  model: "llama3",
  temperature: 0.5,
  max_tokens: 1000
};

// Non-streaming (returns Promise<object>)
const response = await client.chatCompletion(messages, options);

// Streaming (returns AsyncGenerator<StreamChunk>)
for await (const chunk: StreamChunk of client.chatCompletionStream(messages, options)) {
  const text = chunk.choices?.[0]?.delta?.content ?? "";
  process.stdout.write(text);
}
```

### Available Types

| Type | Description |
|------|-------------|
| `ChatMessage` | `{ role: string; content: string }` |
| `ChatCompletionOptions` | `{ model?, temperature?, max_tokens?, ... }` |
| `StreamChunk` | SSE chunk with `choices[].delta.content` |
| `WebhookOptions` | `{ secret?, workspace? }` |
| `QueryOptions` | `{ days?, workspace?, ... }` |

## Browser Usage

The SDK works in browsers since it relies on the global `fetch` API. Include it via a bundler or use the ES module directly:

```html
<script type="module">
  import { SiskelBotClient } from "./sdk/siskelbot-client.js";

  const client = new SiskelBotClient("http://localhost:3000");
  const health = await client.getHealth();
  console.log(health);
</script>
```

## SDK Regeneration

The SDK is generated from the OpenAPI spec. To regenerate after API changes:

```bash
npm run build:sdk
```

Or directly:

```bash
node scripts/generate-sdk.mjs
node scripts/generate-sdk.mjs --typescript  # regenerate type declarations
```
