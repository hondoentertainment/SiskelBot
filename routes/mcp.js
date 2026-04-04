/**
 * MCP (Model Context Protocol) HTTP transport routes.
 * POST /mcp — JSON-RPC endpoint for MCP messages
 * GET /mcp/sse — SSE transport for streaming MCP
 */
import { handleMcpRequest, getMcpCapabilities } from "../lib/mcp-server.js";
import { validate } from "../lib/validate.js";

export function mountMcpRoutes(app, deps) {
  const {
    apiKeyAuth,
    requireScope,
    logRequest,
    apiError,
    backendFetch,
    buildProxyConfig,
    BACKEND,
    MODEL_PRESETS,
    rateLimit,
  } = deps;

  const mcpRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      apiError(res, 429, "RATE_LIMITED", "Too many MCP requests", "MCP calls are limited to 30 per minute.");
    },
  });

  /**
   * Build an MCP execution context from the Express request and deps.
   */
  function buildMcpCtx(req) {
    return {
      userId: req.userId || "anonymous",
      workspace: req.headers["x-workspace"] || req.query?.workspace || "default",
      backendFetch,
      buildProxyConfig,
      BACKEND,
      MODEL_PRESETS,
    };
  }

  const validateMcp = validate({ body: { method: "string", id: "?string" } });

  // POST /mcp — JSON-RPC endpoint
  app.post("/mcp", mcpRateLimiter, apiKeyAuth, requireScope("write"), logRequest, validateMcp, async (req, res) => {
    try {
      const body = req.body;

      if (!body || typeof body !== "object") {
        return res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error" },
          id: null,
        });
      }

      const { jsonrpc, method, params, id } = body;

      if (jsonrpc !== "2.0" || typeof method !== "string") {
        return res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Invalid Request: must include jsonrpc 2.0 and method" },
          id: id ?? null,
        });
      }

      const ctx = buildMcpCtx(req);
      const result = await handleMcpRequest(method, params || {}, ctx);

      if (result && result.error && typeof result.error === "object" && result.error.code) {
        return res.json({
          jsonrpc: "2.0",
          error: result.error,
          id: id ?? null,
        });
      }

      return res.json({
        jsonrpc: "2.0",
        result,
        id: id ?? null,
      });
    } catch (err) {
      return res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: err.message || "Internal error" },
        id: req.body?.id ?? null,
      });
    }
  });

  // GET /mcp/sse — SSE transport for streaming MCP
  app.get("/mcp/sse", mcpRateLimiter, apiKeyAuth, requireScope("read"), (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Send server capabilities as the initial event
    const caps = getMcpCapabilities();
    res.write(`event: endpoint\ndata: /mcp\n\n`);
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: caps })}\n\n`);

    // Keep-alive ping every 30s
    const keepAlive = setInterval(() => {
      res.write(": ping\n\n");
    }, 30_000);

    req.on("close", () => {
      clearInterval(keepAlive);
    });
  });
}
