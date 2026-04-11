/**
 * Phase 33.5: Compliance reporting routes.
 *
 *   GET  /api/v1/compliance/soc2?startDate=&endDate=           — SOC 2 report
 *   GET  /api/v1/compliance/hipaa?startDate=&endDate=          — HIPAA report
 *   GET  /api/v1/compliance/gdpr?startDate=&endDate=           — GDPR report
 *   GET  /api/v1/compliance/dashboard                          — overview
 *   POST /api/v1/compliance/data-subject-request?userId=X      — GDPR Article 15
 *   POST /api/v1/compliance/right-to-erasure?userId=X          — GDPR Article 17
 *   GET  /api/v1/compliance/export/:userId?format=json|csv|zip — GDPR Article 20
 *
 * All routes require admin authentication.
 */
import {
  generateSOC2Report,
  generateHIPAAReport,
  generateGDPRReport,
  getComplianceDashboard,
  generateDataSubjectRequest,
  executeRightToErasure,
  exportUserData,
} from "../lib/compliance.js";

function parsePeriodQuery(query) {
  const period = {};
  if (query?.startDate) period.startDate = String(query.startDate);
  if (query?.endDate) period.endDate = String(query.endDate);
  return period;
}

export function mountComplianceRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth, storageRateLimiter } = deps;
  const limiter = storageRateLimiter || ((req, res, next) => next());

  // GET /api/v1/compliance/soc2
  apiRoute(
    "get",
    "/compliance/soc2",
    limiter,
    adminAuth,
    logRequest,
    async (req, res) => {
      try {
        const period = parsePeriodQuery(req.query);
        const report = await generateSOC2Report(period);
        res.json({ _version: 1, ...report });
      } catch (err) {
        console.error("Compliance SOC2 error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to generate SOC 2 report.");
      }
    }
  );

  // GET /api/v1/compliance/hipaa
  apiRoute(
    "get",
    "/compliance/hipaa",
    limiter,
    adminAuth,
    logRequest,
    async (req, res) => {
      try {
        const period = parsePeriodQuery(req.query);
        const report = await generateHIPAAReport(period);
        res.json({ _version: 1, ...report });
      } catch (err) {
        console.error("Compliance HIPAA error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to generate HIPAA report.");
      }
    }
  );

  // GET /api/v1/compliance/gdpr
  apiRoute(
    "get",
    "/compliance/gdpr",
    limiter,
    adminAuth,
    logRequest,
    async (req, res) => {
      try {
        const period = parsePeriodQuery(req.query);
        const report = await generateGDPRReport(period);
        res.json({ _version: 1, ...report });
      } catch (err) {
        console.error("Compliance GDPR error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to generate GDPR report.");
      }
    }
  );

  // GET /api/v1/compliance/dashboard
  apiRoute(
    "get",
    "/compliance/dashboard",
    limiter,
    adminAuth,
    logRequest,
    async (req, res) => {
      try {
        const period = parsePeriodQuery(req.query);
        const dashboard = await getComplianceDashboard(period);
        res.json({ _version: 1, ...dashboard });
      } catch (err) {
        console.error("Compliance dashboard error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to generate compliance dashboard.");
      }
    }
  );

  // POST /api/v1/compliance/data-subject-request?userId=X
  apiRoute(
    "post",
    "/compliance/data-subject-request",
    limiter,
    adminAuth,
    logRequest,
    async (req, res) => {
      try {
        const userId = String(req.query?.userId || req.body?.userId || "").trim();
        if (!userId) {
          return apiError(res, 400, "VALIDATION_ERROR", "userId is required", "Pass ?userId=X or {userId: X} in the body.");
        }
        const report = await generateDataSubjectRequest(userId);
        res.json({ _version: 1, ...report });
      } catch (err) {
        console.error("Compliance DSR error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to build data subject request.");
      }
    }
  );

  // POST /api/v1/compliance/right-to-erasure?userId=X
  apiRoute(
    "post",
    "/compliance/right-to-erasure",
    limiter,
    adminAuth,
    logRequest,
    async (req, res) => {
      try {
        const userId = String(req.query?.userId || req.body?.userId || "").trim();
        if (!userId) {
          return apiError(res, 400, "VALIDATION_ERROR", "userId is required", "Pass ?userId=X or {userId: X} in the body.");
        }
        const confirm = req.query?.confirm === "true" || req.body?.confirm === true;
        // Default to dryRun unless an explicit confirm is provided
        const dryRun = !confirm;
        const preserveAudit = req.body?.preserveAudit !== false;
        const result = await executeRightToErasure(userId, { dryRun, preserveAudit });
        if (dryRun) {
          res.json({
            _version: 1,
            ...result,
            note: "Dry run. Pass ?confirm=true to perform actual deletion.",
          });
        } else {
          res.json({ _version: 1, ...result });
        }
      } catch (err) {
        console.error("Compliance erasure error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to execute right to erasure.");
      }
    }
  );

  // GET /api/v1/compliance/export/:userId?format=json
  apiRoute(
    "get",
    "/compliance/export/:userId",
    limiter,
    adminAuth,
    logRequest,
    async (req, res) => {
      try {
        const userId = String(req.params?.userId || "").trim();
        if (!userId) {
          return apiError(res, 400, "VALIDATION_ERROR", "userId is required");
        }
        const format = String(req.query?.format || "json").toLowerCase();
        if (!["json", "csv", "zip"].includes(format)) {
          return apiError(res, 400, "VALIDATION_ERROR", `Unsupported format: ${format}`);
        }
        const out = await exportUserData(userId, format);
        res.setHeader("Content-Type", out.contentType);
        res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
        res.send(out.data);
      } catch (err) {
        console.error("Compliance export error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to export user data.");
      }
    }
  );
}

export default mountComplianceRoutes;
