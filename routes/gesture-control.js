/**
 * Phase 49.4: Gesture control HTTP routes.
 *
 *   POST /api/v1/gestures/recognize            — recognise a static pose
 *   POST /api/v1/gestures/recognize-dynamic    — recognise a motion gesture from history
 *   GET  /api/v1/gestures/list                 — available gesture catalogue
 *   GET  /api/v1/gestures/commands             — current (user-scoped) command mapping
 *   POST /api/v1/gestures/commands             — update mapping for the caller
 *   POST /api/v1/gestures/event                — log a recognised gesture event (analytics)
 *
 * Per-user command mappings are persisted via json-path-store so they survive
 * across storage backends (file, SQLite KV, Postgres KV) without code changes.
 *
 * @module routes/gesture-control
 */
import { join } from "path";
import {
  GESTURES,
  DEFAULT_GESTURE_COMMANDS,
  recognizeStaticGesture,
  recognizeDynamicGesture,
  mapGestureToCommand,
} from "../lib/gesture-recognizer.js";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "../lib/json-path-store.js";

function storePath() {
  return join(getDataDir(), "gesture-commands.json");
}

async function loadStore() {
  return await readJsonPath(storePath(), { _version: 1, users: {} });
}

async function loadUserMapping(userId) {
  const store = await loadStore();
  const custom = store.users?.[userId] || {};
  return { ...DEFAULT_GESTURE_COMMANDS, ...custom };
}

async function saveUserMapping(userId, partial) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const users = store.users || {};
    const current = users[userId] || {};
    const merged = { ...current };
    for (const [gesture, command] of Object.entries(partial || {})) {
      if (typeof gesture !== "string" || !gesture.trim()) continue;
      if (command == null) {
        delete merged[gesture];
        continue;
      }
      if (typeof command !== "string" || !command.trim()) {
        throw new Error(`command for ${gesture} must be a non-empty string`);
      }
      merged[gesture] = command;
    }
    users[userId] = merged;
    const next = { _version: 1, users };
    await writeJsonPath(storePath(), next);
    return { ...DEFAULT_GESTURE_COMMANDS, ...merged };
  });
}

async function appendEvent(userId, event) {
  const eventPath = join(getDataDir(), "gesture-events.json");
  return withPathLock(eventPath, async () => {
    const data = await readJsonPath(eventPath, { _version: 1, events: [] });
    const events = Array.isArray(data.events) ? data.events : [];
    events.push({
      id: `gev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      gesture: event.gesture,
      command: event.command || null,
      confidence: typeof event.confidence === "number" ? event.confidence : null,
      hand: event.hand || null,
      workspaceId: event.workspaceId || null,
      timestamp: event.timestamp || Date.now(),
    });
    // Retention: keep last 5000 events
    const trimmed = events.slice(-5000);
    await writeJsonPath(eventPath, { _version: 1, events: trimmed });
    return trimmed[trimmed.length - 1];
  });
}

export function mountGestureControlRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth } = deps;

  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const requireUser =
    typeof userAuth === "function"
      ? userAuth
      : (req, _res, next) => {
          req.userId = req.userId || "anonymous";
          next();
        };

  // POST /api/v1/gestures/recognize
  apiRoute("post", "/gestures/recognize", log, requireUser, async (req, res) => {
    try {
      const { jointPositions, hand } = req.body || {};
      if (!Array.isArray(jointPositions)) {
        return apiError(res, 400, "INVALID_INPUT", "jointPositions must be an array of 25 joints");
      }
      const result = recognizeStaticGesture(jointPositions, hand === "left" ? "left" : "right");
      if (!result) {
        return res.json({ _version: 1, recognized: false, gesture: null });
      }
      const userId = req.userId || req.user?.id || "anonymous";
      const mapping = await loadUserMapping(userId);
      const command = mapGestureToCommand(result.gesture, mapping);
      return res.json({ _version: 1, recognized: true, ...result, command });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/gestures/recognize-dynamic
  apiRoute("post", "/gestures/recognize-dynamic", log, requireUser, async (req, res) => {
    try {
      const { history, dt } = req.body || {};
      if (!Array.isArray(history)) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          "history must be an array of { joints, t } samples",
        );
      }
      const result = recognizeDynamicGesture(history, dt);
      if (!result) {
        return res.json({ _version: 1, recognized: false, gesture: null });
      }
      const userId = req.userId || req.user?.id || "anonymous";
      const mapping = await loadUserMapping(userId);
      const command = mapGestureToCommand(result.gesture, mapping);
      return res.json({ _version: 1, recognized: true, ...result, command });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/gestures/list
  apiRoute("get", "/gestures/list", log, async (_req, res) => {
    try {
      const gestures = Object.entries(GESTURES).map(([name, meta]) => ({
        name,
        description: meta.description,
      }));
      return res.json({ _version: 1, gestures, count: gestures.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/gestures/commands
  apiRoute("get", "/gestures/commands", log, requireUser, async (req, res) => {
    try {
      const userId = req.userId || req.user?.id || "anonymous";
      const mapping = await loadUserMapping(userId);
      return res.json({ _version: 1, userId, mapping });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/gestures/commands
  apiRoute("post", "/gestures/commands", log, requireUser, async (req, res) => {
    try {
      const userId = req.userId || req.user?.id || "anonymous";
      const body = req.body || {};
      // Accept either a flat mapping object or { mapping: {...} }
      const partial = body.mapping && typeof body.mapping === "object" ? body.mapping : body;
      if (!partial || typeof partial !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "body must be a mapping object");
      }
      const merged = await saveUserMapping(userId, partial);
      return res.status(200).json({ _version: 1, userId, mapping: merged });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /api/v1/gestures/event
  apiRoute("post", "/gestures/event", log, requireUser, async (req, res) => {
    try {
      const userId = req.userId || req.user?.id || "anonymous";
      const { gesture, command, confidence, hand, workspaceId, timestamp } = req.body || {};
      if (typeof gesture !== "string" || !gesture.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "gesture is required");
      }
      const stored = await appendEvent(userId, {
        gesture,
        command,
        confidence,
        hand,
        workspaceId,
        timestamp,
      });
      return res.status(201).json({ _version: 1, event: stored });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountGestureControlRoutes;
