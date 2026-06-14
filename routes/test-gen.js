/**
 * Phase 63.3: Test generation routes.
 */
import {
  identifyGaps,
  generateTestStub,
  listGaps,
  listHistory,
} from "../lib/test-gen.js";
import { meterPhase63Operation } from "../lib/phase63-metering.js";

export function mountTestGenRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/test-gen/analyze", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, lcov } = req.body || {};
      if (typeof lcov !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "lcov must be a string");
      }
      const out = await identifyGaps({ workspaceId, lcov });
      await meterPhase63Operation({
        workspaceId,
        feature: "test-gen",
        calls: 1,
        units: (out.gaps || []).length,
        tags: { op: "analyze" },
      });
      res.status(201).json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/test-gen/generate", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, modulePath, uncoveredLines, moduleSource } = req.body || {};
      if (!modulePath) return apiError(res, 400, "INVALID_INPUT", "modulePath is required");
      const out = await generateTestStub({ workspaceId, modulePath, uncoveredLines, moduleSource });
      await meterPhase63Operation({
        workspaceId,
        feature: "test-gen",
        calls: 1,
        units: (out.record?.uncoveredLines || []).length,
        tags: { op: "generate", modulePath },
      });
      res.status(201).json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/test-gen/gaps", adminAuth, logRequest, async (req, res) => {
    try {
      const out = await listGaps(req.query?.workspaceId);
      res.json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/test-gen/history", adminAuth, logRequest, async (req, res) => {
    try {
      const out = await listHistory(req.query?.workspaceId);
      res.json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountTestGenRoutes;
