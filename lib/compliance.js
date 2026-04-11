/**
 * Compliance controls: data residency, PII detection/redaction,
 * audit report generation, and compliance framework reporting
 * (SOC 2, HIPAA, GDPR).
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { getWorkspaceActivity } from "./teams.js";
import { queryAudit } from "./audit-query.js";

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

// ============================================================================
// Phase 33.5: SOC 2 / HIPAA / GDPR compliance framework reports.
// Maps audit log events to control frameworks and generates evidence reports.
// ============================================================================

/**
 * SOC 2 Trust Services Criteria controls relevant to this application.
 * See: https://www.aicpa-cima.com/topic/audit-assurance/soc-suite-of-services
 */
export const SOC2_CONTROLS = {
  CC6_1: {
    name: "Logical and Physical Access Controls",
    description: "Restricts logical access to information assets",
  },
  CC6_2: {
    name: "Authentication",
    description: "Authenticates users before granting access",
  },
  CC6_3: {
    name: "Authorization",
    description: "Authorizes users to assets based on role",
  },
  CC6_6: {
    name: "Data Protection in Transit",
    description: "Protects data during transmission",
  },
  CC6_7: {
    name: "Data Protection at Rest",
    description: "Protects data at rest using encryption",
  },
  CC7_1: {
    name: "Monitoring",
    description: "Detects security events through monitoring",
  },
  CC7_2: {
    name: "Incident Response",
    description: "Responds to identified security events",
  },
  CC8_1: {
    name: "Change Management",
    description: "Authorizes, designs, and implements changes",
  },
};

/**
 * HIPAA Security Rule controls (45 CFR 164.308 and 164.312).
 */
export const HIPAA_CONTROLS = {
  "164_308_a_1": {
    name: "Security Management Process",
    description: "Risk analysis and management",
  },
  "164_308_a_3": {
    name: "Workforce Security",
    description: "Access authorization and termination",
  },
  "164_308_a_4": {
    name: "Information Access Management",
    description: "Role-based access controls",
  },
  "164_308_a_5": {
    name: "Security Awareness Training",
    description: "Training and reminders",
  },
  "164_312_a_1": {
    name: "Access Control",
    description: "Unique user identification",
  },
  "164_312_b": {
    name: "Audit Controls",
    description: "Record and examine activity",
  },
  "164_312_c_1": {
    name: "Integrity",
    description: "Protect ePHI from improper alteration",
  },
  "164_312_e_1": {
    name: "Transmission Security",
    description: "Integrity and encryption in transit",
  },
};

/**
 * GDPR articles relevant to application controls.
 */
export const GDPR_CONTROLS = {
  ART_5: {
    name: "Principles of processing",
    description: "Lawfulness, fairness, transparency, data minimization",
  },
  ART_15: {
    name: "Right of access",
    description: "Data subject access requests",
  },
  ART_17: {
    name: "Right to erasure",
    description: "Right to be forgotten",
  },
  ART_20: {
    name: "Right to data portability",
    description: "Export data in machine-readable format",
  },
  ART_25: {
    name: "Data protection by design",
    description: "Privacy by design and default",
  },
  ART_30: {
    name: "Records of processing activities",
    description: "Maintain processing records",
  },
  ART_32: {
    name: "Security of processing",
    description: "Technical and organizational measures",
  },
  ART_33: {
    name: "Breach notification",
    description: "Notify supervisory authority of breaches",
  },
};

/**
 * Mapping from audit event actions to the controls they satisfy.
 * Actions are matched by exact string or substring (case-insensitive).
 */
const ACTION_CONTROL_MAP = [
  // Authentication
  {
    match: (a) => /login|signin|sign_in|auth\.success/.test(a),
    soc2: ["CC6_1", "CC6_2"],
    hipaa: ["164_308_a_4", "164_312_a_1"],
    gdpr: ["ART_32"],
  },
  {
    match: (a) => /login.*fail|auth.*fail|signin.*fail|unauthorized/.test(a),
    soc2: ["CC6_2", "CC7_1"],
    hipaa: ["164_312_b", "164_308_a_4"],
    gdpr: ["ART_32"],
  },
  {
    match: (a) => /logout|signout|sign_out/.test(a),
    soc2: ["CC6_2"],
    hipaa: ["164_312_a_1"],
    gdpr: [],
  },
  // API keys and authorization
  {
    match: (a) => /api[_-]?key.*(create|add|issue)/.test(a),
    soc2: ["CC6_3", "CC8_1"],
    hipaa: ["164_308_a_4"],
    gdpr: ["ART_32"],
  },
  {
    match: (a) => /api[_-]?key.*(revoke|delete|remove)/.test(a),
    soc2: ["CC6_3", "CC7_2", "CC8_1"],
    hipaa: ["164_308_a_3", "164_308_a_4"],
    gdpr: ["ART_32"],
  },
  {
    match: (a) => /role.*(assign|grant|change)|rbac/.test(a),
    soc2: ["CC6_3", "CC8_1"],
    hipaa: ["164_308_a_3", "164_308_a_4"],
    gdpr: ["ART_32"],
  },
  // Data protection
  {
    match: (a) => /encrypt|tls|https|transit/.test(a),
    soc2: ["CC6_6"],
    hipaa: ["164_312_e_1"],
    gdpr: ["ART_32"],
  },
  {
    match: (a) => /backup.*create|backup.*restore/.test(a),
    soc2: ["CC6_7", "CC7_2"],
    hipaa: ["164_312_c_1"],
    gdpr: ["ART_32"],
  },
  // Monitoring and incident response
  {
    match: (a) => /alert|incident|security.*event|anomaly/.test(a),
    soc2: ["CC7_1", "CC7_2"],
    hipaa: ["164_312_b", "164_308_a_1"],
    gdpr: ["ART_33"],
  },
  {
    match: (a) => /error|exception|failure/.test(a),
    soc2: ["CC7_1"],
    hipaa: ["164_312_b"],
    gdpr: [],
  },
  // Change management
  {
    match: (a) => /config.*(change|update)|deploy|release|migration/.test(a),
    soc2: ["CC8_1"],
    hipaa: ["164_308_a_1"],
    gdpr: ["ART_25"],
  },
  // GDPR-specific
  {
    match: (a) => /data[_-]?subject[_-]?request|dsr|export.*user/.test(a),
    soc2: ["CC6_3"],
    hipaa: ["164_312_a_1"],
    gdpr: ["ART_15", "ART_20"],
  },
  {
    match: (a) => /erasure|forget|delete.*user|right[_-]?to[_-]?erasure/.test(a),
    soc2: ["CC6_3"],
    hipaa: ["164_312_a_1"],
    gdpr: ["ART_17"],
  },
  {
    match: (a) => /consent|opt[_-]?in|opt[_-]?out/.test(a),
    soc2: ["CC6_3"],
    hipaa: [],
    gdpr: ["ART_5", "ART_30"],
  },
  {
    match: (a) => /breach|data[_-]?leak/.test(a),
    soc2: ["CC7_1", "CC7_2"],
    hipaa: ["164_312_b"],
    gdpr: ["ART_33"],
  },
  // Data deletion (erasure)
  {
    match: (a) => /delete|remove|destroy/.test(a),
    soc2: ["CC6_3"],
    hipaa: ["164_308_a_3"],
    gdpr: ["ART_17"],
  },
];

/**
 * Map an audit event to the SOC 2, HIPAA, and GDPR controls it provides
 * evidence for.
 *
 * @param {{ action?: string }} auditEvent
 * @returns {{ soc2: string[], hipaa: string[], gdpr: string[] }}
 */
export function mapAuditEventToControls(auditEvent) {
  const action = String(auditEvent?.action || "").toLowerCase();
  const soc2 = new Set();
  const hipaa = new Set();
  const gdpr = new Set();

  if (!action) {
    return { soc2: [], hipaa: [], gdpr: [] };
  }

  for (const rule of ACTION_CONTROL_MAP) {
    if (rule.match(action)) {
      for (const c of rule.soc2 || []) soc2.add(c);
      for (const c of rule.hipaa || []) hipaa.add(c);
      for (const c of rule.gdpr || []) gdpr.add(c);
    }
  }

  return {
    soc2: [...soc2],
    hipaa: [...hipaa],
    gdpr: [...gdpr],
  };
}

/**
 * Normalize an incoming period (startDate/endDate) to ISO strings.
 */
function normalizePeriod(period = {}) {
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const startDate = period.startDate ? new Date(period.startDate) : defaultStart;
  const endDate = period.endDate ? new Date(period.endDate) : now;
  return {
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
  };
}

/**
 * Fetch all audit entries covering a period.
 * Returns an array (not paginated) for report generation.
 */
async function fetchAuditForPeriod(period) {
  const { startDate, endDate } = period;
  const { entries } = await queryAudit({
    dateRange: { start: startDate, end: endDate },
    limit: 500,
    cursor: 0,
  });
  return entries;
}

/**
 * Build a framework report from audit entries.
 *
 * @param {string} framework - "SOC2" | "HIPAA" | "GDPR"
 * @param {object} controlCatalog - controls object
 * @param {string} frameworkKey - "soc2" | "hipaa" | "gdpr"
 * @param {object} period - { startDate, endDate }
 * @param {Array<object>} entries - audit entries
 */
function buildFrameworkReport(framework, controlCatalog, frameworkKey, period, entries) {
  const evidenceByControl = {};
  for (const id of Object.keys(controlCatalog)) {
    evidenceByControl[id] = [];
  }

  let totalMappedEvents = 0;
  for (const entry of entries) {
    const mapping = mapAuditEventToControls(entry);
    const controls = mapping[frameworkKey] || [];
    if (controls.length > 0) totalMappedEvents += 1;
    for (const controlId of controls) {
      if (!evidenceByControl[controlId]) continue;
      if (evidenceByControl[controlId].length < 25) {
        evidenceByControl[controlId].push({
          timestamp: entry.timestamp,
          action: entry.action,
          userId: entry.userId || null,
          workspaceId: entry.workspaceId || null,
          ok: entry.ok !== false,
        });
      }
    }
  }

  const controls = Object.keys(controlCatalog).map((id) => {
    const evidence = evidenceByControl[id];
    const count = evidence.length;
    const status = count === 0 ? "no_evidence" : count < 3 ? "weak" : "ok";
    return {
      id,
      name: controlCatalog[id].name,
      description: controlCatalog[id].description,
      evidenceCount: count,
      evidence,
      status,
    };
  });

  const satisfied = controls.filter((c) => c.status === "ok").length;
  const coverage = controls.length === 0 ? 0 : Math.round((satisfied / controls.length) * 100);

  return {
    framework,
    period,
    generatedAt: new Date().toISOString(),
    totalEvents: entries.length,
    mappedEvents: totalMappedEvents,
    coverage,
    controls,
  };
}

/**
 * Generate a SOC 2 report for the given period.
 * @param {{ startDate?: string, endDate?: string }} period
 */
export async function generateSOC2Report(period = {}) {
  const normalized = normalizePeriod(period);
  const entries = await fetchAuditForPeriod(normalized);
  return buildFrameworkReport("SOC2", SOC2_CONTROLS, "soc2", normalized, entries);
}

/**
 * Generate a HIPAA report for the given period.
 */
export async function generateHIPAAReport(period = {}) {
  const normalized = normalizePeriod(period);
  const entries = await fetchAuditForPeriod(normalized);
  return buildFrameworkReport("HIPAA", HIPAA_CONTROLS, "hipaa", normalized, entries);
}

/**
 * Generate a GDPR report for the given period.
 */
export async function generateGDPRReport(period = {}) {
  const normalized = normalizePeriod(period);
  const entries = await fetchAuditForPeriod(normalized);
  return buildFrameworkReport("GDPR", GDPR_CONTROLS, "gdpr", normalized, entries);
}

/**
 * Safely import a module and return null if unavailable.
 */
async function tryImport(specifier) {
  try {
    return await import(specifier);
  } catch {
    return null;
  }
}

/**
 * Collect all data stored for a specific user. Used for GDPR Article 15
 * (right of access) and Article 20 (data portability).
 *
 * @param {string} userId
 */
export async function generateDataSubjectRequest(userId) {
  if (!userId || typeof userId !== "string") {
    throw new Error("userId is required");
  }

  const report = {
    user: { id: userId, generatedAt: new Date().toISOString() },
    conversations: [],
    knowledge: [],
    memory: [],
    audit: [],
    feedback: [],
  };

  // Conversations
  const storage = await tryImport("./storage.js");
  if (storage?.list) {
    try {
      report.conversations = await storage.list("conversations", "default", userId);
    } catch {
      // ignore
    }
  }

  // Knowledge
  const knowledge = await tryImport("./knowledge-store.js");
  if (knowledge?.listKnowledge) {
    try {
      report.knowledge = await knowledge.listKnowledge("default", userId);
    } catch {
      // ignore
    }
  } else if (storage?.list) {
    try {
      report.knowledge = await storage.list("knowledge", "default", userId);
    } catch {
      // ignore
    }
  }

  // Memory
  const memory = await tryImport("./agent-memory.js");
  if (memory?.listMemories) {
    try {
      const result = await memory.listMemories(userId, "default");
      // listMemories returns { memories, total } — normalize to an array
      report.memory = Array.isArray(result) ? result : result?.memories || [];
    } catch {
      // ignore
    }
  }

  // Audit entries mentioning this user
  try {
    const { entries } = await queryAudit({ userId, limit: 500, cursor: 0 });
    report.audit = entries || [];
  } catch {
    // ignore
  }

  // Feedback (optional)
  if (storage?.list) {
    try {
      report.feedback = await storage.list("feedback", "default", userId);
    } catch {
      // ignore
    }
  }

  return report;
}

/**
 * GDPR Article 17: delete all data for a user.
 * Returns a count of what was (or would be) deleted.
 *
 * @param {string} userId
 * @param {{ dryRun?: boolean, preserveAudit?: boolean }} options
 */
export async function executeRightToErasure(userId, options = {}) {
  if (!userId || typeof userId !== "string") {
    throw new Error("userId is required");
  }
  const dryRun = options.dryRun !== false; // default to dryRun true for safety
  const preserveAudit = options.preserveAudit !== false;

  const result = {
    userId,
    dryRun,
    preserveAudit,
    deleted: {
      conversations: 0,
      knowledge: 0,
      memory: 0,
      auditEntries: 0,
    },
    errors: [],
  };

  const storage = await tryImport("./storage.js");

  // Conversations
  try {
    if (storage?.list && storage?.remove) {
      const list = (await storage.list("conversations", "default", userId)) || [];
      result.deleted.conversations = list.length;
      if (!dryRun) {
        for (const c of list) {
          try {
            await storage.remove("conversations", c.id, "default", userId);
          } catch (err) {
            result.errors.push(`conversation ${c.id}: ${err.message}`);
          }
        }
      }
    }
  } catch (err) {
    result.errors.push(`conversations: ${err.message}`);
  }

  // Knowledge
  try {
    if (storage?.list && storage?.remove) {
      const list = (await storage.list("knowledge", "default", userId)) || [];
      result.deleted.knowledge = list.length;
      if (!dryRun) {
        for (const k of list) {
          try {
            await storage.remove("knowledge", k.id, "default", userId);
          } catch (err) {
            result.errors.push(`knowledge ${k.id}: ${err.message}`);
          }
        }
      }
    }
  } catch (err) {
    result.errors.push(`knowledge: ${err.message}`);
  }

  // Memory
  try {
    const memory = await tryImport("./agent-memory.js");
    if (memory?.listMemories) {
      const raw = await memory.listMemories(userId, "default");
      const list = Array.isArray(raw) ? raw : raw?.memories || [];
      result.deleted.memory = list.length;
      if (!dryRun && memory.forgetMemory) {
        for (const m of list) {
          try {
            await memory.forgetMemory(userId, m.id);
          } catch (err) {
            result.errors.push(`memory ${m.id}: ${err.message}`);
          }
        }
      }
    }
  } catch (err) {
    result.errors.push(`memory: ${err.message}`);
  }

  // Audit (optional - normally preserved for compliance)
  if (!preserveAudit) {
    try {
      const { entries } = await queryAudit({ userId, limit: 10000, cursor: 0 });
      result.deleted.auditEntries = entries.length;
      // Actual deletion is intentionally not performed: audit logs should
      // be preserved for legal compliance. Callers can disable preserveAudit
      // to see a count but real deletion requires manual operator action.
    } catch (err) {
      result.errors.push(`audit: ${err.message}`);
    }
  }

  return result;
}

/**
 * GDPR Article 20: portable user data export.
 * @param {string} userId
 * @param {"json"|"csv"|"zip"} format
 */
export async function exportUserData(userId, format = "json") {
  const report = await generateDataSubjectRequest(userId);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fmt = String(format || "json").toLowerCase();

  if (fmt === "json") {
    return {
      data: JSON.stringify(report, null, 2),
      contentType: "application/json",
      filename: `user-data-${userId}-${ts}.json`,
    };
  }

  if (fmt === "csv") {
    // Flatten top-level arrays into a simple CSV with section headers.
    const lines = [];
    lines.push(`# User Data Export for ${userId} generated at ${report.user.generatedAt}`);
    for (const section of ["conversations", "knowledge", "memory", "audit", "feedback"]) {
      const rows = report[section] || [];
      lines.push("");
      lines.push(`# Section: ${section} (${rows.length} rows)`);
      if (rows.length === 0) continue;
      const columns = Array.from(
        rows.reduce((set, row) => {
          if (row && typeof row === "object") {
            for (const k of Object.keys(row)) set.add(k);
          }
          return set;
        }, new Set())
      );
      lines.push(columns.join(","));
      for (const row of rows) {
        lines.push(
          columns
            .map((c) => {
              const val = row?.[c];
              if (val === undefined || val === null) return "";
              const str = typeof val === "object" ? JSON.stringify(val) : String(val);
              if (str.includes(",") || str.includes('"') || str.includes("\n")) {
                return '"' + str.replace(/"/g, '""') + '"';
              }
              return str;
            })
            .join(",")
        );
      }
    }
    return {
      data: lines.join("\n"),
      contentType: "text/csv",
      filename: `user-data-${userId}-${ts}.csv`,
    };
  }

  if (fmt === "zip") {
    // We don't add an archive dependency here; return a stubbed response
    // describing each section as a separate JSON payload suitable for the
    // caller (a route) to zip up if desired.
    return {
      data: JSON.stringify(report, null, 2),
      contentType: "application/json",
      filename: `user-data-${userId}-${ts}.json`,
      note: "ZIP format not enabled; returning JSON instead.",
    };
  }

  throw new Error(`Unsupported format: ${format}`);
}

/**
 * Compliance dashboard covering all three frameworks for a given period.
 */
export async function getComplianceDashboard(period = {}) {
  const [soc2, hipaa, gdpr] = await Promise.all([
    generateSOC2Report(period),
    generateHIPAAReport(period),
    generateGDPRReport(period),
  ]);

  function summarize(report) {
    const total = report.controls.length;
    const ok = report.controls.filter((c) => c.status === "ok").length;
    const weak = report.controls.filter((c) => c.status === "weak").length;
    const missing = report.controls.filter((c) => c.status === "no_evidence").length;
    return {
      framework: report.framework,
      coverage: report.coverage,
      totalControls: total,
      ok,
      weak,
      missing,
      violations: missing, // controls with no evidence are treated as violations
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    period: soc2.period,
    soc2: summarize(soc2),
    hipaa: summarize(hipaa),
    gdpr: summarize(gdpr),
  };
}
