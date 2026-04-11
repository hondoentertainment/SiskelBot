/**
 * Phase 70.3: Keyboard navigation routes.
 */
import {
  registerShortcut,
  listShortcuts,
  auditTabOrder,
  resolveConflicts,
  exportBindings,
} from "../lib/keyboard-nav.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "keyboard-nav error");
}

export function mountKeyboardNavRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/keyboard/shortcuts", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await registerShortcut(req.body || {});
      return res.status(201).json({ _version: 1, shortcut: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/keyboard/shortcuts", log, auth, scope("read"), async (req, res) => {
    try {
      const scopeFilter = typeof req.query?.scope === "string" ? req.query.scope : undefined;
      const items = await listShortcuts({ scope: scopeFilter });
      return res.json({ _version: 1, shortcuts: items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/keyboard/audit-tab-order", log, auth, scope("read"), async (req, res) => {
    try {
      const elements = Array.isArray(req.body?.elements) ? req.body.elements : [];
      const r = auditTabOrder(elements);
      return res.json({ _version: 1, ...r });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/keyboard/conflicts", log, auth, scope("read"), async (_req, res) => {
    try {
      const conflicts = await resolveConflicts();
      return res.json({ _version: 1, conflicts, count: conflicts.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/keyboard/bindings/export", log, auth, scope("read"), async (_req, res) => {
    try {
      const out = await exportBindings();
      return res.json({ _version: 1, bindings: out });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountKeyboardNavRoutes;
