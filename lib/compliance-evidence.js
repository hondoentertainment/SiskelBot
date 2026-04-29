/**
 * Wave 19A: SOC2 compliance evidence collector.
 * Snapshots compliance-relevant state for auditors.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";
import { listAllUsers, listAllWorkspaces, getRecentAuditLog } from "./admin-data.js";

const EVIDENCE_VERSION = "1.0";

function storageKey(date) {
  return join(getDataDir(), "compliance", `evidence-${date}.json`);
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

async function collectAccessControl() {
  let workspaceCount = 0;
  let userCount = 0;
  let adminCount = 0;

  try {
    const users = await listAllUsers();
    userCount = users.length;

    const adminIds = new Set(
      (process.env.QUOTA_ADMIN_USER_IDS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    adminCount = users.filter((u) => adminIds.has(u.userId)).length;

    const workspaces = await listAllWorkspaces();
    workspaceCount = workspaces.length;
  } catch (_) {
    // best-effort; may not have access at collection time
  }

  const mfaConfigured = Boolean(
    process.env.OIDC_ISSUER ||
    process.env.SAML_ENTRY_POINT ||
    process.env.WEBAUTHN_ENABLED === "1"
  );

  return { workspaceCount, userCount, adminCount, mfaConfigured };
}

async function collectAuditLogging() {
  const retentionDays = parseInt(process.env.AUDIT_RETENTION_DAYS || "90", 10);
  let loginEventsLast30Days = 0;
  let failedLoginsLast30Days = 0;

  try {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const entries = await getRecentAuditLog(5000);
    for (const e of entries) {
      const ts = e?.ts ? new Date(e.ts).getTime() : 0;
      if (ts < cutoff) continue;
      const action = String(e?.action || "").toLowerCase();
      if (/login|signin|auth\.success/.test(action)) loginEventsLast30Days++;
      if (/auth\.fail|login\.fail|invalid.*key|unauthorized/.test(action)) failedLoginsLast30Days++;
    }
  } catch (_) {
    // best-effort
  }

  return { loginEventsLast30Days, failedLoginsLast30Days, retentionDays };
}

function collectAuthMethods() {
  return {
    oidc: Boolean(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID),
    saml: Boolean(process.env.SAML_ENTRY_POINT && process.env.SAML_ISSUER),
    github: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    ldap: Boolean(process.env.LDAP_URL),
  };
}

function collectDataProtection() {
  const storageBackend = process.env.STORAGE_BACKEND || "file";
  const dbUrl = process.env.DATABASE_URL || "";
  const databaseSsl =
    dbUrl.includes("sslmode=require") || dbUrl.includes("ssl=true");
  const sessionSecretSet = Boolean(process.env.SESSION_SECRET);
  return { storageBackend, databaseSsl, sessionSecretSet };
}

function collectAvailability() {
  return {
    uptimeSeconds: Math.floor(process.uptime()),
    nodeVersion: process.version,
    platform: process.platform,
  };
}

/**
 * Run a full compliance evidence collection.
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function collectEvidence(options = {}) {
  const [accessControl, auditLogging] = await Promise.all([
    collectAccessControl(),
    collectAuditLogging(),
  ]);

  return {
    collectedAt: new Date().toISOString(),
    version: EVIDENCE_VERSION,
    controls: {
      accessControl,
      auditLogging,
      authMethods: collectAuthMethods(),
      dataProtection: collectDataProtection(),
      availability: collectAvailability(),
    },
  };
}

/**
 * Save evidence snapshot to storage.
 * @param {object} evidence
 * @returns {Promise<string>} storage key
 */
export async function saveEvidenceSnapshot(evidence) {
  const date = (evidence?.collectedAt || new Date().toISOString()).slice(0, 10);
  const key = storageKey(date);
  await writeJsonPath(key, evidence);
  return key;
}

/**
 * List past evidence snapshots, most recent first.
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @returns {Promise<Array<{key: string, collectedAt: string, summary: object}>>}
 */
export async function listEvidenceSnapshots({ limit = 30 } = {}) {
  const indexKey = join(getDataDir(), "compliance", "evidence-index.json");
  const index = await readJsonPath(indexKey, { keys: [] });
  const keys = Array.isArray(index.keys) ? index.keys : [];
  const recent = keys.slice().reverse().slice(0, limit);

  const results = await Promise.all(
    recent.map(async (k) => {
      try {
        const data = await readJsonPath(k, null);
        if (!data) return null;
        return {
          key: k,
          collectedAt: data.collectedAt,
          summary: {
            workspaceCount: data.controls?.accessControl?.workspaceCount ?? 0,
            authMethods: data.controls?.authMethods ?? {},
            databaseSsl: data.controls?.dataProtection?.databaseSsl ?? false,
          },
        };
      } catch (_) {
        return null;
      }
    })
  );

  return results.filter(Boolean);
}

/**
 * Register a snapshot key in the persistent index.
 * @param {string} key
 */
export async function registerSnapshotKey(key) {
  const indexKey = join(getDataDir(), "compliance", "evidence-index.json");
  const index = await readJsonPath(indexKey, { keys: [] });
  const keys = Array.isArray(index.keys) ? index.keys : [];
  if (!keys.includes(key)) {
    keys.push(key);
    await writeJsonPath(indexKey, { keys });
  }
}

/**
 * Collect, save, and index a new evidence snapshot.
 * @param {object} [options]
 * @returns {Promise<{evidence: object, key: string}>}
 */
export async function collectAndSave(options = {}) {
  const evidence = await collectEvidence(options);
  const key = await saveEvidenceSnapshot(evidence);
  await registerSnapshotKey(key);
  return { evidence, key };
}

/**
 * Get a specific evidence snapshot by YYYY-MM-DD date string.
 * @param {string} date
 * @returns {Promise<object|null>}
 */
export async function getEvidenceByDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const key = storageKey(date);
  const data = await readJsonPath(key, null);
  return data && typeof data === "object" && data.version ? data : null;
}
