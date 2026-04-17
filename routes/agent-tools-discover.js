/**
 * Agent tools discovery route.
 *
 * GET /api/v1/agent/tools?workspace=<ws>&includeMcp=true
 *
 * Lists all available agent tools (static + optionally MCP-discovered),
 * with source annotation for each tool.
 */

import { resolveToolSet } from "../lib/dynamic-tool-provider.js";

/**
 * Mount the agent tools discovery route.
 * @param {import("express").Express} app
 * @param {object} deps
 */
export function mountAgentToolsDiscoverRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest } = deps;

  apiRoute(
    "get",
    "/agent/tools",
    logRequest,
    userAuth,
    requireScope("read"),
    async (req, res) => {
      try {
        const workspace =
          typeof req.query?.workspace === "string" && req.query.workspace.trim()
            ? req.query.workspace.trim()
            : "default";
        const includeMcp = req.query?.includeMcp === "true";

        const tools = await resolveToolSet({ includeMcp, workspace });

        const items = tools.map((t) => ({
          name: t.function?.name || "",
          description: t.function?.description || "",
          source: t._source === "mcp" ? "mcp" : "static",
          ...(t._serverUrl ? { serverUrl: t._serverUrl } : {}),
        }));

        res.json({ tools: items, total: items.length });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );
}
