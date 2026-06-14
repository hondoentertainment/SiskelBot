/**
 * Phase 52.5: Verification loop routes.
 *
 * POST /api/v1/reasoning/verify/run        — full verifier-proposer refine cycle
 * POST /api/v1/reasoning/verify/propose    — invoke a proposer
 * POST /api/v1/reasoning/verify/verify     — invoke a verifier
 * POST /api/v1/reasoning/verify/refine     — invoke a refiner
 * POST /api/v1/reasoning/verify/iterative  — iterative refiner
 *
 * These endpoints are intended for testing and simple use cases; they
 * accept inline proposer/verifier definitions rather than LLM-backed
 * chains. Possible `proposer` values:
 *   - "echo"        : returns the task text verbatim
 *   - "static:TEXT" : returns the literal TEXT
 * Possible `verifier` values:
 *   - "default"     : defaultVerifier (coherence heuristics)
 *   - "math"        : mathVerifier (arithmetic)
 *   - "code"        : codeVerifier (JS syntax)
 *   - "format"      : formatVerifier (JSON schema — pass `schema` in body)
 */
import {
  VerificationLoop,
  IterativeRefiner,
  propose,
  verify,
  refine,
  defaultVerifier,
  mathVerifier,
  codeVerifier,
  formatVerifier,
} from "../lib/verification-loop.js";

function resolveProposer(spec) {
  if (!spec || spec === "echo") {
    return (task) => (typeof task === "string" ? task : JSON.stringify(task));
  }
  if (typeof spec === "string" && spec.startsWith("static:")) {
    const literal = spec.slice("static:".length);
    return () => literal;
  }
  // Default fallback: echo.
  return (task) => (typeof task === "string" ? task : JSON.stringify(task));
}

function resolveVerifier(spec, schema) {
  switch (spec) {
    case "math":
      return mathVerifier;
    case "code":
      return codeVerifier;
    case "format":
      return (answer, task) => formatVerifier(answer, task, schema);
    case "default":
    case undefined:
    case null:
    case "":
      return defaultVerifier;
    default:
      return defaultVerifier;
  }
}

function resolveRefiner(spec) {
  if (!spec || spec === "append") {
    return null; // use built-in default refine behaviour
  }
  return null;
}

export function mountVerificationLoopRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/reasoning/verify/run
  apiRoute("post", "/reasoning/verify/run", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const task = body.task;
      if (!task || (typeof task === "string" && !task.trim())) {
        return apiError(res, 400, "INVALID_INPUT", "task is required");
      }
      const maxIterations = Number(body.maxIter || body.maxIterations || 3);
      const acceptThreshold =
        typeof body.acceptThreshold === "number" ? body.acceptThreshold : undefined;
      const proposer = resolveProposer(body.proposer);
      const verifier = resolveVerifier(body.verifier, body.schema);
      const refiner = resolveRefiner(body.refiner);
      const loop = new VerificationLoop({
        proposer,
        verifier,
        refiner,
        maxIterations,
        acceptThreshold,
      });
      const result = await loop.run(task);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      const status = /task is required/.test(err?.message || "") ? 400 : 500;
      const code = status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
      return apiError(res, status, code, err?.message || "verify/run failed");
    }
  });

  // POST /api/v1/reasoning/verify/propose
  apiRoute("post", "/reasoning/verify/propose", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const task = body.task;
      if (!task || (typeof task === "string" && !task.trim())) {
        return apiError(res, 400, "INVALID_INPUT", "task is required");
      }
      const proposer = resolveProposer(body.proposer);
      const answer = await propose(task, proposer);
      return res.json({ _version: 1, answer });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "propose failed");
    }
  });

  // POST /api/v1/reasoning/verify/verify
  apiRoute("post", "/reasoning/verify/verify", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const answer = body.answer;
      const task = body.task;
      if (answer == null) {
        return apiError(res, 400, "INVALID_INPUT", "answer is required");
      }
      if (task == null) {
        return apiError(res, 400, "INVALID_INPUT", "task is required");
      }
      const verifier = resolveVerifier(body.verifier, body.schema);
      const result = await verify(answer, task, verifier);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "verify failed");
    }
  });

  // POST /api/v1/reasoning/verify/refine
  apiRoute("post", "/reasoning/verify/refine", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const answer = body.answer;
      const critique = body.critique;
      if (answer == null) {
        return apiError(res, 400, "INVALID_INPUT", "answer is required");
      }
      const refined = await refine(answer, critique || "");
      return res.json({ _version: 1, answer: refined });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "refine failed");
    }
  });

  // POST /api/v1/reasoning/verify/iterative
  apiRoute("post", "/reasoning/verify/iterative", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const task = body.task;
      if (!task || (typeof task === "string" && !task.trim())) {
        return apiError(res, 400, "INVALID_INPUT", "task is required");
      }
      const maxIterations = Number(body.maxIter || body.maxIterations || 3);
      const proposer = resolveProposer(body.proposer);
      const verifier = resolveVerifier(body.verifier, body.schema);
      const refiner = new IterativeRefiner({ proposer, verifier });
      const result = await refiner.refine(task, maxIterations);
      return res.json({
        _version: 1,
        ...result,
        history: refiner.getHistory(),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "iterative refine failed");
    }
  });
}

export default mountVerificationLoopRoutes;
