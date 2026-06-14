/**
 * Phase 49.1: WebXR client routes.
 *
 * Server-side helpers for the browser-based VR/AR interface. The WebXR
 * rendering itself is entirely client-side (navigator.xr + raw WebGL); these
 * endpoints expose feature hints, a stub asset catalog, and per-user session
 * tracking for analytics.
 *
 *   GET    /api/v1/xr/capabilities         feature hints
 *   GET    /api/v1/xr/assets               list of 3D assets (stub)
 *   POST   /api/v1/xr/session              log session start
 *   POST   /api/v1/xr/session/:id/end      log session end
 *   GET    /api/v1/xr/sessions             list this user's sessions
 *   GET    /api/v1/xr/session/:id          get a single session
 */
import { randomUUID } from "node:crypto";

const DEFAULT_ASSETS = [
  { id: "panel-default", kind: "panel", label: "Chat panel", width: 1.4, height: 0.9 },
  { id: "pointer-ray", kind: "ray", label: "Controller pointer" },
];

/**
 * Build a fresh in-memory store. Exported for tests that need isolation.
 * Each entry is keyed by session id and carries the userId so listings
 * can be scoped per-user.
 */
export function createXrSessionStore() {
  const sessions = new Map();
  return {
    create(userId, info = {}) {
      const id = `xrses_${randomUUID()}`;
      const record = {
        id,
        userId: userId || "anonymous",
        mode: typeof info.mode === "string" ? info.mode : "inline",
        device: typeof info.device === "string" ? info.device : null,
        features: Array.isArray(info.features) ? info.features.slice(0, 32) : [],
        startedAt: new Date().toISOString(),
        endedAt: null,
        durationMs: null,
        metadata: info.metadata && typeof info.metadata === "object" ? info.metadata : {},
      };
      sessions.set(id, record);
      return record;
    },
    end(id, userId) {
      const record = sessions.get(id);
      if (!record) return null;
      if (userId && record.userId !== userId) return { forbidden: true };
      if (record.endedAt) return record;
      record.endedAt = new Date().toISOString();
      record.durationMs = Date.parse(record.endedAt) - Date.parse(record.startedAt);
      return record;
    },
    get(id) {
      return sessions.get(id) || null;
    },
    listByUser(userId) {
      const out = [];
      for (const rec of sessions.values()) {
        if (rec.userId === (userId || "anonymous")) out.push(rec);
      }
      out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
      return out;
    },
    _all() {
      return [...sessions.values()];
    },
  };
}

let defaultStore = createXrSessionStore();

export function __resetXrStore() {
  defaultStore = createXrSessionStore();
}

export function __setXrStore(store) {
  defaultStore = store;
}

export function mountXrRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopMw = (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : noopMw;
  const auth = typeof userAuth === "function" ? userAuth : noopMw;
  const scope = typeof requireScope === "function" ? requireScope : () => noopMw;

  // GET /api/v1/xr/capabilities
  apiRoute("get", "/xr/capabilities", log, (_req, res) => {
    res.json({
      _version: 1,
      webxr: {
        supportedModes: ["immersive-vr", "immersive-ar", "inline"],
        requiredFeatures: ["local-floor"],
        optionalFeatures: ["hand-tracking", "hit-test", "layers", "dom-overlay"],
      },
      renderer: {
        engine: "inline-webgl",
        threejs: false,
        maxPanels: 4,
      },
      notes:
        "Feature availability depends on the client browser and hardware. " +
        "Probe with navigator.xr.isSessionSupported() before requesting a session.",
    });
  });

  // GET /api/v1/xr/assets
  apiRoute("get", "/xr/assets", log, (_req, res) => {
    res.json({ _version: 1, assets: DEFAULT_ASSETS, count: DEFAULT_ASSETS.length });
  });

  // POST /api/v1/xr/session
  apiRoute("post", "/xr/session", log, auth, scope("write"), (req, res) => {
    try {
      const body = req.body || {};
      const mode = typeof body.mode === "string" ? body.mode : "inline";
      if (!["immersive-vr", "immersive-ar", "inline"].includes(mode)) {
        return apiError(res, 400, "INVALID_INPUT", "mode must be immersive-vr, immersive-ar, or inline");
      }
      const userId = req.userId || "anonymous";
      const record = defaultStore.create(userId, {
        mode,
        device: body.device,
        features: body.features,
        metadata: body.metadata,
      });
      res.status(201).json({ _version: 1, session: record });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "xr session error");
    }
  });

  // POST /api/v1/xr/session/:id/end
  apiRoute("post", "/xr/session/:id/end", log, auth, scope("write"), (req, res) => {
    const userId = req.userId || "anonymous";
    const record = defaultStore.end(req.params.id, userId);
    if (!record) {
      return apiError(res, 404, "NOT_FOUND", `xr session ${req.params.id} not found`);
    }
    if (record.forbidden) {
      return apiError(res, 403, "FORBIDDEN", "session belongs to another user");
    }
    res.json({ _version: 1, session: record });
  });

  // GET /api/v1/xr/sessions
  apiRoute("get", "/xr/sessions", log, auth, scope("read"), (req, res) => {
    const userId = req.userId || "anonymous";
    const sessions = defaultStore.listByUser(userId);
    res.json({ _version: 1, sessions, count: sessions.length });
  });

  // GET /api/v1/xr/session/:id
  apiRoute("get", "/xr/session/:id", log, auth, scope("read"), (req, res) => {
    const record = defaultStore.get(req.params.id);
    if (!record) {
      return apiError(res, 404, "NOT_FOUND", `xr session ${req.params.id} not found`);
    }
    const userId = req.userId || "anonymous";
    if (record.userId !== userId) {
      return apiError(res, 403, "FORBIDDEN", "session belongs to another user");
    }
    res.json({ _version: 1, session: record });
  });
}

export default mountXrRoutes;
