import { AuthManager } from './AuthManager.js';

/**
 * Knowledge base client for SiskelBot.
 * Wraps the /api/v1/context routes for knowledge document CRUD and search.
 */
export class KnowledgeClient {
  constructor(config = {}) {
    if (!config.baseUrl) {
      throw new Error('KnowledgeClient requires a baseUrl');
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.auth = config.auth || new AuthManager(config);
    this.fetchImpl =
      config.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : null);
    if (!this.fetchImpl) {
      throw new Error('No fetch implementation available');
    }
    this.onError = config.onError || null;
  }

  _url(path) {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async _request(method, path, body) {
    const url = this._url(path);
    const init = {
      method,
      headers: this.auth.getHeaders(),
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
   * Keyword search over knowledge base documents.
   */
  async search(query, options = {}) {
    if (!query) throw new Error('query is required');
    const params = new URLSearchParams({ q: query });
    if (options.limit) params.set('limit', String(options.limit));
    return this._request('GET', `/api/v1/context/search?${params.toString()}`);
  }

  /**
   * Semantic (embedding-based) search.
   */
  async semanticSearch(query, options = {}) {
    if (!query) throw new Error('query is required');
    return this._request('POST', '/api/v1/context/semantic-search', {
      query,
      ...(options.limit ? { limit: options.limit } : {}),
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    });
  }

  /**
   * Add a document to the knowledge base.
   */
  async add(title, content, metadata = {}) {
    if (!title) throw new Error('title is required');
    if (content === undefined || content === null) throw new Error('content is required');
    return this._request('POST', '/api/v1/context', {
      title,
      content,
      ...metadata,
    });
  }

  /**
   * List all documents in the knowledge base.
   */
  async list(options = {}) {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    const qs = params.toString();
    return this._request('GET', `/api/v1/context${qs ? `?${qs}` : ''}`);
  }

  /**
   * Get a document by ID.
   */
  async get(id) {
    if (!id) throw new Error('id is required');
    return this._request('GET', `/api/v1/context/${encodeURIComponent(id)}`);
  }

  /**
   * Delete a document by ID.
   */
  async delete(id) {
    if (!id) throw new Error('id is required');
    return this._request('DELETE', `/api/v1/context/${encodeURIComponent(id)}`);
  }
}
