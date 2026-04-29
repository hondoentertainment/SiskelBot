/**
 * SiskelBot TypeScript SDK.
 *
 * Usage:
 *   import { SiskelBotClient } from "@siskelbot/sdk";
 *   const client = new SiskelBotClient({ baseUrl: "https://...", apiKey: "..." });
 *   const stream = await client.chat.stream({ messages: [{ role: "user", content: "hi" }] });
 *   for await (const chunk of stream) console.log(chunk.choices[0].delta.content);
 */

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Optional custom fetch (for testing or proxying) */
  fetch?: typeof fetch;
}

export class SiskelBotError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = "SiskelBotError";
  }
}

export class SiskelBotClient {
  private opts: Required<Omit<ClientOptions, "apiKey" | "fetch">> & { apiKey?: string; fetch: typeof fetch };

  constructor(options: ClientOptions) {
    this.opts = {
      baseUrl: options.baseUrl.replace(/\/$/, ""),
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 3,
      fetch: options.fetch ?? fetch,
    };
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
      ...extra,
    };
  }

  /** Retry with exponential backoff on 5xx and 429 */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        const res = await this.opts.fetch(`${this.opts.baseUrl}${path}`, {
          method,
          headers: this.headers(),
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) return (await res.json()) as T;
        const errBody = await res.text();
        const retryable = res.status >= 500 || res.status === 429;
        const err = new SiskelBotError(`HTTP ${res.status}: ${errBody}`, res.status, "HTTP_ERROR", retryable);
        if (!retryable || attempt === this.opts.maxRetries) throw err;
        await new Promise(r => setTimeout(r, 2 ** attempt * 500));
      } catch (e: any) {
        clearTimeout(timer);
        lastErr = e;
        if (e instanceof SiskelBotError && !e.retryable) throw e;
        if (attempt === this.opts.maxRetries) throw e;
        await new Promise(r => setTimeout(r, 2 ** attempt * 500));
      }
    }
    throw lastErr;
  }

  // Chat namespace
  chat = {
    completions: async (params: ChatCompletionParams): Promise<ChatCompletion> => {
      return this.request<ChatCompletion>("POST", "/v1/chat/completions", { ...params, stream: false });
    },
    stream: async function* (this: SiskelBotClient, params: ChatCompletionParams): AsyncGenerator<ChatCompletionChunk> {
      const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: this.headers({ Accept: "text/event-stream" }),
        body: JSON.stringify({ ...params, stream: true }),
      });
      if (!res.ok || !res.body) {
        throw new SiskelBotError(`HTTP ${res.status}`, res.status, "HTTP_ERROR");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data);
          } catch {
            // skip malformed
          }
        }
      }
    },
  };

  workspaces = {
    list: () => this.request<{ workspaces: Workspace[] }>("GET", "/api/v1/workspaces"),
    create: (body: { name: string; description?: string }) => this.request<Workspace>("POST", "/api/v1/workspaces", body),
  };

  health = {
    deep: () => this.request<HealthDeep>("GET", "/health/deep"),
  };
}

// Types (subset; full set generated from OpenAPI)
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}
export interface ChatCompletionParams {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  workspace?: string;
}
export interface ChatCompletion {
  id: string;
  choices: Array<{ message: ChatMessage; finish_reason: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
export interface ChatCompletionChunk {
  id: string;
  choices: Array<{ delta: Partial<ChatMessage>; finish_reason: string | null }>;
}
export interface Workspace { id: string; name: string; description?: string; createdAt: string; }
export interface HealthDeep { status: "up" | "degraded" | "down"; dependencies: Array<{ name: string; status: string; latencyMs: number }>; }
