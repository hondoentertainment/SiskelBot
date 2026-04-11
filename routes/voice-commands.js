/**
 * Voice command routes: parse a transcript, execute it, list available
 * commands, and (admin only) register custom commands at runtime.
 *
 * POST /api/v1/voice/commands/parse    — parse transcript without executing
 * POST /api/v1/voice/commands/execute  — parse and execute
 * GET  /api/v1/voice/commands/help     — list registered commands
 * POST /api/v1/voice/commands/register — register a custom command (admin)
 *
 * @module routes/voice-commands
 */

import { parseVoiceCommand } from "../lib/wake-word.js";
import {
  executeVoiceCommand,
  getCommandHelp,
  registerVoiceCommand,
} from "../lib/voice-navigation.js";

export function mountVoiceCommandRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  const commandsRateLimiter = deps.rateLimit
    ? deps.rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false })
    : (_req, _res, next) => next();

  // POST /api/v1/voice/commands/parse
  apiRoute("post", "/voice/commands/parse", commandsRateLimiter, logRequest, async (req, res) => {
    try {
      const { transcript } = req.body || {};
      if (typeof transcript !== "string" || !transcript.trim()) {
        return apiError(res, 400, "INVALID_BODY", "transcript is required", "Send JSON body with { transcript: '...' }.");
      }
      const parsed = parseVoiceCommand(transcript);
      res.json({
        action: parsed.action,
        params: parsed.params,
        confidence: parsed.confidence,
        pattern: parsed.pattern,
        raw: parsed.raw,
        understood: Boolean(parsed.action),
      });
    } catch (err) {
      return apiError(res, 500, "PARSE_FAILED", err.message);
    }
  });

  // POST /api/v1/voice/commands/execute
  apiRoute("post", "/voice/commands/execute", commandsRateLimiter, logRequest, async (req, res) => {
    try {
      const { transcript, context } = req.body || {};
      if (typeof transcript !== "string" || !transcript.trim()) {
        return apiError(res, 400, "INVALID_BODY", "transcript is required", "Send JSON body with { transcript: '...' }.");
      }
      const execContext = Object.assign({}, context || {}, {
        userId: req.user?.id || req.userId || "anonymous",
        workspaceId: req.workspace?.id || req.workspaceId || "default",
      });
      const result = await executeVoiceCommand(transcript, execContext);
      const status = result.executed ? 200 : (result.action ? 500 : 422);
      res.status(status).json(result);
    } catch (err) {
      return apiError(res, 500, "EXECUTE_FAILED", err.message);
    }
  });

  // GET /api/v1/voice/commands/help
  apiRoute("get", "/voice/commands/help", commandsRateLimiter, async (_req, res) => {
    try {
      const commands = getCommandHelp();
      res.json({ commands, count: commands.length });
    } catch (err) {
      return apiError(res, 500, "HELP_FAILED", err.message);
    }
  });

  // POST /api/v1/voice/commands/register (admin only)
  apiRoute("post", "/voice/commands/register", adminAuth || ((req, res, next) => next()), logRequest, async (req, res) => {
    try {
      const { pattern, action, description } = req.body || {};
      if (typeof pattern !== "string" || !pattern.trim()) {
        return apiError(res, 400, "INVALID_BODY", "pattern is required");
      }
      if (typeof action !== "string" || !action.trim()) {
        return apiError(res, 400, "INVALID_BODY", "action is required");
      }
      // Custom commands registered via the API are no-ops on the server.
      // The pattern + action are made discoverable via the help endpoint
      // so clients can match them locally and execute them in the UI.
      const handler = (params) => ({
        ok: true,
        message: `Custom command ${action} parsed.`,
        action,
        params,
      });
      const result = registerVoiceCommand(pattern, handler, { action, description: description || "" });
      res.status(201).json({
        registered: true,
        pattern: result.pattern,
        action: result.action,
        description: description || "",
      });
    } catch (err) {
      return apiError(res, 400, "REGISTER_FAILED", err.message);
    }
  });
}

export default mountVoiceCommandRoutes;
