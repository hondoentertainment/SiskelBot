# SiskelBot Client SDK

JavaScript/TypeScript client SDK for the [SiskelBot](https://github.com/hondoentertainment/SiskelBot) API.

## Installation

```bash
npm install siskelbot-client
```

## Quick Start

```js
import { SiskelBotClient } from 'siskelbot-client';

const client = new SiskelBotClient('http://localhost:3000', 'your-api-key');

// Chat completion
const response = await client.chatCompletion([
  { role: 'user', content: 'Hello!' }
]);
console.log(response);

// Streaming chat completion
for await (const chunk of client.chatCompletionStream([
  { role: 'user', content: 'Tell me a story' }
])) {
  process.stdout.write(chunk.choices?.[0]?.delta?.content || '');
}
```

## API Reference

### Constructor

```js
const client = new SiskelBotClient(baseUrl, apiKey?)
```

- `baseUrl` — The SiskelBot server URL (e.g. `http://localhost:3000`)
- `apiKey` — Optional API key for authenticated endpoints

### Chat

| Method | Description |
|--------|-------------|
| `chatCompletion(messages, options?)` | Send a chat completion request |
| `chatCompletionStream(messages, options?)` | Streaming chat completion (async iterator) |

### Knowledge / Context

| Method | Description |
|--------|-------------|
| `listContext(workspace?)` | List context items |
| `searchContext(query, workspace?)` | Search context items |
| `addContext(title, content, workspace?)` | Add a context item |

### Recipes

| Method | Description |
|--------|-------------|
| `listRecipes(workspace?)` | List recipes |
| `runRecipe(name, workspace?)` | Run a recipe by name |

### Conversations

| Method | Description |
|--------|-------------|
| `listConversations(workspace?)` | List conversations |
| `getConversation(id, workspace?)` | Get a conversation by ID |
| `exportConversation(id, format?)` | Export a conversation |

### Tasks

| Method | Description |
|--------|-------------|
| `planTask(messages)` | Plan a task from messages |

### Admin

| Method | Description |
|--------|-------------|
| `getAdminSummary()` | Get admin summary |
| `getHealth()` | Get server health |
| `getConfig()` | Get server config |

### Workspaces

| Method | Description |
|--------|-------------|
| `listWorkspaces()` | List workspaces |
| `createWorkspace(data)` | Create a workspace |

### Webhooks

| Method | Description |
|--------|-------------|
| `listWebhooks(workspace?)` | List webhooks |
| `addWebhook(url, events, options?)` | Add a webhook |

### Embeddings

| Method | Description |
|--------|-------------|
| `embed(input)` | Compute embeddings for text or array of texts |

### Usage / Analytics

| Method | Description |
|--------|-------------|
| `getUsageSummary(options?)` | Get usage summary |
| `getAnalyticsDashboard(options?)` | Get analytics dashboard |

## License

MIT
