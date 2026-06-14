/**
 * Phase 52.4: Neuro-symbolic bridge routes.
 *
 * POST   /api/v1/neuro-symbolic/sat         — solve a CNF SAT instance
 * POST   /api/v1/neuro-symbolic/smt         — solve an SMT-ish formula (stub)
 * GET    /api/v1/neuro-symbolic/solvers     — list registered solver providers
 */
import { solveSat, solveSmt, listSolvers } from "../lib/neuro-symbolic.js";

export function mountNeuroSymbolicRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/neuro-symbolic/solvers", adminAuth, logRequest, async (req, res) => {
    res.json({ solvers: listSolvers() });
  });

  apiRoute("post", "/neuro-symbolic/sat", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.clauses)) {
        return apiError(res, 400, "INVALID_INPUT", "clauses must be an array of integer arrays");
      }
      const result = await solveSat(body.clauses, {
        provider: body.provider,
        maxSteps: body.maxSteps,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/neuro-symbolic/smt", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.formula || typeof body.formula !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "formula is required");
      }
      const result = await solveSmt(body.formula, {
        provider: body.provider,
        domains: body.domains,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });
}

export default mountNeuroSymbolicRoutes;
