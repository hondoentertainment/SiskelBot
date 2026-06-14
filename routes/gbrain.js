/**
 * GBrain routes — API endpoints for the GBrain cortex.
 *
 * Exposes the core GBrain lifecycle over HTTP:
 *   POST /api/v1/gbrain/think              — analyze a task and return a plan
 *   POST /api/v1/gbrain/execute            — execute a plan
 *   POST /api/v1/gbrain/think-and-execute  — combined think + execute
 *   POST /api/v1/gbrain/learn              — record an outcome for learning
 *   GET  /api/v1/gbrain/state              — brain state summary
 *   GET  /api/v1/gbrain/thoughts           — recent thoughts (paginated)
 *   GET  /api/v1/gbrain/thoughts/:id       — fetch a single thought by id
 *   GET  /api/v1/gbrain/cortices           — list available cortices / strategies
 *
 * The underlying `lib/gbrain.js` module may not exist yet while it is being
 * built in parallel. We load it lazily on first use and return a 503 if the
 * module is unavailable, so mounting these routes never crashes the server.
 */

let gbrainModulePromise = null;

/**
 * Lazily load `lib/gbrain.js`. Returns `null` if the module is missing or
 * fails to load so callers can respond with a 503.
 */
async function loadGBrain() {
  if (gbrainModulePromise) return gbrainModulePromise;
  gbrainModulePromise = (async () => {
    try {
      const mod = await import("../lib/gbrain.js");
      return mod;
    } catch (err) {
      if (err && err.code !== "ERR_MODULE_NOT_FOUND" && process.env.NODE_ENV !== "test") {
        // Surface unexpected load errors once so operators notice.
        console.warn("[gbrain] failed to load lib/gbrain.js:", err.message);
      }
      return null;
    }
  })();
  return gbrainModulePromise;
}

/**
 * Reset the cached GBrain module. Exposed for tests that want to swap the
 * module between cases.
 * @internal
 */
export function __resetGBrainModuleCache() {
  gbrainModulePromise = null;
}

/**
 * Allow tests (or the server bootstrap) to inject a GBrain module directly
 * without going through dynamic import. Useful for mocking.
 * @internal
 */
export function __setGBrainModule(mod) {
  gbrainModulePromise = Promise.resolve(mod);
}

export function mountGBrainRoutes(app, deps) {
  const { apiRoute, apiError, chatAuth, requireScope, logRequest } = deps;

  const noop = (req, res, next) => next();
  const auth = chatAuth || noop;
  const scope = typeof requireScope === "function" ? requireScope : () => noop;
  const log = logRequest || noop;

  async function getBrain(res) {
    const mod = await loadGBrain();
    if (!mod) {
      apiError(res, 503, "GBRAIN_UNAVAILABLE", "GBrain module is not available.");
      return null;
    }
    return mod;
  }

  // POST /api/v1/gbrain/think — analyze a task and return a plan
  apiRoute("post", "/gbrain/think", auth, scope("read"), log, async (req, res) => {
    try {
      const body = req.body || {};
      const task = body.task;
      if (!task || (typeof task !== "string" && typeof task !== "object")) {
        return apiError(res, 400, "INVALID_INPUT", "task is required");
      }
      if (typeof task === "string" && !task.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "task is required");
      }
      const brain = await getBrain(res);
      if (!brain) return;
      const context = body.context && typeof body.context === "object" ? body.context : {};
      const result = await brain.think(task, context);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "GBRAIN_ERROR", err.message);
    }
  });

  // POST /api/v1/gbrain/execute — execute a plan
  apiRoute("post", "/gbrain/execute", auth, scope("write"), log, async (req, res) => {
    try {
      const body = req.body || {};
      const plan = body.plan;
      if (!plan || typeof plan !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "plan is required");
      }
      const brain = await getBrain(res);
      if (!brain) return;
      const context = body.context && typeof body.context === "object" ? body.context : {};
      const result = await brain.execute(plan, context);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "GBRAIN_ERROR", err.message);
    }
  });

  // POST /api/v1/gbrain/think-and-execute — combined think + execute
  apiRoute("post", "/gbrain/think-and-execute", auth, scope("write"), log, async (req, res) => {
    try {
      const body = req.body || {};
      const task = body.task;
      if (!task || (typeof task !== "string" && typeof task !== "object")) {
        return apiError(res, 400, "INVALID_INPUT", "task is required");
      }
      if (typeof task === "string" && !task.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "task is required");
      }
      const brain = await getBrain(res);
      if (!brain) return;
      const context = body.context && typeof body.context === "object" ? body.context : {};
      const plan = await brain.think(task, context);
      const execution = await brain.execute(plan, context);
      res.json({ plan, execution });
    } catch (err) {
      return apiError(res, 500, "GBRAIN_ERROR", err.message);
    }
  });

  // POST /api/v1/gbrain/learn — record an outcome
  apiRoute("post", "/gbrain/learn", auth, scope("write"), log, async (req, res) => {
    try {
      const body = req.body || {};
      const { thoughtId, outcome, feedback, success, rating } = body;
      if (!thoughtId && !outcome && success == null && rating == null && !feedback) {
        return apiError(res, 400, "INVALID_INPUT", "thoughtId or outcome is required");
      }
      const brain = await getBrain(res);
      if (!brain) return;
      if (typeof brain.learn !== "function") {
        return apiError(res, 501, "NOT_IMPLEMENTED", "learn is not supported by this GBrain build");
      }
      const result = await brain.learn({
        thoughtId,
        outcome,
        feedback,
        success,
        rating,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "GBRAIN_ERROR", err.message);
    }
  });

  // GET /api/v1/gbrain/state — brain state summary
  apiRoute("get", "/gbrain/state", auth, scope("read"), log, async (req, res) => {
    try {
      const brain = await getBrain(res);
      if (!brain) return;
      const state = await brain.getBrainState();
      res.json(state);
    } catch (err) {
      return apiError(res, 500, "GBRAIN_ERROR", err.message);
    }
  });

  // GET /api/v1/gbrain/thoughts — recent thoughts (paginated)
  apiRoute("get", "/gbrain/thoughts", auth, scope("read"), log, async (req, res) => {
    try {
      const brain = await getBrain(res);
      if (!brain) return;
      const limit = clampNumber(req.query?.limit, 20, 1, 500);
      const offset = clampNumber(req.query?.offset, 0, 0, 1_000_000);
      const thoughts = await brain.getRecentThoughts({ limit, offset });
      const list = Array.isArray(thoughts) ? thoughts : thoughts?.thoughts || [];
      const total = Array.isArray(thoughts) ? list.length : thoughts?.total ?? list.length;
      res.json({ thoughts: list, limit, offset, total });
    } catch (err) {
      return apiError(res, 500, "GBRAIN_ERROR", err.message);
    }
  });

  // GET /api/v1/gbrain/thoughts/:id — single thought
  apiRoute("get", "/gbrain/thoughts/:id", auth, scope("read"), log, async (req, res) => {
    try {
      const brain = await getBrain(res);
      if (!brain) return;
      const id = req.params?.id;
      if (!id) return apiError(res, 400, "INVALID_INPUT", "id is required");
      const thought = await brain.getThought(id);
      if (!thought) return apiError(res, 404, "NOT_FOUND", "thought not found");
      res.json(thought);
    } catch (err) {
      return apiError(res, 500, "GBRAIN_ERROR", err.message);
    }
  });

  // GET /api/v1/gbrain/cortices — list available cortices / strategies
  apiRoute("get", "/gbrain/cortices", async (req, res) => {
    try {
      const brain = await getBrain(res);
      if (!brain) return;
      const cortices = brain.CORTICES || brain.default?.CORTICES || [];
      res.json({ cortices });
    } catch (err) {
      return apiError(res, 500, "GBRAIN_ERROR", err.message);
    }
  });
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export default mountGBrainRoutes;
