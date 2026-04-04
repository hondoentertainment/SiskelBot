const http = require("http");
const https = require("https");
const { URL } = require("url");

class SiskelBotClient {
  constructor(serverUrl, apiKey, workspace) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.workspace = workspace || "default";
  }

  _headers() {
    const h = { "Content-Type": "application/json" };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    h["X-Workspace-Id"] = this.workspace;
    return h;
  }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.serverUrl);
      const mod = url.protocol === "https:" ? https : http;
      const opts = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: this._headers(),
      };

      const req = mod.request(opts, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          const status = res.statusCode;
          if (status >= 400) {
            reject(new Error(`HTTP ${status}: ${raw}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(raw);
          }
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  _streamRequest(path, body, onChunk) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.serverUrl);
      const mod = url.protocol === "https:" ? https : http;
      const headers = this._headers();
      const opts = {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers,
      };

      const req = mod.request(opts, (res) => {
        if (res.statusCode >= 400) {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`)));
          return;
        }

        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) onChunk(content);
              } catch {
                // skip unparseable lines
              }
            }
          }
        });
        res.on("end", resolve);
        res.on("error", reject);
      });
      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async chat(messages, onChunk) {
    const body = {
      model: "default",
      messages,
      stream: true,
    };
    await this._streamRequest("/v1/chat/completions", body, onChunk);
  }

  async searchKnowledge(query) {
    return this._request("GET", `/api/v1/context?q=${encodeURIComponent(query)}`);
  }

  async listKnowledge() {
    return this._request("GET", "/api/v1/context");
  }

  async listRecipes() {
    return this._request("GET", "/api/v1/recipes");
  }

  async runRecipe(recipeId) {
    return this._request("POST", `/api/v1/recipes/${encodeURIComponent(recipeId)}/run`);
  }

  async indexDocument(title, content, meta) {
    return this._request("POST", "/api/v1/context", {
      title,
      content,
      ...(meta || {}),
    });
  }

  async getConfig() {
    return this._request("GET", "/api/v1/config");
  }

  async healthCheck() {
    return this._request("GET", "/healthz");
  }
}

module.exports = { SiskelBotClient };
