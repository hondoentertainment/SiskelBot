#!/usr/bin/env node
/**
 * SDK Generation Script — generates a typed JavaScript client SDK from the OpenAPI spec.
 *
 * Usage: node scripts/generate-sdk.mjs [--output=sdk/] [--typescript]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const outputArg = args.find((a) => a.startsWith('--output='));
const outputDir = resolve(ROOT, outputArg ? outputArg.split('=')[1] : 'sdk');
// const _generateTS = args.includes('--typescript');

// Load the OpenAPI spec
let spec;
try {
  const mod = await import(resolve(ROOT, 'lib/openapi-spec.js'));
  spec = mod.default || mod;
} catch (err) {
  console.error('[generate-sdk] Could not load OpenAPI spec:', err.message);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

// ---------------------------------------------------------------------------
// Generate siskelbot-client.js
// ---------------------------------------------------------------------------
const clientJS = `/**
 * SiskelBot JavaScript Client SDK
 * Generated from OpenAPI spec v${spec.info?.version || '1.0.0'}
 * Do not edit by hand — regenerate with: node scripts/generate-sdk.mjs
 */

export class SiskelBotClient {
  /**
   * @param {string} baseUrl - The base URL of the SiskelBot server (e.g. "http://localhost:3000")
   * @param {string} [apiKey] - Optional API key for authentication
   */
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl.replace(/\\/+$/, '');
    this.apiKey = apiKey || null;
  }

  /** @private */
  _headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (this.apiKey) h['Authorization'] = 'Bearer ' + this.apiKey;
    return h;
  }

  /** @private */
  async _request(method, path, body, query) {
    let url = this.baseUrl + path;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += '?' + qs;
    }
    const opts = { method, headers: this._headers() };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(\`SiskelBot API error \${res.status}: \${text}\`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  // ---- Chat ----

  /**
   * Send a chat completion request.
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} [options] - model, temperature, max_tokens, etc.
   * @returns {Promise<object>}
   */
  async chatCompletion(messages, options = {}) {
    return this._request('POST', '/v1/chat/completions', { messages, stream: false, ...options });
  }

  /**
   * Send a streaming chat completion request. Returns an async iterator of SSE data objects.
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} [options]
   * @returns {AsyncGenerator<object>}
   */
  async *chatCompletionStream(messages, options = {}) {
    let url = this.baseUrl + '/v1/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ messages, stream: true, ...options }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(\`SiskelBot API error \${res.status}: \${text}\`);
      err.status = res.status;
      throw err;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;
          try { yield JSON.parse(data); } catch { /* skip */ }
        }
      }
    }
  }

  // ---- Knowledge / Context ----

  /**
   * List context items.
   * @param {string} [workspace]
   * @returns {Promise<object>}
   */
  async listContext(workspace) {
    return this._request('GET', '/api/v1/context', undefined, { workspace });
  }

  /**
   * Search context items.
   * @param {string} query
   * @param {string} [workspace]
   * @returns {Promise<object>}
   */
  async searchContext(query, workspace) {
    return this._request('GET', '/api/v1/context', undefined, { q: query, workspace });
  }

  /**
   * Add a context item.
   * @param {string} title
   * @param {string} content
   * @param {string} [workspace]
   * @returns {Promise<object>}
   */
  async addContext(title, content, workspace) {
    return this._request('POST', '/api/v1/context', { title, content, workspace });
  }

  // ---- Recipes ----

  /**
   * List recipes.
   * @param {string} [workspace]
   * @returns {Promise<object>}
   */
  async listRecipes(workspace) {
    return this._request('GET', '/api/v1/recipes', undefined, { workspace });
  }

  /**
   * Run (execute) a recipe by name.
   * @param {string} name
   * @param {string} [workspace]
   * @returns {Promise<object>}
   */
  async runRecipe(name, workspace) {
    return this._request('POST', '/api/v1/execute-step', { step: { action: 'run_recipe', recipe: name }, allowExecution: true, workspace });
  }

  // ---- Conversations ----

  /**
   * List conversations.
   * @param {string} [workspace]
   * @returns {Promise<object>}
   */
  async listConversations(workspace) {
    return this._request('GET', '/api/v1/conversations', undefined, { workspace });
  }

  /**
   * Get a conversation by ID.
   * @param {string} id
   * @param {string} [workspace]
   * @returns {Promise<object>}
   */
  async getConversation(id, workspace) {
    return this._request('GET', \`/api/v1/conversations/\${encodeURIComponent(id)}\`, undefined, { workspace });
  }

  /**
   * Export a conversation.
   * @param {string} id
   * @param {string} [format] - e.g. "json", "markdown"
   * @returns {Promise<object|string>}
   */
  async exportConversation(id, format) {
    return this._request('GET', \`/api/v1/conversations/\${encodeURIComponent(id)}/export\`, undefined, { format });
  }

  // ---- Tasks ----

  /**
   * Plan a task from messages.
   * @param {Array<{role: string, content: string}>} messages
   * @returns {Promise<object>}
   */
  async planTask(messages) {
    return this._request('POST', '/v1/chat/completions', { messages, stream: false, agentMode: true });
  }

  // ---- Admin ----

  /**
   * Get admin summary.
   * @returns {Promise<object>}
   */
  async getAdminSummary() {
    return this._request('GET', '/api/v1/admin/summary');
  }

  /**
   * Get server health.
   * @returns {Promise<object>}
   */
  async getHealth() {
    return this._request('GET', '/api/v1/health');
  }

  /**
   * Get server config.
   * @returns {Promise<object>}
   */
  async getConfig() {
    return this._request('GET', '/api/v1/config');
  }

  // ---- Workspaces ----

  /**
   * List workspaces.
   * @returns {Promise<object>}
   */
  async listWorkspaces() {
    return this._request('GET', '/api/v1/workspaces');
  }

  /**
   * Create a workspace.
   * @param {object} data
   * @returns {Promise<object>}
   */
  async createWorkspace(data) {
    return this._request('POST', '/api/v1/workspaces', data);
  }

  // ---- Webhooks ----

  /**
   * List webhooks.
   * @param {string} [workspace]
   * @returns {Promise<object>}
   */
  async listWebhooks(workspace) {
    return this._request('GET', '/api/v1/webhooks', undefined, { workspace });
  }

  /**
   * Add a webhook.
   * @param {string} url
   * @param {string[]} events
   * @param {object} [options] - secret, workspace
   * @returns {Promise<object>}
   */
  async addWebhook(url, events, options = {}) {
    return this._request('POST', '/api/v1/webhooks', { url, events, ...options });
  }

  // ---- Embeddings ----

  /**
   * Compute embeddings for text.
   * @param {string|string[]} input - A single string or array of strings
   * @returns {Promise<object>}
   */
  async embed(input) {
    const body = Array.isArray(input) ? { texts: input } : { text: input };
    return this._request('POST', '/api/v1/embeddings', body);
  }

  // ---- Usage / Analytics ----

  /**
   * Get usage summary.
   * @param {object} [options] - days, workspace
   * @returns {Promise<object>}
   */
  async getUsageSummary(options = {}) {
    return this._request('GET', '/api/v1/usage/summary', undefined, options);
  }

  /**
   * Get analytics dashboard.
   * @param {object} [options] - days, workspace
   * @returns {Promise<object>}
   */
  async getAnalyticsDashboard(options = {}) {
    return this._request('GET', '/api/v1/analytics/dashboard', undefined, options);
  }
}

export default SiskelBotClient;
`;

writeFileSync(resolve(outputDir, 'siskelbot-client.js'), clientJS);
console.log('[generate-sdk] Written siskelbot-client.js');

// ---------------------------------------------------------------------------
// Generate TypeScript declarations
// ---------------------------------------------------------------------------
const clientDTS = `/**
 * SiskelBot JavaScript Client SDK — TypeScript declarations
 * Generated from OpenAPI spec v${spec.info?.version || '1.0.0'}
 * Do not edit by hand — regenerate with: node scripts/generate-sdk.mjs --typescript
 */

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  [key: string]: unknown;
}

export interface StreamChunk {
  id?: string;
  object?: string;
  choices?: Array<{
    delta?: { role?: string; content?: string };
    finish_reason?: string | null;
    index?: number;
  }>;
  [key: string]: unknown;
}

export interface WebhookOptions {
  secret?: string;
  workspace?: string;
}

export interface QueryOptions {
  days?: number;
  workspace?: string;
  [key: string]: unknown;
}

export declare class SiskelBotClient {
  baseUrl: string;
  apiKey: string | null;

  constructor(baseUrl: string, apiKey?: string);

  // Chat
  chatCompletion(messages: ChatMessage[], options?: ChatCompletionOptions): Promise<object>;
  chatCompletionStream(messages: ChatMessage[], options?: ChatCompletionOptions): AsyncGenerator<StreamChunk>;

  // Knowledge / Context
  listContext(workspace?: string): Promise<object>;
  searchContext(query: string, workspace?: string): Promise<object>;
  addContext(title: string, content: string, workspace?: string): Promise<object>;

  // Recipes
  listRecipes(workspace?: string): Promise<object>;
  runRecipe(name: string, workspace?: string): Promise<object>;

  // Conversations
  listConversations(workspace?: string): Promise<object>;
  getConversation(id: string, workspace?: string): Promise<object>;
  exportConversation(id: string, format?: string): Promise<object | string>;

  // Tasks
  planTask(messages: ChatMessage[]): Promise<object>;

  // Admin
  getAdminSummary(): Promise<object>;
  getHealth(): Promise<object>;
  getConfig(): Promise<object>;

  // Workspaces
  listWorkspaces(): Promise<object>;
  createWorkspace(data: object): Promise<object>;

  // Webhooks
  listWebhooks(workspace?: string): Promise<object>;
  addWebhook(url: string, events: string[], options?: WebhookOptions): Promise<object>;

  // Embeddings
  embed(input: string | string[]): Promise<object>;

  // Usage / Analytics
  getUsageSummary(options?: QueryOptions): Promise<object>;
  getAnalyticsDashboard(options?: QueryOptions): Promise<object>;
}

export default SiskelBotClient;
`;

writeFileSync(resolve(outputDir, 'siskelbot-client.d.ts'), clientDTS);
console.log('[generate-sdk] Written siskelbot-client.d.ts');

// ---------------------------------------------------------------------------
// Generate package.json
// ---------------------------------------------------------------------------
const pkgJSON = {
  name: 'siskelbot-client',
  version: spec.info?.version || '1.0.0',
  description: 'JavaScript/TypeScript client SDK for the SiskelBot API',
  type: 'module',
  main: 'siskelbot-client.js',
  types: 'siskelbot-client.d.ts',
  exports: {
    '.': {
      import: './siskelbot-client.js',
      types: './siskelbot-client.d.ts',
    },
  },
  files: ['siskelbot-client.js', 'siskelbot-client.d.ts', 'README.md'],
  keywords: ['siskelbot', 'api', 'client', 'sdk', 'openai', 'ollama', 'vllm'],
  license: 'MIT',
  engines: { node: '>=18' },
};

writeFileSync(resolve(outputDir, 'package.json'), JSON.stringify(pkgJSON, null, 2) + '\n');
console.log('[generate-sdk] Written package.json');

// ---------------------------------------------------------------------------
// Generate README.md
// ---------------------------------------------------------------------------
const readme = `# SiskelBot Client SDK

JavaScript/TypeScript client SDK for the [SiskelBot](https://github.com/hondoentertainment/SiskelBot) API.

## Installation

\`\`\`bash
npm install siskelbot-client
\`\`\`

## Quick Start

\`\`\`js
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
\`\`\`

## API Reference

### Constructor

\`\`\`js
const client = new SiskelBotClient(baseUrl, apiKey?)
\`\`\`

- \`baseUrl\` — The SiskelBot server URL (e.g. \`http://localhost:3000\`)
- \`apiKey\` — Optional API key for authenticated endpoints

### Chat

| Method | Description |
|--------|-------------|
| \`chatCompletion(messages, options?)\` | Send a chat completion request |
| \`chatCompletionStream(messages, options?)\` | Streaming chat completion (async iterator) |

### Knowledge / Context

| Method | Description |
|--------|-------------|
| \`listContext(workspace?)\` | List context items |
| \`searchContext(query, workspace?)\` | Search context items |
| \`addContext(title, content, workspace?)\` | Add a context item |

### Recipes

| Method | Description |
|--------|-------------|
| \`listRecipes(workspace?)\` | List recipes |
| \`runRecipe(name, workspace?)\` | Run a recipe by name |

### Conversations

| Method | Description |
|--------|-------------|
| \`listConversations(workspace?)\` | List conversations |
| \`getConversation(id, workspace?)\` | Get a conversation by ID |
| \`exportConversation(id, format?)\` | Export a conversation |

### Tasks

| Method | Description |
|--------|-------------|
| \`planTask(messages)\` | Plan a task from messages |

### Admin

| Method | Description |
|--------|-------------|
| \`getAdminSummary()\` | Get admin summary |
| \`getHealth()\` | Get server health |
| \`getConfig()\` | Get server config |

### Workspaces

| Method | Description |
|--------|-------------|
| \`listWorkspaces()\` | List workspaces |
| \`createWorkspace(data)\` | Create a workspace |

### Webhooks

| Method | Description |
|--------|-------------|
| \`listWebhooks(workspace?)\` | List webhooks |
| \`addWebhook(url, events, options?)\` | Add a webhook |

### Embeddings

| Method | Description |
|--------|-------------|
| \`embed(input)\` | Compute embeddings for text or array of texts |

### Usage / Analytics

| Method | Description |
|--------|-------------|
| \`getUsageSummary(options?)\` | Get usage summary |
| \`getAnalyticsDashboard(options?)\` | Get analytics dashboard |

## License

MIT
`;

writeFileSync(resolve(outputDir, 'README.md'), readme);
console.log('[generate-sdk] Written README.md');

console.log(`[generate-sdk] SDK generated in ${outputDir}`);
