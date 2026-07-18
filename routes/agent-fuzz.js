/** Phase 73.1 routes */
import { generatePromptPerturbations, runAgentFuzz, scoreFuzzRun } from "../lib/agent-fuzz.js";

export function mountAgentFuzzRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/agent-fuzz/perturb", adminAuth, logRequest, async (req, res) => {
    try {
      const { prompt, count, seed } = req.body || {};
      res.json({ prompts: generatePromptPerturbations(prompt, { count, seed }) });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/agent-fuzz/score", adminAuth, logRequest, async (req, res) => {
    try {
      res.json(scoreFuzzRun(req.body || {}));
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/agent-fuzz/run", adminAuth, logRequest, async (req, res) => {
    try {
      const { prompt, count, seed, dryRun } = req.body || {};
      if (!prompt) return apiError(res, 400, "INVALID_INPUT", "prompt is required");
      const execute =
        dryRun !== false
          ? async () => ({ toolCallsLog: [], iterations: 1, maxIterations: 8 })
          : async () => {
              throw new Error("Live fuzz execute requires dryRun=false and a custom executor hook");
            };
      const report = await runAgentFuzz({ prompt, count, seed, execute });
      res.json(report);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
