/**
 * Phase 55.5: Mobile automation routes.
 *
 * ADB / XCUITest bridge abstraction for mobile app testing. Exposes device
 * discovery, app lifecycle, input gestures, screen capture, UI introspection,
 * and durable test sessions with replay.
 *
 * Routes are mounted under /api/v1/mobile-automation/* to avoid collision
 * with the existing mobile push-notification routes under /api/v1/mobile/*.
 *
 * GET    /api/v1/mobile-automation/devices                 — list devices
 * GET    /api/v1/mobile-automation/devices/:id             — device info
 * POST   /api/v1/mobile-automation/app/launch              — launch an app
 * POST   /api/v1/mobile-automation/app/kill                — kill an app
 * POST   /api/v1/mobile-automation/app/install             — install an app
 * DELETE /api/v1/mobile-automation/app/:deviceId/:appId    — uninstall an app
 * POST   /api/v1/mobile-automation/tap                     — tap at x,y
 * POST   /api/v1/mobile-automation/swipe                   — swipe gesture
 * POST   /api/v1/mobile-automation/type                    — type text
 * POST   /api/v1/mobile-automation/key                     — press key
 * POST   /api/v1/mobile-automation/screenshot              — capture screen
 * POST   /api/v1/mobile-automation/find                    — find element
 * POST   /api/v1/mobile-automation/session                 — create session
 * GET    /api/v1/mobile-automation/session/:id             — get session
 * POST   /api/v1/mobile-automation/session/:id/step        — record a step
 * POST   /api/v1/mobile-automation/session/:id/replay      — replay session
 * GET    /api/v1/mobile-automation/sessions                — list sessions
 */
import {
  listDevices,
  getDeviceInfo,
  launchApp,
  killApp,
  installApp,
  uninstallApp,
  tap,
  swipe,
  typeText,
  pressKey,
  captureScreen,
  findElement,
  createTestSession,
  recordStep,
  getSession,
  listSessions,
  replaySession,
} from "../lib/mobile-automation.js";

function mapErrorStatus(message) {
  const m = String(message || "");
  if (/not found/i.test(m)) return 404;
  if (/required|must be|invalid|non-negative|positive|finite|at least one of/i.test(m)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err?.message);
  const code = status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "mobile-automation error");
}

export function mountMobileAutomationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // GET /api/v1/mobile-automation/devices
  apiRoute("get", "/mobile-automation/devices", log, auth, scope("read"), async (req, res) => {
    try {
      const platform = req.query?.platform ? String(req.query.platform) : null;
      const devices = await listDevices(platform);
      return res.json({ _version: 1, devices, count: devices.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/mobile-automation/devices/:id
  apiRoute("get", "/mobile-automation/devices/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const info = await getDeviceInfo(req.params.id);
      return res.json({ _version: 1, device: info });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/mobile-automation/app/launch
  apiRoute("post", "/mobile-automation/app/launch", log, auth, scope("write"), async (req, res) => {
    try {
      const { deviceId, appId } = req.body || {};
      if (!deviceId) return apiError(res, 400, "INVALID_INPUT", "deviceId is required");
      if (!appId) return apiError(res, 400, "INVALID_INPUT", "appId is required");
      const result = await launchApp(deviceId, appId);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/mobile-automation/app/kill
  apiRoute("post", "/mobile-automation/app/kill", log, auth, scope("write"), async (req, res) => {
    try {
      const { deviceId, appId } = req.body || {};
      if (!deviceId) return apiError(res, 400, "INVALID_INPUT", "deviceId is required");
      if (!appId) return apiError(res, 400, "INVALID_INPUT", "appId is required");
      const result = await killApp(deviceId, appId);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/mobile-automation/app/install
  apiRoute("post", "/mobile-automation/app/install", log, auth, scope("write"), async (req, res) => {
    try {
      const { deviceId, path } = req.body || {};
      if (!deviceId) return apiError(res, 400, "INVALID_INPUT", "deviceId is required");
      if (!path) return apiError(res, 400, "INVALID_INPUT", "path is required");
      const result = await installApp(deviceId, path);
      return res.status(201).json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/mobile-automation/app/:deviceId/:appId
  apiRoute(
    "delete",
    "/mobile-automation/app/:deviceId/:appId",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const result = await uninstallApp(req.params.deviceId, req.params.appId);
        return res.json({ _version: 1, result });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // POST /api/v1/mobile-automation/tap
  apiRoute("post", "/mobile-automation/tap", log, auth, scope("write"), async (req, res) => {
    try {
      const { deviceId, x, y } = req.body || {};
      if (!deviceId) return apiError(res, 400, "INVALID_INPUT", "deviceId is required");
      const result = await tap(deviceId, Number(x), Number(y));
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/mobile-automation/swipe
  apiRoute("post", "/mobile-automation/swipe", log, auth, scope("write"), async (req, res) => {
    try {
      const { deviceId, from, to } = req.body || {};
      if (!deviceId) return apiError(res, 400, "INVALID_INPUT", "deviceId is required");
      if (!from || !to) return apiError(res, 400, "INVALID_INPUT", "from and to are required");
      const result = await swipe(deviceId, from, to);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/mobile-automation/type
  apiRoute("post", "/mobile-automation/type", log, auth, scope("write"), async (req, res) => {
    try {
      const { deviceId, text } = req.body || {};
      if (!deviceId) return apiError(res, 400, "INVALID_INPUT", "deviceId is required");
      if (typeof text !== "string") return apiError(res, 400, "INVALID_INPUT", "text must be a string");
      const result = await typeText(deviceId, text);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/mobile-automation/key
  apiRoute("post", "/mobile-automation/key", log, auth, scope("write"), async (req, res) => {
    try {
      const { deviceId, key } = req.body || {};
      if (!deviceId) return apiError(res, 400, "INVALID_INPUT", "deviceId is required");
      if (!key) return apiError(res, 400, "INVALID_INPUT", "key is required");
      const result = await pressKey(deviceId, key);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/mobile-automation/screenshot
  apiRoute("post", "/mobile-automation/screenshot", log, auth, scope("read"), async (req, res) => {
    try {
      const { deviceId } = req.body || {};
      if (!deviceId) return apiError(res, 400, "INVALID_INPUT", "deviceId is required");
      const result = await captureScreen(deviceId);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/mobile-automation/find
  apiRoute("post", "/mobile-automation/find", log, auth, scope("read"), async (req, res) => {
    try {
      const { deviceId, query } = req.body || {};
      if (!deviceId) return apiError(res, 400, "INVALID_INPUT", "deviceId is required");
      if (!query || typeof query !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "query is required");
      }
      const element = await findElement(deviceId, query);
      return res.json({ _version: 1, element });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/mobile-automation/session
  apiRoute("post", "/mobile-automation/session", log, auth, scope("write"), async (req, res) => {
    try {
      const { name, deviceId, appId } = req.body || {};
      if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      if (!deviceId) return apiError(res, 400, "INVALID_INPUT", "deviceId is required");
      if (!appId) return apiError(res, 400, "INVALID_INPUT", "appId is required");
      const session = await createTestSession(name, deviceId, appId);
      return res.status(201).json({ _version: 1, session });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/mobile-automation/session/:id
  apiRoute("get", "/mobile-automation/session/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const session = await getSession(req.params.id);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", `session ${req.params.id} not found`);
      }
      return res.json({ _version: 1, session });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/mobile-automation/session/:id/step
  apiRoute(
    "post",
    "/mobile-automation/session/:id/step",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const step = req.body || {};
        const recorded = await recordStep(req.params.id, step);
        return res.status(201).json({ _version: 1, step: recorded });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // POST /api/v1/mobile-automation/session/:id/replay
  apiRoute(
    "post",
    "/mobile-automation/session/:id/replay",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const result = await replaySession(req.params.id);
        return res.json({ _version: 1, ...result });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // GET /api/v1/mobile-automation/sessions
  apiRoute("get", "/mobile-automation/sessions", log, auth, scope("read"), async (_req, res) => {
    try {
      const sessions = await listSessions();
      return res.json({ _version: 1, sessions, count: sessions.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountMobileAutomationRoutes;
