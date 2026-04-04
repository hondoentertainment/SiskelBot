/**
 * SiskelBot JavaScript Client SDK
 * Generated from OpenAPI spec v1.0.0
 * Do not edit by hand — regenerate with: node scripts/generate-sdk.mjs
 */

export class SiskelBotClient {
  /**
   * @param {string} baseUrl - The base URL of the SiskelBot server (e.g. "http://localhost:3000")
   * @param {string} [apiKey] - Optional API key for authentication
   */
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
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
      const err = new Error(`SiskelBot API error ${res.status}: ${text}`);
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
      const err = new Error(`SiskelBot API error ${res.status}: ${text}`);
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
      const lines = buffer.split('\n');
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
    return this._request('GET', `/api/v1/conversations/${encodeURIComponent(id)}`, undefined, { workspace });
  }

  /**
   * Export a conversation.
   * @param {string} id
   * @param {string} [format] - e.g. "json", "markdown"
   * @returns {Promise<object|string>}
   */
  async exportConversation(id, format) {
    return this._request('GET', `/api/v1/conversations/${encodeURIComponent(id)}/export`, undefined, { format });
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
