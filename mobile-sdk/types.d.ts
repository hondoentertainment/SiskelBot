// TypeScript declarations for @siskelbot/mobile-sdk

export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface SiskelBotSDKConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  storage?: AsyncStorageLike;
  fetch?: typeof fetch;
  onError?: (err: Error) => void;
  userAgent?: string;
  headers?: Record<string, string>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  conversationId?: string;
  system?: string;
  history?: ChatMessage[];
  extra?: Record<string, unknown>;
}

export interface ChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface StreamEvent {
  choices?: Array<{
    delta?: { content?: string; role?: string };
    message?: ChatMessage;
    text?: string;
    finish_reason?: string;
  }>;
  [key: string]: unknown;
}

export interface StreamResult {
  text: string;
  events: StreamEvent[];
}

export type StreamTokenCallback = (token: string, event: StreamEvent) => void;
export type StreamDoneCallback = (result: StreamResult) => void;

export interface Conversation {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  messages?: ChatMessage[];
  [key: string]: unknown;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  content?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface KnowledgeSearchResult {
  results: Array<{
    id: string;
    title: string;
    snippet?: string;
    score?: number;
  }>;
  total?: number;
}

export interface QueuedRequest {
  id: string;
  createdAt: string;
  attempts: number;
  request: unknown;
}

export interface FlushResult {
  processed: number;
  failures: Array<{ id: string; error?: string }>;
  remaining: number;
}

export class EventEmitter {
  on(event: string, listener: (...args: unknown[]) => void): () => void;
  once(event: string, listener: (...args: unknown[]) => void): () => void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): boolean;
  removeAllListeners(event?: string): void;
  listenerCount(event: string): number;
}

export class AuthManager {
  constructor(config?: SiskelBotSDKConfig);
  apiKey: string | null;
  login(apiKey: string): boolean;
  logout(): boolean;
  isAuthenticated(): boolean;
  getApiKey(): string | null;
  getHeaders(additional?: Record<string, string>): Record<string, string>;
}

export class StreamingHandler {
  constructor(options?: { decoder?: TextDecoder });
  consume(
    response: Response,
    onToken?: StreamTokenCallback,
    onDone?: StreamDoneCallback,
    onError?: (err: Error) => void,
  ): Promise<StreamResult>;
  reset(): void;
}

export class OfflineQueue {
  constructor(storage?: AsyncStorageLike);
  setHandler(fn: (request: unknown, item: QueuedRequest) => Promise<unknown>): void;
  enqueue(request: unknown): Promise<string>;
  size(): Promise<number>;
  list(): Promise<QueuedRequest[]>;
  flush(): Promise<FlushResult>;
  clear(): Promise<void>;
}

export class ChatClient {
  constructor(config: SiskelBotSDKConfig & { auth?: AuthManager });
  send(message: string | ChatMessage | ChatMessage[], options?: ChatOptions): Promise<ChatCompletionResponse>;
  sendStream(
    message: string | ChatMessage | ChatMessage[],
    onToken: StreamTokenCallback,
    onDone: StreamDoneCallback,
    options?: ChatOptions,
  ): Promise<StreamResult>;
  listConversations(): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation>;
  createConversation(data?: Partial<Conversation>): Promise<Conversation>;
  deleteConversation(id: string): Promise<{ ok: boolean }>;
}

export class KnowledgeClient {
  constructor(config: SiskelBotSDKConfig & { auth?: AuthManager });
  search(query: string, options?: { limit?: number }): Promise<KnowledgeSearchResult>;
  semanticSearch(query: string, options?: { limit?: number; workspaceId?: string }): Promise<KnowledgeSearchResult>;
  add(title: string, content: string, metadata?: Record<string, unknown>): Promise<KnowledgeDocument>;
  list(options?: { limit?: number; offset?: number }): Promise<KnowledgeDocument[]>;
  get(id: string): Promise<KnowledgeDocument>;
  delete(id: string): Promise<{ ok: boolean }>;
}

export class SiskelBotSDK {
  constructor(config: SiskelBotSDKConfig);
  chat: ChatClient;
  knowledge: KnowledgeClient;
  offline: OfflineQueue;
  auth: AuthManager;
  events: EventEmitter;
  initialize(): Promise<boolean>;
  isReady(): boolean;
  destroy(): Promise<void>;
}
