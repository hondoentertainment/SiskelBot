/** Phase 73.5 routes */
import { generatePostMortem } from "../lib/post-mortem.js";

export function mountPostMortemRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/post-mortem", adminAuth, logRequest, async (req, res) => {
    try {
      res.json(generatePostMortem(req.body || {}));
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });
}
