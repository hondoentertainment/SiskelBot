import { createStreamingChat } from './streaming';

export class SiskelBotClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
  }

  _headers(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extra,
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async _request(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: this._headers(options.headers),
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Request failed: ${res.status} ${text}`);
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return res.text();
  }

  async chat(messages, options = {}) {
    const body = {
      model: options.model || 'default',
      messages,
      stream: false,
      temperature: options.temperature,
    };
    return this._request('/v1/chat/completions', {
      method: 'POST',
      body,
    });
  }

  async *chatStream(messages, options = {}) {
    const body = {
      model: options.model || 'default',
      messages,
      stream: true,
      temperature: options.temperature,
    };
    const iterator = createStreamingChat({
      url: `${this.baseUrl}/v1/chat/completions`,
      headers: this._headers(),
      body,
    });
    for await (const chunk of iterator) {
      yield chunk;
    }
  }

  async listConversations() {
    return this._request('/api/v1/conversations');
  }

  async getConversation(id) {
    return this._request(`/api/v1/conversations/${encodeURIComponent(id)}`);
  }

  async createConversation(title) {
    return this._request('/api/v1/conversations', {
      method: 'POST',
      body: { title: title || 'New conversation' },
    });
  }

  async deleteConversation(id) {
    return this._request(`/api/v1/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async searchKnowledge(query) {
    const q = encodeURIComponent(query || '');
    return this._request(`/api/v1/context/search?q=${q}`);
  }

  async listKnowledge() {
    return this._request('/api/v1/context');
  }

  async addKnowledgeDocument(doc) {
    return this._request('/api/v1/context', {
      method: 'POST',
      body: doc,
    });
  }

  async getConfig() {
    return this._request('/api/v1/health');
  }

  async login(username, password) {
    return this._request('/api/v1/auth/login', {
      method: 'POST',
      body: { username, password },
    });
  }
}

export default SiskelBotClient;
