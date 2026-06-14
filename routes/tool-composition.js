/**
 * Phase 53.4: Tool composition routes.
 *
 * POST /api/v1/tools/compose             -- compose a pipeline from tools + goal
 * POST /api/v1/tools/compose/execute     -- execute a macro with a given input
 * POST /api/v1/tools/compose/save        -- persist a macro
 * GET  /api/v1/tools/compose             -- list saved macros
 * GET  /api/v1/tools/compose/:name       -- fetch a saved macro
 * POST /api/v1/tools/compose/validate    -- validate a composition
 */
import {
  composeTools,
  createMacroTool,
  executeMacro,
  validateComposition,
  saveMacro,
  loadMacro,
  listSavedMacros,
} from "../lib/tool-composition.js";

function mapErrorStatus(message) {
  const m = String(message || "");
  if (/not found/i.test(m)) return 404;
  if (/required|must be|invalid|unknown tool|type mismatch|cycle/i.test(m)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err?.message);
  const code = status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "tool-composition error");
}

/**
 * A default executor that simply echoes the tool name + input. The server
 * does not know which tools exist in the agent runtime at the HTTP layer;
 * callers can supply an allowlisted executor via `deps.composeExecutor`.
 */
function makeDefaultExecutor(deps) {
  if (deps && typeof deps.composeExecutor === "function") return deps.composeExecutor;
  return async (toolName, input) => ({
    _mock: true,
    tool: toolName,
    input,
  });
}

export function mountToolCompositionRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/tools/compose
  apiRoute("post", "/tools/compose", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "tools[] is required");
      }
      const compositions = composeTools(body.tools, {
        goal: body.goal,
        inputSchema: body.inputSchema,
        maxDepth: body.maxDepth,
        name: body.name,
      });
      return res.json({ _version: 1, compositions, count: compositions.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/compose/execute
  apiRoute("post", "/tools/compose/execute", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      let macro = body.macro;
      if (!macro && body.name) {
        macro = await loadMacro(body.name);
      }
      if (!macro || typeof macro !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "macro is required");
      }
      // Allow the caller to give a pipeline + tools without pre-building the macro.
      if (!macro.steps && Array.isArray(body.pipeline) && Array.isArray(body.tools)) {
        macro = createMacroTool(
          body.name || `macro_${Date.now()}`,
          body.pipeline,
          body.tools,
        );
      }
      const executor = makeDefaultExecutor(deps);
      const result = await executeMacro(macro, body.input, executor);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/compose/save
  apiRoute("post", "/tools/compose/save", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name is required");
      }
      if (!body.macro || typeof body.macro !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "macro is required");
      }
      const saved = await saveMacro(body.name, body.macro);
      return res.status(201).json({ _version: 1, macro: saved });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/tools/compose
  apiRoute("get", "/tools/compose", log, auth, scope("read"), async (_req, res) => {
    try {
      const macros = await listSavedMacros();
      return res.json({ _version: 1, macros, count: macros.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/tools/compose/:name
  apiRoute("get", "/tools/compose/:name", log, auth, scope("read"), async (req, res) => {
    try {
      const macro = await loadMacro(req.params.name);
      if (!macro) {
        return apiError(res, 404, "NOT_FOUND", `macro ${req.params.name} not found`);
      }
      return res.json({ _version: 1, macro });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/compose/validate
  apiRoute("post", "/tools/compose/validate", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.composition || typeof body.composition !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "composition is required");
      }
      const verdict = validateComposition(body.composition, body.tools || []);
      return res.json({ _version: 1, ...verdict });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountToolCompositionRoutes;
