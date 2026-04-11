/**
 * Manages authentication state and headers for the SDK.
 * Platform-agnostic: works in React Native, browsers, Node.
 */
export class AuthManager {
  constructor(config = {}) {
    this.apiKey = config.apiKey || null;
    this.userAgent = config.userAgent || 'SiskelBotMobileSDK/1.0';
    this.extraHeaders = config.headers || {};
  }

  login(apiKey) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('apiKey must be a non-empty string');
    }
    this.apiKey = apiKey;
    return true;
  }

  logout() {
    this.apiKey = null;
    return true;
  }

  isAuthenticated() {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  getApiKey() {
    return this.apiKey;
  }

  getHeaders(additional = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent,
      ...this.extraHeaders,
      ...additional,
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
      headers['x-api-key'] = this.apiKey;
    }
    return headers;
  }
}
