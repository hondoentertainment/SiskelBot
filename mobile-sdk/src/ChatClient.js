import { AuthManager } from './AuthManager.js';
import { StreamingHandler } from './StreamingHandler.js';

/**
 * Chat client for SiskelBot.
 * Wraps the /v1/chat/completions endpoint and conversation CRUD routes.
 */
export class ChatClient {
  constructor(config = {}) {
    if (!config.baseUrl) {
      throw new Error('ChatClient requires a baseUrl');
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.auth = config.auth || new AuthManager(config);
    this.fetchImpl =
      config.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : null);
    if (!this.fetchImpl) {
      throw new Error('No fetch implementation available');
    }
    this.defaultModel = config.model || 'default';
    this.onError = config.onError || null;
  }

  _url(path) {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async _request(method, path, body, extraHeaders = {}) {
    const url = this._url(path);
    const init = {
      method,
      headers: this.auth.getHeaders(extraHeaders),
    };
    if (body !== undefined && body !== null) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await this.fetchImpl(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      err.status = res.status;
      if (this.onError) this.onError(err);
      throw err;
    }
    const contentType = res.headers.get && res.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return res.json();
    }
    return res.text();
  }

  /**
   * Send a non-streaming chat message.
   * @param {string|object[]} message - Plain text or a messages array
   * @param {object} [options] - { model, temperature, conversationId, system, ... }
   */
  async send(message, options = {}) {
    const messages = ChatClient._normalizeMessages(message, options);
    const payload = {
      model: options.model || this.defaultModel,
      messages,
      stream: false,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options.conversationId ? { conversation_id: options.conversationId } : {}),
      ...(options.extra || {}),
    };
    return this._request('POST', '/v1/chat/completions', payload);
  }

  /**
   * Send a streaming chat message.
   * @param {string|object[]} message - Plain text or messages array
   * @param {(token: string, event: object) => void} onToken
   * @param {(result: { text: string, events: object[] }) => void} onDone
   * @param {object} [options]
   */
  async sendStream(message, onToken, onDone, options = {}) {
    const messages = ChatClient._normalizeMessages(message, options);
    const payload = {
      model: options.model || this.defaultModel,
      messages,
      stream: true,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options.conversationId ? { conversation_id: options.conversationId } : {}),
      ...(options.extra || {}),
    };
    const url = this._url('/v1/chat/completions');
    const init = {
      method: 'POST',
      headers: this.auth.getHeaders({ Accept: 'text/event-stream' }),
      body: JSON.stringify(payload),
    };
    const res = await this.fetchImpl(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Stream HTTP ${res.status}: ${text || res.statusText}`);
      err.status = res.status;
      if (this.onError) this.onError(err);
      throw err;
    }
    const handler = new StreamingHandler();
    return handler.consume(res, onToken, onDone, (err) => {
      if (this.onError) this.onError(err);
      throw err;
    });
  }

  async listConversations() {
    return this._request('GET', '/api/v1/conversations');
  }

  async getConversation(id) {
    if (!id) throw new Error('Conversation id is required');
    return this._request('GET', `/api/v1/conversations/${encodeURIComponent(id)}`);
  }

  async createConversation(data = {}) {
    return this._request('POST', '/api/v1/conversations', data);
  }

  async deleteConversation(id) {
    if (!id) throw new Error('Conversation id is required');
    return this._request('DELETE', `/api/v1/conversations/${encodeURIComponent(id)}`);
  }

  /**
   * Normalize a message argument to the OpenAI messages format.
   */
  static _normalizeMessages(message, options = {}) {
    const history = Array.isArray(options.history) ? options.history : [];
    const base = [];
    if (options.system) {
      base.push({ role: 'system', content: options.system });
    }
    for (const m of history) {
      if (m && m.role && m.content !== undefined) base.push(m);
    }
    if (Array.isArray(message)) {
      for (const m of message) {
        if (m && m.role && m.content !== undefined) base.push(m);
      }
    } else if (typeof message === 'string') {
      base.push({ role: 'user', content: message });
    } else if (message && message.role && message.content !== undefined) {
      base.push(message);
    } else {
      throw new TypeError('message must be a string, object, or array of messages');
    }
    return base;
  }
}
