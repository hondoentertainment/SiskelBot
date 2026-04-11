/**
 * Phase 37.2: Mobile-optimized API endpoints.
 *
 * GET    /api/v1/mobile/sync?since=<timestamp>
 * GET    /api/v1/mobile/feed
 * POST   /api/v1/mobile/batch
 * GET    /api/v1/mobile/conversations?limit=20&compact=1
 * GET    /api/v1/mobile/conversations/:id?compact=1
 * POST   /api/v1/mobile/chat
 * POST   /api/v1/mobile/devices
 * DELETE /api/v1/mobile/devices/:token
 * POST   /api/v1/mobile/test-notification   (admin)
 *
 * Mobile-specific design goals:
 *   - smaller JSON payloads (drop metadata unless requested)
 *   - delta sync via ?since= timestamp to avoid full downloads
 *   - batch endpoint to collapse round-trips
 *   - compression via the app-wide `compression` middleware
 *   - short Cache-Control headers for read endpoints
 *   - bandwidth tracked per endpoint via lib/metrics.recordBandwidth
 */

import {
  registerDeviceToken,
  unregisterDeviceTokenForUser,
  getDeviceTokens,
  notifyUser,
  isPushConfigured,
} from "../lib/push-notifications.js";
import { recordBandwidth } from "../lib/metrics.js";

/**
 * Phase 37.2: Bandwidth tracking middleware.
 *
 * Intercepts res.write/res.end to count bytes sent per endpoint and forwards
 * the counter to lib/metrics.recordBandwidth so it becomes visible via
 * /metrics (as siskelbot_http_response_bytes_total).
 */
export function trackBandwidth(req, res, next) {
  let bytes = 0;
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  res.write = function patchedWrite(chunk, ...rest) {
    try {
      if (chunk) bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    } catch (_) {}
    return origWrite(chunk, ...rest);
  };
  res.end = function patchedEnd(chunk, ...rest) {
    try {
      if (chunk) bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    } catch (_) {}
    try {
      const routePath = req.route?.path ? `${req.baseUrl || ""}${req.route.path}` : req.path;
      recordBandwidth(req.method, routePath, bytes);
    } catch (_) {}
    res.bandwidthBytes = bytes;
    return origEnd(chunk, ...rest);
  };
  next();
}

function parseSince(value) {
  if (value === undefined || value === null || value === "") return 0;
  const num = Number(value);
  if (Number.isFinite(num)) return num;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toMillis(iso) {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function itemChangedAt(item) {
  return toMillis(item?.updatedAt) || toMillis(item?.createdAt) || 0;
}

function compactConversation(conv, { includeMessages = false, messageLimit = 50 } = {}) {
  if (!conv) return null;
  const msgs = Array.isArray(conv.messages) ? conv.messages : [];
  const last = msgs[msgs.length - 1] || null;
  const lastMessagePreview = last
    ? {
        role: last.role || "assistant",
        content: typeof last.content === "string" ? last.content.slice(0, 200) : "",
      }
    : null;
  const base = {
    id: conv.id,
    title: conv.title || "Untitled",
    lastMessage: lastMessagePreview,
    updatedAt: conv.updatedAt || conv.createdAt || null,
  };
  if (includeMessages) {
    base.messages = msgs.slice(-messageLimit).map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    }));
  }
  return base;
}

function compactDocument(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    title: doc.title || doc.name || "Untitled",
    updatedAt: doc.updatedAt || doc.createdAt || null,
  };
}

function compactRecipe(recipe) {
  if (!recipe) return null;
  return {
    id: recipe.id,
    name: recipe.name || recipe.id,
    description: recipe.description ? String(recipe.description).slice(0, 200) : "",
    updatedAt: recipe.updatedAt || recipe.createdAt || null,
  };
}

function setMobileCacheHeaders(res, { maxAgeSec = 15 } = {}) {
  // short caches - mobile clients sometimes need fresh data but reducing
  // bandwidth on repeated polls is worth a few seconds of staleness.
  res.setHeader("Cache-Control", `private, max-age=${maxAgeSec}`);
  res.setHeader("Vary", "Accept-Encoding, Authorization");
}

export function mountMobileRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    chatAuth,
    adminAuth,
    requireScope,
    logRequest,
    storage,
    sanitizeWorkspace,
    backendFetch,
    buildProxyConfig,
    BACKEND,
    MODEL_PRESETS,
  } = deps;

  // ── GET /api/v1/mobile/sync ──────────────────────────────────────────────
  apiRoute("get", "/mobile/sync", chatAuth, requireScope("read"), trackBandwidth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const since = parseSince(req.query?.since);
      const userId = req.userId || "anonymous";

      const [conversations, documents, recipes] = await Promise.all([
        storage.listItems("conversations", workspace, userId).catch(() => []),
        storage.listItems("context", workspace, userId).catch(() => []),
        storage.listItems("recipes", workspace, userId).catch(() => []),
      ]);

      const filter = (item) => itemChangedAt(item) > since;
      const changedConvs = conversations.filter(filter).map((c) => compactConversation(c));
      const changedDocs = documents.filter(filter).map(compactDocument);
      const changedRecipes = recipes.filter(filter).map(compactRecipe);

      setMobileCacheHeaders(res, { maxAgeSec: 10 });
      res.json({
        conversations: changedConvs,
        documents: changedDocs,
        recipes: changedRecipes,
        lastSync: Date.now(),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ── GET /api/v1/mobile/feed ──────────────────────────────────────────────
  apiRoute("get", "/mobile/feed", chatAuth, requireScope("read"), trackBandwidth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 25));
      const userId = req.userId || "anonymous";

      const [conversations, documents] = await Promise.all([
        storage.listItems("conversations", workspace, userId).catch(() => []),
        storage.listItems("context", workspace, userId).catch(() => []),
      ]);

      const items = [];
      for (const c of conversations) {
        const msgs = Array.isArray(c.messages) ? c.messages : [];
        const last = msgs[msgs.length - 1];
        items.push({
          id: c.id,
          type: "conversation",
          title: c.title || "Untitled",
          preview: last && typeof last.content === "string" ? last.content.slice(0, 160) : "",
          timestamp: itemChangedAt(c),
        });
      }
      for (const d of documents) {
        items.push({
          id: d.id,
          type: "document",
          title: d.title || d.name || "Untitled",
          preview: typeof d.text === "string" ? d.text.slice(0, 160) : "",
          timestamp: itemChangedAt(d),
        });
      }
      items.sort((a, b) => b.timestamp - a.timestamp);
      const top = items.slice(0, limit);

      setMobileCacheHeaders(res, { maxAgeSec: 10 });
      res.json({ items: top });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ── POST /api/v1/mobile/batch ────────────────────────────────────────────
  apiRoute("post", "/mobile/batch", chatAuth, requireScope("write"), trackBandwidth, logRequest, async (req, res) => {
    try {
      const calls = Array.isArray(req.body) ? req.body : req.body?.requests;
      if (!Array.isArray(calls)) {
        return apiError(res, 400, "INVALID_INPUT", "Body must be an array of {method, path, body} calls.");
      }
      if (calls.length > 20) {
        return apiError(res, 400, "INVALID_INPUT", "Batch limited to 20 calls per request.");
      }

      const authHeader = req.headers.authorization;
      const apiKeyHeader = req.headers["x-api-key"];
      const userKeyHeader = req.headers["x-user-api-key"];

      const results = [];
      for (const call of calls) {
        const method = String(call?.method || "GET").toUpperCase();
        const path = String(call?.path || "");
        if (!path.startsWith("/")) {
          results.push({ status: 400, body: { error: "path must start with /", code: "INVALID_INPUT" } });
          continue;
        }
        if (path.startsWith("/api/v1/mobile/batch") || path.startsWith("/api/mobile/batch")) {
          results.push({ status: 400, body: { error: "batch cannot call itself", code: "INVALID_INPUT" } });
          continue;
        }
        try {
          const body = call.body;
          const sub = await new Promise((resolve) => {
            const chunks = [];
            const subRes = {
              statusCode: 200,
              _headers: {},
              setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
              getHeader(k) { return this._headers[String(k).toLowerCase()]; },
              removeHeader(k) { delete this._headers[String(k).toLowerCase()]; },
              flushHeaders() {},
              status(code) { this.statusCode = code; return this; },
              json(obj) {
                chunks.push(Buffer.from(JSON.stringify(obj)));
                resolve({ status: this.statusCode, body: obj });
                return this;
              },
              send(data) {
                if (data !== undefined) chunks.push(Buffer.from(typeof data === "string" ? data : JSON.stringify(data)));
                let parsed = null;
                try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) { parsed = chunks.length ? Buffer.concat(chunks).toString("utf8") : null; }
                resolve({ status: this.statusCode, body: parsed });
                return this;
              },
              end(data) {
                if (data !== undefined) chunks.push(Buffer.from(typeof data === "string" ? data : JSON.stringify(data)));
                let parsed = null;
                try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) { parsed = chunks.length ? Buffer.concat(chunks).toString("utf8") : null; }
                resolve({ status: this.statusCode, body: parsed });
                return this;
              },
              headersSent: false,
              on() {},
              once() {},
              write(chunk) { if (chunk) chunks.push(Buffer.from(typeof chunk === "string" ? chunk : chunk)); return true; },
            };
            const subReq = Object.assign(Object.create(req), {
              method,
              url: path,
              originalUrl: path,
              path: path.split("?")[0],
              query: parseQuery(path),
              body: body || {},
              params: {},
              headers: {
                ...req.headers,
                "content-type": "application/json",
                authorization: authHeader,
                "x-api-key": apiKeyHeader,
                "x-user-api-key": userKeyHeader,
              },
              app: req.app,
            });
            app._router.handle(subReq, subRes, (err) => {
              if (err) {
                resolve({ status: 500, body: { error: err.message || "Internal error", code: "INTERNAL_ERROR" } });
              } else {
                resolve({ status: subRes.statusCode, body: null });
              }
            });
          });
          results.push(sub);
        } catch (err) {
          results.push({ status: 500, body: { error: err.message, code: "INTERNAL_ERROR" } });
        }
      }
      res.json(results);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ── GET /api/v1/mobile/conversations ─────────────────────────────────────
  apiRoute("get", "/mobile/conversations", chatAuth, requireScope("read"), trackBandwidth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId || "anonymous";
      const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 20));
      const compact = req.query?.compact !== "0";

      const all = await storage.listItems("conversations", workspace, userId);
      all.sort((a, b) => itemChangedAt(b) - itemChangedAt(a));
      const top = all.slice(0, limit);
      const items = compact ? top.map((c) => compactConversation(c)) : top;

      setMobileCacheHeaders(res, { maxAgeSec: 5 });
      res.json({ items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ── GET /api/v1/mobile/conversations/:id ─────────────────────────────────
  apiRoute("get", "/mobile/conversations/:id", chatAuth, requireScope("read"), trackBandwidth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId || "anonymous";
      const compact = req.query?.compact !== "0";
      const item = await storage.getItem("conversations", req.params.id, workspace, userId);
      if (!item) return apiError(res, 404, "NOT_FOUND", "Conversation not found.");
      setMobileCacheHeaders(res, { maxAgeSec: 5 });
      if (compact) {
        res.json(compactConversation(item, { includeMessages: true, messageLimit: 50 }));
      } else {
        res.json(item);
      }
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ── POST /api/v1/mobile/chat ─────────────────────────────────────────────
  // Intentionally simple: proxies to the upstream backend in non-streaming
  // mode and returns a minimal JSON payload. The full-featured
  // /v1/chat/completions endpoint is still available for clients that need
  // agent loops, tool calls, and streaming.
  apiRoute("post", "/mobile/chat", chatAuth, requireScope("write"), trackBandwidth, logRequest, async (req, res) => {
    try {
      const messages = req.body?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "messages array is required.");
      }
      const verbose = req.body?.verbose === true;
      const model = typeof req.body?.model === "string" && req.body.model
        ? req.body.model
        : (MODEL_PRESETS?.[BACKEND]?.[0] || "unknown");

      let config;
      try {
        config = buildProxyConfig ? buildProxyConfig(BACKEND) : null;
      } catch (_) {
        config = null;
      }
      if (!config) {
        return apiError(res, 503, "BACKEND_UNAVAILABLE", "No chat backend configured.");
      }

      const upstreamBody = {
        model,
        messages,
        stream: false,
        temperature: typeof req.body?.temperature === "number" ? req.body.temperature : 0.7,
      };

      const url = `${config.baseUrl}${config.path}`;
      const headers = { "Content-Type": "application/json" };
      if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

      let upstreamJson = null;
      try {
        const r = await backendFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(upstreamBody),
        });
        try { upstreamJson = await r.json(); } catch (_) { upstreamJson = null; }
        if (!r.ok) {
          return apiError(res, 502, "BACKEND_ERROR", upstreamJson?.error?.message || `Backend returned ${r.status}`);
        }
      } catch (err) {
        return apiError(res, 502, "BACKEND_ERROR", err.message);
      }

      const text =
        upstreamJson?.choices?.[0]?.message?.content ??
        upstreamJson?.message?.content ??
        upstreamJson?.choices?.[0]?.text ??
        "";

      const out = verbose
        ? { model, content: text, usage: upstreamJson?.usage || null, raw: upstreamJson }
        : { model, content: text };

      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Vary", "Accept-Encoding");
      res.json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ── POST /api/v1/mobile/devices ──────────────────────────────────────────
  apiRoute("post", "/mobile/devices", chatAuth, requireScope("write"), trackBandwidth, logRequest, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const { platform, token } = req.body || {};
      if (!platform || typeof platform !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "platform is required (ios|android).");
      }
      if (!token || typeof token !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "token is required.");
      }
      try {
        const record = await registerDeviceToken(userId, platform, token);
        res.status(201).json({ id: record.id, platform: record.platform, token: record.token });
      } catch (err) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ── DELETE /api/v1/mobile/devices/:token ─────────────────────────────────
  apiRoute("delete", "/mobile/devices/:token", chatAuth, requireScope("write"), trackBandwidth, logRequest, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const removed = await unregisterDeviceTokenForUser(userId, req.params.token);
      if (!removed) return apiError(res, 404, "NOT_FOUND", "Device token not found.");
      res.status(204).send();
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ── GET /api/v1/mobile/devices (helper: list current user's devices) ─────
  apiRoute("get", "/mobile/devices", chatAuth, requireScope("read"), trackBandwidth, logRequest, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const list = await getDeviceTokens(userId);
      res.json({ items: list, push: isPushConfigured() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ── POST /api/v1/mobile/test-notification (admin) ────────────────────────
  apiRoute("post", "/mobile/test-notification", adminAuth, requireScope("admin"), trackBandwidth, logRequest, async (req, res) => {
    try {
      const { userId, title, body, data } = req.body || {};
      if (!userId || typeof userId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "userId is required.");
      }
      const safeTitle = typeof title === "string" ? title : "SiskelBot test";
      const safeBody = typeof body === "string" ? body : "This is a test notification.";
      const result = await notifyUser(userId, safeTitle, safeBody, data && typeof data === "object" ? data : {});
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

function parseQuery(path) {
  const q = path.split("?")[1];
  if (!q) return {};
  const out = {};
  for (const pair of q.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    try { out[decodeURIComponent(k)] = decodeURIComponent(v); } catch (_) { out[k] = v; }
  }
  return out;
}

export default mountMobileRoutes;
