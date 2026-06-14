# @siskelbot/sdk

Official TypeScript SDK for [SiskelBot](https://github.com/hondoentertainment/SiskelBot).

## Install

```bash
npm install @siskelbot/sdk
```

Requires Node.js 18+ (uses the global `fetch`).

## Quick start

```typescript
import { SiskelBotClient } from "@siskelbot/sdk";

const client = new SiskelBotClient({
  baseUrl: "https://siskelbot.example.com",
  apiKey: process.env.SISKELBOT_API_KEY,
});

// One-shot chat completion
const res = await client.chat.completions({
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(res.choices[0].message.content);
```

## Streaming

```typescript
const stream = await client.chat.stream({
  messages: [{ role: "user", content: "Tell me a story." }],
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

## Error handling

All HTTP errors are thrown as `SiskelBotError`:

```typescript
import { SiskelBotError } from "@siskelbot/sdk";

try {
  await client.chat.completions({ messages: [{ role: "user", content: "hi" }] });
} catch (err) {
  if (err instanceof SiskelBotError) {
    console.error(`HTTP ${err.status} (${err.code}): ${err.message}`);
    if (err.retryable) {
      // 5xx or 429 — already retried internally up to maxRetries
    }
  }
}
```

## Retries

The client retries automatically on `5xx` and `429` responses with exponential backoff
(`2^attempt * 500ms`). Configure with `maxRetries` (default `3`).

```typescript
const client = new SiskelBotClient({
  baseUrl: "https://siskelbot.example.com",
  apiKey: "...",
  timeoutMs: 60_000,
  maxRetries: 5,
});
```

## Custom fetch

You can inject a custom `fetch` implementation (useful for testing or proxying):

```typescript
const client = new SiskelBotClient({
  baseUrl: "...",
  fetch: myCustomFetch,
});
```

## Other namespaces

```typescript
// Workspaces
const { workspaces } = await client.workspaces.list();
await client.workspaces.create({ name: "team-a", description: "Team A workspace" });

// Health
const health = await client.health.deep();
console.log(health.status); // "up" | "degraded" | "down"
```

## Building from source

```bash
cd sdk/typescript
npm install
npm run build
```

## License

MIT — see [LICENSE](./LICENSE).

## See also

- Main repo: [hondoentertainment/SiskelBot](https://github.com/hondoentertainment/SiskelBot)
- Python SDK: [`sdk/python/`](../python/)
- OpenAPI spec: regenerate with `npm run openapi:generate` from the repo root.
