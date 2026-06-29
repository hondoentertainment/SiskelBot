/**
 * MCP server registry — register external MCP servers at runtime (no restart).
 * GET    /api/v1/mcp-servers            — list registered servers + status
 * POST   /api/v1/mcp-servers            — register (and connect to) a server (admin)
 * DELETE /api/v1/mcp-servers/:id        — unregister a server (admin)
 * POST   /api/v1/mcp-servers/:id/connect    — (re)connect (admin)
 * POST   /api/v1/mcp-servers/:id/disconnect — disconnect (admin)
 * GET    /api/v1/mcp-servers/:id/tools  — discover tools from a server
 */
import {
  listServers,
  registerServer,
  unregisterServer,
  connectServer,
  disconnectServer,
  discoverServerTools,
} from "../lib/mcp-registry.js";

export function mountMcpRegistryRoutes(app, deps) {
  const { apiRoute, apiError, storageRateLimiter, adminAuth } = deps;
  const limiter = storageRateLimiter || ((req, res, next) => next());
  const admin = adminAuth || ((req, res, next) => next());

  apiRoute("get", "/mcp-servers", limiter, async (req, res) => {
    try {
      res.json({ ok: true, servers: await listServers() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/mcp-servers", limiter, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.type || !body.target) {
        return apiError(res, 400, "INVALID_INPUT", "type and target are required");
      }
      const result = await registerServer({
        name: body.name,
        type: body.type,
        target: body.target,
        env: body.env,
        enabled: body.enabled,
        connect: body.connect,
      });
      res.status(result.existing ? 200 : 201).json({ ok: true, ...result });
    } catch (err) {
      if (err.message.includes("required") || err.message.includes("type must")) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("delete", "/mcp-servers/:id", limiter, admin, async (req, res) => {
    try {
      const removed = await unregisterServer(req.params.id);
      if (!removed) return apiError(res, 404, "NOT_FOUND", "Server not found");
      res.json({ ok: true, deleted: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/mcp-servers/:id/connect", limiter, admin, async (req, res) => {
    try {
      const result = await connectServer(req.params.id);
      if (!result.ok) {
        const code = result.error === "Server not found" ? 404 : 502;
        return apiError(res, code, code === 404 ? "NOT_FOUND" : "UPSTREAM_ERROR", result.error);
      }
      res.json({ ok: true, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/mcp-servers/:id/disconnect", limiter, admin, async (req, res) => {
    try {
      const ok = disconnectServer(req.params.id);
      res.json({ ok: true, disconnected: ok });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/mcp-servers/:id/tools", limiter, async (req, res) => {
    try {
      const tools = await discoverServerTools(req.params.id);
      res.json({ ok: true, tools });
    } catch (err) {
      return apiError(res, 502, "UPSTREAM_ERROR", err.message);
    }
  });
}
