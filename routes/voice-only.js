/**
 * Phase 70.4: Voice-only mode routes.
 */
import {
  registerCommand,
  matchCommand,
  listCommands,
  disambiguate,
  clearCommands,
} from "../lib/voice-only.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "voice-only error");
}

export function mountVoiceOnlyRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/voice/commands", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await registerCommand(req.body || {});
      return res.status(201).json({ _version: 1, command: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/voice/commands", log, auth, scope("read"), async (_req, res) => {
    try {
      const items = await listCommands();
      return res.json({ _version: 1, commands: items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/voice/match", log, auth, scope("read"), async (req, res) => {
    try {
      const utterance = typeof req.body?.utterance === "string" ? req.body.utterance : "";
      if (!utterance) return apiError(res, 400, "INVALID_INPUT", "utterance is required");
      const m = await matchCommand(utterance, req.body || {});
      return res.json({ _version: 1, match: m });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/voice/disambiguate", log, auth, scope("read"), async (req, res) => {
    try {
      const utterance = typeof req.body?.utterance === "string" ? req.body.utterance : "";
      if (!utterance) return apiError(res, 400, "INVALID_INPUT", "utterance is required");
      const results = await disambiguate(utterance, req.body || {});
      return res.json({ _version: 1, results, count: results.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("delete", "/voice/commands", log, admin, async (_req, res) => {
    try {
      const r = await clearCommands();
      return res.json({ _version: 1, ...r });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountVoiceOnlyRoutes;
