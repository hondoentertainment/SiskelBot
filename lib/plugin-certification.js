/**
 * Phase 34.1: Plugin certification — trusted badges, security scanning, publisher verification.
 *
 * Provides a certification workflow on top of the existing marketplace signature
 * verification in lib/marketplace-registry.js. Certifications are persisted to
 * data/plugin-certifications.json.
 */
import { createHash, timingSafeEqual } from "crypto";
import { join } from "path";
import { getDataDir, readJsonPath, writeJsonPath, withPathLock } from "./json-path-store.js";
import { stableStringify } from "./marketplace-registry.js";

export const CERT_LEVELS = {
  unverified: { badge: "none", description: "No verification performed" },
  signed: { badge: "blue", description: "Manifest cryptographically signed by publisher" },
  verified: { badge: "green", description: "Publisher identity verified, manifest signed" },
  certified: { badge: "gold", description: "Security scan passed, audit complete, officially endorsed" },
};

const VALID_LEVELS = new Set(["signed", "verified", "certified"]);

function certificationsPath() {
  return join(getDataDir(), "plugin-certifications.json");
}

function defaultCertifications() {
  return { _version: 1, byPackId: {} };
}

async function readCertifications() {
  const raw = await readJsonPath(certificationsPath(), defaultCertifications());
  if (!raw || typeof raw !== "object") return defaultCertifications();
  const byPackId = raw.byPackId && typeof raw.byPackId === "object" ? raw.byPackId : {};
  return { _version: 1, byPackId };
}

function isSemver(version) {
  return typeof version === "string"
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version.trim());
}

/**
 * Verify a manifest signature against a list of trusted keys.
 * Supports the same v1 signature format as lib/marketplace-registry.js:
 *   { algorithm: "sha256", keyId, value }
 * where `value` is the sha256 hex of the canonical JSON (sans signature).
 *
 * @param {object} manifest
 * @param {Array<string|{id:string}>} [trustedKeys]
 * @returns {Promise<{valid:boolean, keyId?:string, publisher?:string, signedAt?:string, reason?:string, code?:string}>}
 */
export async function verifyPluginSignature(manifest, trustedKeys) {
  if (!manifest || typeof manifest !== "object") {
    return { valid: false, code: "MANIFEST_INVALID", reason: "manifest must be an object" };
  }
  const sig = manifest.signature;
  if (!sig || typeof sig !== "object") {
    return { valid: false, code: "SIGNATURE_REQUIRED", reason: "manifest.signature is required" };
  }
  const keyId = String(sig.keyId || "").trim();
  if (!keyId) {
    return { valid: false, code: "KEY_ID_REQUIRED", reason: "signature.keyId is required" };
  }
  const trustedList = Array.isArray(trustedKeys) ? trustedKeys : [];
  const trustedIds = trustedList
    .map((k) => (typeof k === "string" ? k : k && typeof k === "object" ? k.id : ""))
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  if (!trustedIds.includes(keyId)) {
    return { valid: false, code: "KEY_NOT_TRUSTED", reason: `signature keyId "${keyId}" is not trusted` };
  }
  const algorithm = String(sig.algorithm || "").trim().toLowerCase();
  if (algorithm !== "sha256") {
    return { valid: false, code: "ALGORITHM_UNSUPPORTED", reason: `algorithm "${algorithm}" is unsupported` };
  }
  const expected = String(sig.value || "").trim().toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    return { valid: false, code: "SIGNATURE_VALUE_INVALID", reason: "signature.value must be 64-char hex" };
  }
  const unsigned = { ...manifest };
  delete unsigned.signature;
  const actual = createHash("sha256").update(stableStringify(unsigned), "utf8").digest("hex");
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, code: "SIGNATURE_MISMATCH", reason: "signature digest mismatch" };
  }
  return {
    valid: true,
    keyId,
    publisher: typeof sig.publisher === "string" ? sig.publisher : undefined,
    signedAt: typeof sig.signedAt === "string" ? sig.signedAt : undefined,
  };
}

const DANGEROUS_ACTION_TYPES = new Set([
  "exec",
  "shell",
  "eval",
  "code_execute",
  "file_write",
  "delete",
]);

const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /private[_-]?key/i,
  /bearer/i,
];

function isSecretKey(key) {
  if (typeof key !== "string") return false;
  return SECRET_PATTERNS.some((re) => re.test(key));
}

/**
 * Run static analysis on a manifest and return a pass/fail plus issues list.
 *
 * Checks:
 * - webhook URLs use HTTPS (no http://)
 * - no wildcard URL patterns (contains *)
 * - no dangerous action types (exec, shell, eval, etc.)
 * - config values don't include secret-looking keys
 * - version is semver
 *
 * @param {object} manifest
 * @returns {Promise<{passed:boolean, score:number, issues:Array<{severity:string, category:string, message:string}>}>}
 */
export async function scanPluginSecurity(manifest) {
  const issues = [];
  if (!manifest || typeof manifest !== "object") {
    return {
      passed: false,
      score: 0,
      issues: [{ severity: "error", category: "manifest", message: "manifest must be an object" }],
    };
  }

  // Version must be semver
  if (!manifest.version || !isSemver(manifest.version)) {
    issues.push({
      severity: "error",
      category: "version",
      message: "version must be semver (e.g. 1.2.3)",
    });
  }

  // Collect URLs from common fields: webhooks, tools, actions, homepage, repository
  const urls = [];
  const collectUrl = (val, label) => {
    if (typeof val === "string" && /^https?:\/\//i.test(val)) {
      urls.push({ url: val, label });
    }
  };

  if (Array.isArray(manifest.webhooks)) {
    manifest.webhooks.forEach((w, i) => {
      if (w && typeof w === "object") {
        collectUrl(w.url, `webhooks[${i}].url`);
      } else if (typeof w === "string") {
        collectUrl(w, `webhooks[${i}]`);
      }
    });
  }
  collectUrl(manifest.homepage, "homepage");
  collectUrl(manifest.repository, "repository");
  if (Array.isArray(manifest.tools)) {
    manifest.tools.forEach((t, i) => {
      if (t && typeof t === "object") {
        collectUrl(t.url, `tools[${i}].url`);
        collectUrl(t.endpoint, `tools[${i}].endpoint`);
      }
    });
  }
  if (Array.isArray(manifest.actions)) {
    manifest.actions.forEach((a, i) => {
      if (a && typeof a === "object") {
        collectUrl(a.url, `actions[${i}].url`);
        collectUrl(a.endpoint, `actions[${i}].endpoint`);
      }
    });
  }

  for (const { url, label } of urls) {
    if (/^http:\/\//i.test(url)) {
      issues.push({
        severity: "error",
        category: "transport",
        message: `${label} must use https:// (found ${url})`,
      });
    }
    if (url.includes("*")) {
      issues.push({
        severity: "error",
        category: "url-pattern",
        message: `${label} contains a wildcard (${url}); wildcards are not allowed`,
      });
    }
  }

  // Dangerous action types
  const checkAction = (obj, label) => {
    if (!obj || typeof obj !== "object") return;
    const type = typeof obj.type === "string" ? obj.type.toLowerCase() : "";
    const action = typeof obj.action === "string" ? obj.action.toLowerCase() : "";
    for (const candidate of [type, action]) {
      if (candidate && DANGEROUS_ACTION_TYPES.has(candidate)) {
        issues.push({
          severity: "error",
          category: "dangerous-action",
          message: `${label} uses dangerous action type "${candidate}"`,
        });
      }
    }
  };
  if (Array.isArray(manifest.actions)) {
    manifest.actions.forEach((a, i) => checkAction(a, `actions[${i}]`));
  }
  if (Array.isArray(manifest.tools)) {
    manifest.tools.forEach((t, i) => checkAction(t, `tools[${i}]`));
  }

  // Config values shouldn't contain secrets (defaults/hardcoded)
  if (manifest.config && typeof manifest.config === "object") {
    for (const [k, v] of Object.entries(manifest.config)) {
      if (isSecretKey(k) && typeof v === "string" && v.trim() !== "") {
        issues.push({
          severity: "error",
          category: "secrets",
          message: `config.${k} appears to hardcode a secret`,
        });
      }
    }
  }
  if (manifest.defaults && typeof manifest.defaults === "object") {
    for (const [k, v] of Object.entries(manifest.defaults)) {
      if (isSecretKey(k) && typeof v === "string" && v.trim() !== "") {
        issues.push({
          severity: "error",
          category: "secrets",
          message: `defaults.${k} appears to hardcode a secret`,
        });
      }
    }
  }

  // Warnings (don't block pass, reduce score)
  if (!manifest.description || typeof manifest.description !== "string" || manifest.description.trim().length < 10) {
    issues.push({
      severity: "warning",
      category: "metadata",
      message: "description should be at least 10 characters",
    });
  }
  if (!manifest.author && !manifest.publisher) {
    issues.push({
      severity: "warning",
      category: "metadata",
      message: "author or publisher should be set",
    });
  }

  // Score: 100 base, -20 per error, -5 per warning; clamped to [0,100]
  let score = 100;
  for (const issue of issues) {
    if (issue.severity === "error") score -= 20;
    else if (issue.severity === "warning") score -= 5;
  }
  if (score < 0) score = 0;

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const passed = errorCount === 0;
  return { passed, score, issues };
}

/**
 * Persist a certification record for a given packId.
 *
 * @param {string} packId
 * @param {"signed"|"verified"|"certified"} level
 * @param {object} [metadata] - { publisher, auditUrl, certifiedBy, expiresAt }
 * @returns {Promise<{ok:boolean, certification?:object, error?:string, code?:string}>}
 */
export async function certifyPlugin(packId, level, metadata = {}) {
  const id = String(packId || "").trim();
  if (!id) return { ok: false, code: "INVALID_INPUT", error: "packId is required" };
  if (!VALID_LEVELS.has(level)) {
    return { ok: false, code: "INVALID_LEVEL", error: `level must be one of: ${[...VALID_LEVELS].join(", ")}` };
  }
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const record = {
    packId: id,
    level,
    badge: CERT_LEVELS[level].badge,
    publisher: typeof meta.publisher === "string" ? meta.publisher : null,
    auditUrl: typeof meta.auditUrl === "string" ? meta.auditUrl : null,
    certifiedBy: typeof meta.certifiedBy === "string" ? meta.certifiedBy : null,
    expiresAt: typeof meta.expiresAt === "string" ? meta.expiresAt : null,
    certifiedAt: new Date().toISOString(),
    revoked: false,
    revokedAt: null,
    revokedReason: null,
  };
  return withPathLock(certificationsPath(), async () => {
    const data = await readCertifications();
    data.byPackId[id] = record;
    await writeJsonPath(certificationsPath(), data);
    return { ok: true, certification: record };
  });
}

export async function revokeCertification(packId, reason) {
  const id = String(packId || "").trim();
  if (!id) return { ok: false, code: "INVALID_INPUT", error: "packId is required" };
  return withPathLock(certificationsPath(), async () => {
    const data = await readCertifications();
    const existing = data.byPackId[id];
    if (!existing) {
      return { ok: false, code: "NOT_FOUND", error: "certification not found" };
    }
    existing.revoked = true;
    existing.revokedAt = new Date().toISOString();
    existing.revokedReason = typeof reason === "string" ? reason : null;
    data.byPackId[id] = existing;
    await writeJsonPath(certificationsPath(), data);
    return { ok: true, certification: existing };
  });
}

export async function getCertification(packId) {
  const id = String(packId || "").trim();
  if (!id) return null;
  const data = await readCertifications();
  return data.byPackId[id] || null;
}

export async function listCertifiedPlugins(level) {
  const data = await readCertifications();
  const all = Object.values(data.byPackId || {});
  const active = all.filter((c) => c && !c.revoked);
  if (!level) return active;
  if (!VALID_LEVELS.has(level)) return [];
  return active.filter((c) => c.level === level);
}

/**
 * Render an HTML badge snippet for a certification record.
 * @param {object|null} certification
 * @returns {string}
 */
export function getCertificationBadge(certification) {
  if (!certification || typeof certification !== "object" || certification.revoked) {
    return '<span class="plugin-badge plugin-badge-none" title="No certification">unverified</span>';
  }
  const level = certification.level;
  const def = CERT_LEVELS[level];
  if (!def) {
    return '<span class="plugin-badge plugin-badge-none" title="Unknown">unverified</span>';
  }
  const color = def.badge;
  const desc = def.description.replace(/"/g, "&quot;");
  const label = level.charAt(0).toUpperCase() + level.slice(1);
  return `<span class="plugin-badge plugin-badge-${color}" title="${desc}" data-level="${level}">${label}</span>`;
}
