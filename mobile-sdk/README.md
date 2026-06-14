# @siskelbot/mobile-sdk

Cross-platform SDK for embedding SiskelBot in mobile and web apps.

Works in React Native, React, Vue, vanilla JavaScript, and any modern
JavaScript runtime with `fetch`. Zero runtime dependencies.

## Features

- Streaming and non-streaming chat completions
- Knowledge base search (keyword and semantic) and document CRUD
- Conversation history management
- Offline request queue with automatic flush on reconnect
- Cross-platform SSE parser (works in RN with polyfills and in browsers natively)
- Auth manager with persistent API key support
- Typed via `types.d.ts` for TypeScript consumers
- Simple event emitter (`ready`, `online`, `offline`, `queue:flushed`, `error`, ...)

## Installation

```bash
npm install @siskelbot/mobile-sdk
```

## Quick start

```js
import { SiskelBotSDK } from '@siskelbot/mobile-sdk';

const sdk = new SiskelBotSDK({
  baseUrl: 'https://your-siskelbot.com',
  apiKey: 'your-api-key',
});

await sdk.initialize();

// Non-streaming chat
const response = await sdk.chat.send('Hello!');
console.log(response.choices[0].message.content);

// Streaming chat
await sdk.chat.sendStream(
  'Hello!',
  (token) => process.stdout.write(token),
  (result) => console.log('\nDone:', result.text),
);

// Knowledge base
await sdk.knowledge.add('Notes', 'Some content to remember.');
const hits = await sdk.knowledge.search('notes');
const semantic = await sdk.knowledge.semanticSearch('what did I save earlier?');
```

## Configuration

```ts
new SiskelBotSDK({
  baseUrl: string;         // required: server URL (no trailing slash)
  apiKey?: string;         // optional: API key for authentication
  model?: string;          // default model for chat (default: 'default')
  storage?: AsyncStorage;  // AsyncStorage-compatible store for the offline queue
  fetch?: typeof fetch;    // optional fetch override (defaults to globalThis.fetch)
  onError?: (err) => void; // global error callback
  userAgent?: string;      // custom User-Agent header
  headers?: Record<string, string>; // extra headers sent on every request
});
```

If you do not pass a `storage` option:

- In the browser the SDK uses `window.localStorage` automatically.
- In React Native pass `@react-native-async-storage/async-storage`.
- In Node or unknown environments, the queue falls back to in-memory storage.

## API

### SiskelBotSDK

| Method | Description |
|--------|-------------|
| `initialize()` | Health-check the server, flush any queued requests, register online/offline listeners, emit `ready`. |
| `isReady()` | Returns `true` after `initialize()` has resolved. |
| `destroy()` | Remove listeners and stop emitting events. |
| `events` | `EventEmitter`. Emits `ready`, `connected`, `offline`, `online`, `queue:flushed`, `error`, `destroyed`. |

### ChatClient (`sdk.chat`)

| Method | Description |
|--------|-------------|
| `send(message, options?)` | Non-streaming chat. Returns OpenAI-compatible response. |
| `sendStream(message, onToken, onDone, options?)` | Streaming chat. Emits tokens as they arrive. |
| `listConversations()` | List all conversations. |
| `getConversation(id)` | Load a single conversation. |
| `createConversation(data)` | Create a new conversation. |
| `deleteConversation(id)` | Delete a conversation. |

`message` can be a string, a single `{ role, content }` object, or an array of
messages. Options support `model`, `temperature`, `maxTokens`, `conversationId`,
`system`, `history`, and `extra`.

### KnowledgeClient (`sdk.knowledge`)

| Method | Description |
|--------|-------------|
| `search(query, { limit? })` | Keyword search over the knowledge base. |
| `semanticSearch(query, { limit?, workspaceId? })` | Embedding-based search. |
| `add(title, content, metadata?)` | Add a new document. |
| `list({ limit?, offset? })` | List documents. |
| `get(id)` | Get a document. |
| `delete(id)` | Delete a document. |

### OfflineQueue (`sdk.offline`)

| Method | Description |
|--------|-------------|
| `enqueue(request)` | Queue a request for later delivery. `request.kind` can be `chat.send` or `knowledge.add`. |
| `size()` | Count of queued requests. |
| `list()` | Return all queued requests. |
| `flush()` | Drain the queue. Successful items are removed; failed items are retried on next flush. |
| `clear()` | Drop all queued requests. |

`flush()` is automatically invoked on `initialize()` and on the browser
`online` event. In React Native, call `sdk.offline.flush()` yourself when
NetInfo reports the device has reconnected.

### AuthManager (`sdk.auth`)

| Method | Description |
|--------|-------------|
| `login(apiKey)` | Set the active API key. |
| `logout()` | Clear the API key. |
| `isAuthenticated()` | Returns `true` if an API key is set. |
| `getHeaders(extra?)` | Produce headers for a request. |

## Examples

- [React Native](./examples/react-native.md)
- [Flutter (WebView wrapper)](./examples/flutter.md)
- [Web (browser / React / Vue / vanilla)](./examples/web.md)

## Tests

```bash
npm test
```

The test suite uses Node's built-in `node --test` runner with a mock
`fetch` implementation and a mock SSE response to exercise chat, streaming,
offline queueing, auth, and the full `SiskelBotSDK` lifecycle.

## TypeScript

TypeScript definitions are shipped in `types.d.ts`. No additional
`@types/...` package is needed.

## License

MIT
