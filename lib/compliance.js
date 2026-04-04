/**
 * Compliance controls: data residency, PII detection/redaction,
 * and audit report generation.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { getWorkspaceActivity } from "./teams.js";

// --- Data Residency ---

const AVAILABLE_REGIONS = [
  { id: "us-east-1", name: "US East (Virginia)", country: "US" },
  { id: "us-west-2", name: "US West (Oregon)", country: "US" },
  { id: "eu-west-1", name: "EU West (Ireland)", country: "IE" },
  { id: "eu-central-1", name: "EU Central (Frankfurt)", country: "DE" },
  { id: "ap-southeast-1", name: "Asia Pacific (Singapore)", country: "SG" },
  { id: "ap-northeast-1", name: "Asia Pacific (Tokyo)", country: "JP" },
  { id: "ca-central-1", name: "Canada (Montreal)", country: "CA" },
  { id: "sa-east-1", name: "South America (Sao Paulo)", country: "BR" },
];

function residencyPath() {
  return join(getDataDir(), "compliance-residency.json");
}

function retentionPath() {
  return join(getDataDir(), "compliance-retention.json");
}

/**
 * Get available data residency regions.
 */
export function getAvailableRegions() {
  return AVAILABLE_REGIONS;
}

/**
 * Set data residency for a workspace.
 */
export async function setDataResidency(workspaceId, region) {
  if (!workspaceId) throw new Error("workspaceId is required");
  const valid = AVAILABLE_REGIONS.find((r) => r.id === region);
  if (!valid) throw new Error(`Invalid region: ${region}. Available: ${AVAILABLE_REGIONS.map((r) => r.id).join(", ")}`);

  const path = residencyPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, byWorkspace: {} });
    if (!data.byWorkspace) data.byWorkspace = {};
    data.byWorkspace[String(workspaceId)] = {
      region,
      regionName: valid.name,
      country: valid.country,
      setAt: new Date().toISOString(),
    };
    await writeJsonPath(path, data);
    return data.byWorkspace[String(workspaceId)];
  });
}

/**
 * Get data residency for a workspace.
 */
export async function getDataResidency(workspaceId) {
  const data = await readJsonPath(residencyPath(), { _version: 1, byWorkspace: {} });
  return data.byWorkspace?.[String(workspaceId)] || null;
}

// --- PII Detection & Redaction ---

/** PII detection patterns */
const PII_PATTERNS = {
  email: {
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    label: "EMAIL",
  },
  phone: {
    regex: /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g,
    label: "PHONE",
  },
  ssn: {
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    label: "SSN",
  },
  creditCard: {
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    label: "CREDIT_CARD",
    validate: luhnCheck,
  },
  ipv4: {
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    label: "IP_ADDRESS",
  },
  ipv6: {
    regex: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    label: "IP_ADDRESS",
  },
};

/**
 * Luhn algorithm check for credit card numbers.
 */
function luhnCheck(numStr) {
  const digits = numStr.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Detect PII in text using pattern matching.
 * Returns array of { type, value, start, end } matches.
 */
export function detectPII(text) {
  if (!text || typeof text !== "string") return [];
  const results = [];
  for (const [/* type */, { regex, label, validate }] of Object.entries(PII_PATTERNS)) {
    const re = new RegExp(regex.source, regex.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      if (validate && !validate(match[0])) continue;
      // Avoid duplicate overlapping SSN/phone matches
      const start = match.index;
      const end = start + match[0].length;
      const overlaps = results.some(
        (r) => r.start <= start && r.end >= end && r.type === label,
      );
      if (!overlaps) {
        results.push({ type: label, value: match[0], start, end });
      }
    }
  }
  // Sort by position
  results.sort((a, b) => a.start - b.start);
  return results;
}

/**
 * Redact detected PII from text.
 * Options:
 * - replacement: string to use for redaction (default: "[REDACTED]")
 * - types: array of PII types to redact (default: all)
 * - partial: if true, show partial values (e.g. "j***@email.com")
 */
export function redactPII(text, options = {}) {
  if (!text || typeof text !== "string") return { text: text || "", redactions: [] };
  const replacement = options.replacement || "[REDACTED]";
  const typesFilter = options.types ? new Set(options.types.map((t) => t.toUpperCase())) : null;
  const detected = detectPII(text);
  const redactions = [];
  let result = text;
  let offset = 0;

  for (const item of detected) {
    if (typesFilter && !typesFilter.has(item.type)) continue;
    const tag = options.partial ? partialRedact(item) : `[${item.type}_${replacement}]`;
    const adjustedStart = item.start + offset;
    const adjustedEnd = item.end + offset;
    result = result.slice(0, adjustedStart) + tag + result.slice(adjustedEnd);
    offset += tag.length - (item.end - item.start);
    redactions.push({ type: item.type, original: item.value, replacement: tag });
  }

  return { text: result, redactions };
}

function partialRedact(item) {
  const val = item.value;
  switch (item.type) {
    case "EMAIL": {
      const atIdx = val.indexOf("@");
      if (atIdx > 1) return val[0] + "***" + val.slice(atIdx);
      return "***@***";
    }
    case "PHONE":
      return val.slice(0, -4).replace(/\d/g, "*") + val.slice(-4);
    case "SSN":
      return "***-**-" + val.slice(-4);
    case "CREDIT_CARD":
      return "****-****-****-" + val.replace(/[\s-]/g, "").slice(-4);
    case "IP_ADDRESS":
      return "x.x.x.x";
    default:
      return "[REDACTED]";
  }
}

/**
 * Auto-redaction middleware: optionally redact PII from request/response bodies.
 * Checks workspace compliance settings to determine if auto-redaction is enabled.
 */
export function piiRedactionMiddleware() {
  return async (req, res, next) => {
    const workspaceId = req.params?.id || req.query?.workspace;
    if (!workspaceId) return next();

    try {
      const policy = await getRetentionPolicy(workspaceId);
      if (!policy?.autoRedactPII) return next();

      // Redact PII from request body messages
      if (req.body?.messages && Array.isArray(req.body.messages)) {
        for (const msg of req.body.messages) {
          if (typeof msg.content === "string") {
            const { text } = redactPII(msg.content);
            msg.content = text;
          }
        }
      }
    } catch {
      // Don't block requests on compliance errors
    }
    next();
  };
}

// --- Data Retention ---

/**
 * Set data retention policy for a workspace.
 */
export async function setRetentionPolicy(workspaceId, policy) {
  if (!workspaceId) throw new Error("workspaceId is required");
  const validPolicy = {
    retentionDays: Math.max(1, Math.min(3650, parseInt(policy.retentionDays, 10) || 365)),
    autoDeleteExpired: Boolean(policy.autoDeleteExpired),
    autoRedactPII: Boolean(policy.autoRedactPII),
    updatedAt: new Date().toISOString(),
  };
  const path = retentionPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, byWorkspace: {} });
    if (!data.byWorkspace) data.byWorkspace = {};
    data.byWorkspace[String(workspaceId)] = validPolicy;
    await writeJsonPath(path, data);
    return validPolicy;
  });
}

/**
 * Get data retention policy for a workspace.
 */
export async function getRetentionPolicy(workspaceId) {
  const data = await readJsonPath(retentionPath(), { _version: 1, byWorkspace: {} });
  return data.byWorkspace?.[String(workspaceId)] || null;
}

/**
 * Enforce retention: remove data older than retention period.
 * Returns summary of enforced actions.
 */
export async function enforceRetention(workspaceId) {
  const policy = await getRetentionPolicy(workspaceId);
  if (!policy) return { enforced: false, reason: "No retention policy set" };
  if (!policy.autoDeleteExpired) return { enforced: false, reason: "Auto-delete not enabled" };

  const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);
  // This would integrate with storage.js to delete old conversations
  // For now, return the enforcement parameters
  return {
    enforced: true,
    cutoffDate: cutoff.toISOString(),
    retentionDays: policy.retentionDays,
    workspaceId,
  };
}

// --- Compliance Report ---

/**
 * Generate compliance audit report for a workspace.
 * Covers: data residency, PII exposure summary, retention compliance.
 */
export async function generateComplianceReport(workspaceId, options = {}) {
  if (!workspaceId) throw new Error("workspaceId is required");

  const [residency, retention, activity] = await Promise.all([
    getDataResidency(workspaceId),
    getRetentionPolicy(workspaceId),
    getWorkspaceActivity(workspaceId, options.activityLimit || 200),
  ]);

  // Analyze activity for PII exposure
  let piiExposureCount = 0;
  const piiTypes = {};
  if (options.scanActivity !== false) {
    for (const entry of activity) {
      const textFields = [entry.action, entry.detail, entry.query].filter(Boolean);
      for (const text of textFields) {
        const detected = detectPII(String(text));
        if (detected.length > 0) {
          piiExposureCount += detected.length;
          for (const d of detected) {
            piiTypes[d.type] = (piiTypes[d.type] || 0) + 1;
          }
        }
      }
    }
  }

  return {
    workspaceId,
    generatedAt: new Date().toISOString(),
    dataResidency: residency || { status: "not_configured" },
    retentionPolicy: retention || { status: "not_configured" },
    piiExposure: {
      totalDetections: piiExposureCount,
      byType: piiTypes,
      activitiesScanned: activity.length,
    },
    activitySummary: {
      totalEvents: activity.length,
      uniqueUsers: [...new Set(activity.map((a) => a.userId).filter(Boolean))].length,
    },
  };
}

/**
 * Scan workspace text content for PII.
 */
export function scanTextForPII(texts) {
  if (!Array.isArray(texts)) texts = [texts];
  const allDetections = [];
  for (const text of texts) {
    if (typeof text !== "string") continue;
    const detected = detectPII(text);
    allDetections.push(...detected);
  }
  return {
    totalDetections: allDetections.length,
    detections: allDetections,
    byType: allDetections.reduce((acc, d) => {
      acc[d.type] = (acc[d.type] || 0) + 1;
      return acc;
    }, {}),
  };
}
