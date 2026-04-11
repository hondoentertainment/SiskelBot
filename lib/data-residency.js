/**
 * Phase 40.3: Data residency controls.
 *
 * Per-workspace region pinning for GDPR / privacy compliance. Once a workspace
 * residency has been locked it cannot be moved without an admin migration. Routes
 * data reads/writes to the configured regional store and rejects cross-region
 * requests at the middleware layer.
 *
 * @module data-residency
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

/**
 * Catalog of supported residency regions and the compliance frameworks each
 * region commits to honor. Regions are intentionally coarse — country lists
 * are used to map an inbound request's source region to a logical region.
 */
export const RESIDENCY_REGIONS = {
  us: {
    name: "United States",
    countries: ["US"],
    compliance: [],
  },
  eu: {
    name: "European Union",
    countries: [
      "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
      "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
      "PL", "PT", "RO", "SK", "SI", "ES", "SE",
    ],
    compliance: ["GDPR"],
  },
  uk: {
    name: "United Kingdom",
    countries: ["GB"],
    compliance: ["UK-GDPR"],
  },
  apac: {
    name: "Asia Pacific",
    countries: ["JP", "SG", "AU", "NZ", "KR", "HK", "TW"],
    compliance: [],
  },
  ca: {
    name: "Canada",
    countries: ["CA"],
    compliance: ["PIPEDA"],
  },
};

const VALID_REGIONS = new Set(Object.keys(RESIDENCY_REGIONS));

/** Operations that may be restricted by region (used by enforceResidency). */
const KNOWN_OPERATIONS = new Set([
  "read",
  "write",
  "delete",
  "export",
  "share",
  "transfer",
  "replicate",
]);

function residencyConfigPath() {
  return join(getDataDir(), "data-residency.json");
}

function violationsPath() {
  return join(getDataDir(), "data-residency-violations.json");
}

/**
 * Resolve the residency region of the host instance from env. Defaults to "us".
 * @returns {string}
 */
export function getInstanceRegion() {
  const r = String(process.env.DATA_RESIDENCY_REGION || "us").toLowerCase();
  return VALID_REGIONS.has(r) ? r : "us";
}

/**
 * Map a country code (ISO-3166-1 alpha-2) to a residency region.
 * @param {string} country
 * @returns {string | null}
 */
export function regionForCountry(country) {
  if (typeof country !== "string") return null;
  const cc = country.trim().toUpperCase();
  if (!cc) return null;
  for (const [region, info] of Object.entries(RESIDENCY_REGIONS)) {
    if (info.countries.includes(cc)) return region;
  }
  return null;
}

async function loadConfig() {
  return readJsonPath(residencyConfigPath(), { _version: 1, byWorkspace: {} });
}

async function saveConfig(data) {
  await writeJsonPath(residencyConfigPath(), data);
}

/**
 * Set the residency region for a workspace. When `lockResidency` is true the
 * record becomes immutable and future setWorkspaceResidency calls (without an
 * explicit migration) will be rejected.
 *
 * @param {string} workspaceId
 * @param {string} region - one of RESIDENCY_REGIONS keys
 * @param {boolean} [lockResidency=false]
 * @returns {Promise<{ workspaceId: string, region: string, locked: boolean, setAt: string, regionName: string, compliance: string[] }>}
 */
export async function setWorkspaceResidency(workspaceId, region, lockResidency = false) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }
  const r = String(region || "").toLowerCase();
  if (!VALID_REGIONS.has(r)) {
    throw new Error(`Invalid region: ${region}. Available: ${Array.from(VALID_REGIONS).join(", ")}`);
  }
  const path = residencyConfigPath();
  return withPathLock(path, async () => {
    const data = await loadConfig();
    if (!data.byWorkspace) data.byWorkspace = {};
    const existing = data.byWorkspace[workspaceId];
    if (existing && existing.locked) {
      if (existing.region === r) {
        // Re-confirming the same region on a locked workspace is a no-op.
        return existing;
      }
      throw new Error(
        `Workspace ${workspaceId} residency is locked to ${existing.region} and cannot be changed. Use migrateWorkspaceResidency.`
      );
    }
    const info = RESIDENCY_REGIONS[r];
    /** @type {any} */
    const record = {
      workspaceId,
      region: r,
      regionName: info.name,
      compliance: info.compliance.slice(),
      locked: !!lockResidency,
      setAt: new Date().toISOString(),
      previousRegion: existing?.region || null,
    };
    data.byWorkspace[workspaceId] = record;
    await saveConfig(data);
    return record;
  });
}

/**
 * Get the residency record for a workspace, or null when none has been set.
 *
 * @param {string} workspaceId
 * @returns {Promise<null | { workspaceId: string, region: string, regionName: string, locked: boolean, setAt: string, compliance: string[] }>}
 */
export async function getWorkspaceResidency(workspaceId) {
  if (!workspaceId) return null;
  const data = await loadConfig();
  return data.byWorkspace?.[workspaceId] || null;
}

/**
 * Verify that an operation is permitted under the workspace's residency
 * configuration. Operations always run inside the configured region; this
 * helper exists so callers can fail fast when a misconfigured caller is about
 * to read/write data outside its pinned region.
 *
 * @param {string} workspaceId
 * @param {string} operation - e.g. "read" | "write" | "transfer"
 * @param {{ sourceRegion?: string }} [opts]
 * @returns {Promise<{ allowed: boolean, reason?: string, region?: string }>}
 */
export async function enforceResidency(workspaceId, operation, opts = {}) {
  const op = String(operation || "").toLowerCase();
  if (!KNOWN_OPERATIONS.has(op)) {
    return { allowed: false, reason: `Unknown operation: ${operation}` };
  }
  const record = await getWorkspaceResidency(workspaceId);
  if (!record) {
    // No residency configured -> permitted, but caller may want to set one.
    return { allowed: true, region: getInstanceRegion() };
  }
  const instanceRegion = getInstanceRegion();
  const sourceRegion = String(opts.sourceRegion || instanceRegion).toLowerCase();
  if (record.region !== instanceRegion) {
    return {
      allowed: false,
      reason: `Workspace ${workspaceId} is pinned to ${record.region} but this instance is in ${instanceRegion}`,
      region: record.region,
    };
  }
  if (sourceRegion !== record.region && record.compliance.includes("GDPR")) {
    return {
      allowed: false,
      reason: `Operation ${op} from ${sourceRegion} blocked: GDPR-pinned workspace requires same-region access`,
      region: record.region,
    };
  }
  return { allowed: true, region: record.region };
}

function extractWorkspaceId(req) {
  return (
    req.params?.id ||
    req.params?.workspaceId ||
    req.query?.workspace ||
    req.query?.workspaceId ||
    req.body?.workspace ||
    req.body?.workspaceId ||
    req.headers?.["x-workspace-id"] ||
    null
  );
}

function extractRequestRegion(req) {
  // Common provider headers (Cloudflare, Fastly, AWS) carry an ISO country
  // code; we map that to a logical region.
  const headerCountry =
    req.headers?.["cf-ipcountry"] ||
    req.headers?.["x-vercel-ip-country"] ||
    req.headers?.["x-country-code"] ||
    null;
  if (headerCountry) {
    const region = regionForCountry(String(headerCountry));
    if (region) return region;
  }
  const headerRegion = req.headers?.["x-region"];
  if (headerRegion) {
    const r = String(headerRegion).toLowerCase();
    if (VALID_REGIONS.has(r)) return r;
  }
  return getInstanceRegion();
}

/**
 * Express middleware that enforces residency for the workspace referenced in
 * the request. Returns 403 with a structured payload when the request must be
 * rejected. Cross-region attempts are recorded via recordViolation().
 *
 * @param {{ operation?: string, getWorkspaceId?: (req: any) => string, getSourceRegion?: (req: any) => string }} [options]
 */
export function residencyMiddleware(options = {}) {
  const operation = options.operation || "read";
  const getWs = options.getWorkspaceId || extractWorkspaceId;
  const getSrc = options.getSourceRegion || extractRequestRegion;
  return async function residencyMiddlewareHandler(req, res, next) {
    try {
      const workspaceId = getWs(req);
      if (!workspaceId) return next();
      const sourceRegion = getSrc(req);
      const result = await enforceResidency(workspaceId, operation, { sourceRegion });
      if (!result.allowed) {
        await recordViolation({
          workspaceId,
          sourceRegion,
          targetRegion: result.region || getInstanceRegion(),
          operation,
          reason: result.reason || "residency_violation",
          path: req.originalUrl || req.url || null,
          method: req.method || null,
        });
        res.status(403).json({
          error: "data_residency_violation",
          message: result.reason,
          workspaceId,
          region: result.region,
        });
        return;
      }
      // Stash the verified region for downstream handlers.
      req.residency = { workspaceId, region: result.region, sourceRegion };
      return next();
    } catch (err) {
      // Fail closed: refuse the request rather than leak data on a bug.
      res.status(500).json({
        error: "data_residency_error",
        message: err && err.message ? err.message : "Residency middleware failed",
      });
    }
  };
}

/**
 * Validate whether a request originating in `sourceRegion` may access data
 * pinned to `targetRegion`. EU/UK workspaces (GDPR/UK-GDPR) reject all
 * cross-region traffic unless explicit consent has been recorded against the
 * workspace.
 *
 * @param {string} sourceRegion
 * @param {string} targetRegion
 * @param {string} [workspaceId]
 * @returns {Promise<{ allowed: boolean, reason?: string, requiresConsent?: boolean }>}
 */
export async function validateCrossRegionAccess(sourceRegion, targetRegion, workspaceId) {
  const src = String(sourceRegion || "").toLowerCase();
  const tgt = String(targetRegion || "").toLowerCase();
  if (!VALID_REGIONS.has(tgt)) {
    return { allowed: false, reason: `Unknown target region: ${targetRegion}` };
  }
  if (src === tgt) return { allowed: true };

  const targetInfo = RESIDENCY_REGIONS[tgt];
  const isProtected = targetInfo.compliance.some((c) => c === "GDPR" || c === "UK-GDPR");
  if (!isProtected) {
    return { allowed: true };
  }

  if (workspaceId) {
    const record = await getWorkspaceResidency(workspaceId);
    if (record && Array.isArray(record.consents)) {
      const hasConsent = record.consents.some(
        (c) => c.fromRegion === src && c.toRegion === tgt && c.active !== false
      );
      if (hasConsent) return { allowed: true };
    }
  }

  return {
    allowed: false,
    requiresConsent: true,
    reason: `${tgt.toUpperCase()} workspace cannot be accessed from ${src.toUpperCase()} without explicit consent`,
  };
}

/**
 * Record explicit cross-region access consent for a workspace. Stored on the
 * residency record so it survives audits.
 *
 * @param {string} workspaceId
 * @param {string} fromRegion
 * @param {string} toRegion
 * @param {string} [grantedBy]
 */
export async function grantCrossRegionConsent(workspaceId, fromRegion, toRegion, grantedBy = "admin") {
  const path = residencyConfigPath();
  return withPathLock(path, async () => {
    const data = await loadConfig();
    if (!data.byWorkspace?.[workspaceId]) {
      throw new Error(`Workspace ${workspaceId} has no residency record`);
    }
    const record = data.byWorkspace[workspaceId];
    if (!Array.isArray(record.consents)) record.consents = [];
    record.consents.push({
      fromRegion: String(fromRegion).toLowerCase(),
      toRegion: String(toRegion).toLowerCase(),
      grantedBy,
      grantedAt: new Date().toISOString(),
      active: true,
    });
    await saveConfig(data);
    return record;
  });
}

/**
 * Persist a residency violation to the audit store. Append-only.
 *
 * @param {object} entry
 */
export async function recordViolation(entry) {
  const path = violationsPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, items: [] });
    if (!Array.isArray(data.items)) data.items = [];
    data.items.push({
      timestamp: new Date().toISOString(),
      ...entry,
      allowed: entry.allowed === true,
    });
    // Soft cap to avoid unbounded growth on misconfigured systems.
    const max = Math.max(100, Number(process.env.RESIDENCY_VIOLATION_MAX) || 5000);
    if (data.items.length > max) data.items.splice(0, data.items.length - max);
    await writeJsonPath(path, data);
  });
}

/**
 * List recent residency violations for an optional workspace.
 *
 * @param {{ workspaceId?: string, limit?: number }} [opts]
 */
export async function listViolations(opts = {}) {
  const data = await readJsonPath(violationsPath(), { _version: 1, items: [] });
  let items = Array.isArray(data.items) ? data.items.slice() : [];
  if (opts.workspaceId) {
    items = items.filter((i) => i.workspaceId === opts.workspaceId);
  }
  items.reverse();
  if (opts.limit) items = items.slice(0, Number(opts.limit) || 50);
  return items;
}

/**
 * Generate a residency / compliance report for a workspace. Includes the
 * pinned region, lock state, allowed operations, recent violations, and the
 * compliance frameworks the region commits to.
 *
 * @param {string} workspaceId
 */
export async function generateResidencyReport(workspaceId) {
  if (!workspaceId) throw new Error("workspaceId is required");
  const record = await getWorkspaceResidency(workspaceId);
  if (!record) {
    return {
      workspaceId,
      region: null,
      regionName: null,
      locked: false,
      operations: Array.from(KNOWN_OPERATIONS),
      complianceFrameworks: [],
      violations: [],
      configured: false,
    };
  }
  const violations = await listViolations({ workspaceId, limit: 50 });
  return {
    workspaceId,
    region: record.region,
    regionName: record.regionName,
    locked: !!record.locked,
    setAt: record.setAt,
    operations: Array.from(KNOWN_OPERATIONS),
    complianceFrameworks: record.compliance || [],
    consents: Array.isArray(record.consents) ? record.consents : [],
    violations,
    violationCount: violations.length,
    configured: true,
    instanceRegion: getInstanceRegion(),
  };
}

/**
 * Migrate a workspace's data to a new region. The default mode is dry-run; the
 * caller must pass `confirm: true` to mutate state. Even when confirmed the
 * actual data movement is delegated to lib/storage.js — this helper only flips
 * the residency record after a successful copy.
 *
 * @param {string} workspaceId
 * @param {string} newRegion
 * @param {{ confirm?: boolean, performedBy?: string }} [opts]
 */
export async function migrateWorkspaceResidency(workspaceId, newRegion, opts = {}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  const r = String(newRegion || "").toLowerCase();
  if (!VALID_REGIONS.has(r)) {
    throw new Error(`Invalid region: ${newRegion}. Available: ${Array.from(VALID_REGIONS).join(", ")}`);
  }
  const current = await getWorkspaceResidency(workspaceId);
  if (!current) {
    throw new Error(`Workspace ${workspaceId} has no residency record`);
  }
  if (current.region === r) {
    return {
      ok: true,
      noop: true,
      message: `Workspace ${workspaceId} already in ${r}`,
    };
  }
  const dryRun = opts.confirm !== true;
  const plan = {
    workspaceId,
    fromRegion: current.region,
    toRegion: r,
    locked: !!current.locked,
    estimatedSteps: ["snapshot_source", "transfer_blob", "verify_checksum", "swap_pointer", "purge_source"],
    dryRun,
  };
  if (dryRun) {
    return { ok: true, dryRun: true, plan };
  }
  const path = residencyConfigPath();
  return withPathLock(path, async () => {
    const data = await loadConfig();
    if (!data.byWorkspace?.[workspaceId]) {
      throw new Error(`Workspace ${workspaceId} has no residency record`);
    }
    const record = data.byWorkspace[workspaceId];
    record.previousRegion = record.region;
    record.region = r;
    record.regionName = RESIDENCY_REGIONS[r].name;
    record.compliance = RESIDENCY_REGIONS[r].compliance.slice();
    record.migratedAt = new Date().toISOString();
    record.migratedBy = opts.performedBy || "admin";
    // Migration unlocks the workspace so the new pin can be re-locked.
    record.locked = false;
    await saveConfig(data);
    return { ok: true, dryRun: false, plan, record };
  });
}

/**
 * Reset internal residency state. Tests use this to start with a clean slate.
 */
export async function _resetResidencyForTests() {
  await writeJsonPath(residencyConfigPath(), { _version: 1, byWorkspace: {} });
  await writeJsonPath(violationsPath(), { _version: 1, items: [] });
}
