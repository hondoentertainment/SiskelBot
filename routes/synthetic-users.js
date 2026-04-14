/**
 * Phase 75.5: Synthetic user simulation routes.
 *
 * POST /synthetic-users/personas                    — create a persona
 * GET  /synthetic-users/personas                    — list personas for a workspace
 * POST /synthetic-users/simulations                 — start a simulation
 * POST /synthetic-users/simulations/:id/turns       — append a turn
 * POST /synthetic-users/simulations/:id/complete    — mark simulation complete
 * POST /synthetic-users/simulations/:id/score       — score a simulation
 * GET  /synthetic-users/simulations/:id             — fetch a simulation
 * GET  /synthetic-users/simulations                 — list simulations for a workspace
 */
import {
  createPersona,
  listPersonas,
  startSimulation,
  appendTurn,
  completeSimulation,
  scoreSimulation,
  getSimulation,
  listSimulations,
} from "../lib/synthetic-users.js";

export function mountSyntheticUsersRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/synthetic-users/personas", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await createPersona(req.body || {});
      res.status(201).json(rec);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/synthetic-users/personas", adminAuth, logRequest, async (req, res) => {
    try {
      const list = await listPersonas(req.query?.workspaceId);
      res.json({ personas: list });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/synthetic-users/simulations", adminAuth, logRequest, async (req, res) => {
    try {
      const sim = await startSimulation(req.body || {});
      res.status(201).json(sim);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/synthetic-users/simulations/:id/turns", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const sim = await appendTurn({
        simulationId: req.params.id,
        role: body.role,
        content: body.content,
      });
      res.status(201).json(sim);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/synthetic-users/simulations/:id/complete", adminAuth, logRequest, async (req, res) => {
    try {
      const sim = await completeSimulation({ simulationId: req.params.id });
      res.json(sim);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/synthetic-users/simulations/:id/score", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const score = await scoreSimulation({
        simulationId: req.params.id,
        goalWeights: body.goalWeights,
      });
      res.json(score);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/synthetic-users/simulations/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const sim = await getSimulation(req.params.id);
      if (!sim) return apiError(res, 404, "NOT_FOUND", "simulation not found");
      res.json(sim);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/synthetic-users/simulations", adminAuth, logRequest, async (req, res) => {
    try {
      const list = await listSimulations(req.query?.workspaceId);
      res.json({ simulations: list });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountSyntheticUsersRoutes;
