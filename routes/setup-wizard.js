/**
 * Operator setup wizard.
 * GET /api/v1/admin/setup
 */
import { buildSetupReport } from "../lib/setup-wizard.js";

export function mountSetupWizardRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, logRequest } = deps;
  const admin = adminAuth || ((_req, _res, next) => next());
  const log = logRequest || ((_req, _res, next) => next());

  apiRoute("get", "/admin/setup", log, admin, async (_req, res) => {
    try {
      const report = await buildSetupReport();
      res.json(report);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
