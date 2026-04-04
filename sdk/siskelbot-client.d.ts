/**
 * SiskelBot JavaScript Client SDK — TypeScript declarations
 * Generated from OpenAPI spec v1.0.0
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
