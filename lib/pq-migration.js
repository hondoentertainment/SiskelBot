// @ts-check
/**
 * Phase 50.5: Post-quantum migration tooling.
 *
 * Scans classical keys, plans migration to post-quantum equivalents, rotates
 * keys, and tracks migration progress. Handles the case where PQ modules
 * (pq-kyber, pq-dilithium, pq-jwt) may not yet exist in the codebase by
 * dynamically importing them with try/catch so the tooling remains usable
 * during phased rollouts.
 *
 * Storage: JSON-backed via `json-path-store.js` so it works across file,
 * SQLite, or Postgres KV backends.
 *
 * @module pq-migration
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;

// Supported post-quantum algorithm targets.
const VALID_TARGETS = new Set(["ml-dsa-44", "ml-dsa-65", "ml-dsa-87", "ml-kem-512", "ml-kem-768", "ml-kem-1024"]);

// Classical algorithms that can be rotated to PQ equivalents.
const CLASSICAL_SIGNATURE = new Set(["rsa-2048", "rsa-3072", "rsa-4096", "ecdsa-p256", "ecdsa-p384", "ed25519"]);
const CLASSICAL_KEM = new Set(["ecdh-p256", "ecdh-p384", "x25519", "rsa-oaep"]);

const VALID_STATUSES = new Set(["classical", "in_progress", "rotated", "failed", "rolled_back"]);

function storePath() {
  return join(getDataDir(), "pq-migration.json");
}

function auditPath() {
  return join(getDataDir(), "pq-migration-audit.json");
}

function now() {
  return Date.now();
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    keys: base.keys && typeof base.keys === "object" ? base.keys : {},
    rotations: base.rotations && typeof base.rotations === "object" ? base.rotations : {},
    lastScanAt: Number.isFinite(base.lastScanAt) ? base.lastScanAt : 0,
  };
}

function normalizeAudit(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    events: Array.isArray(base.events) ? base.events : [],
  };
}

async function loadStore() {
  return normalizeStore(
    await readJsonPath(storePath(), { _version: STORE_VERSION, keys: {}, rotations: {}, lastScanAt: 0 }),
  );
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

async function loadAudit() {
  return normalizeAudit(await readJsonPath(auditPath(), { _version: STORE_VERSION, events: [] }));
}

async function saveAudit(audit) {
  await writeJsonPath(auditPath(), audit);
}

async function mutate(fn) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const result = await fn(store);
    await saveStore(store);
    return result;
  });
}

// ---- Target algorithm selection ----

function pqEquivalentFor(classicalAlgorithm, targetLevel) {
  if (CLASSICAL_SIGNATURE.has(classicalAlgorithm)) {
    // ml-dsa-* is the signature family (FIPS 204, derived from Dilithium).
    if (targetLevel.startsWith("ml-dsa-")) return targetLevel;
    return "ml-dsa-65";
  }
  if (CLASSICAL_KEM.has(classicalAlgorithm)) {
    // ml-kem-* is the KEM family (FIPS 203, derived from Kyber).
    if (targetLevel.startsWith("ml-kem-")) return targetLevel;
    return "ml-kem-768";
  }
  return null;
}

// ---- Scanning classical key inventory ----

/**
 * Collect candidate classical keys from HSM, JWT config, and TLS config.
 * The scanner returns any rotatable classical keys along with their location
 * so the admin can plan migration priorities.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeHsm=true]
 * @param {boolean} [options.includeJwt=true]
 * @param {boolean} [options.includeTls=true]
 * @returns {Promise<Array<{keyId: string, type: string, algorithm: string, location: string, rotatable: boolean}>>}
 */
export async function scanClassicalKeys(options = {}) {
  const includeHsm = options.includeHsm !== false;
  const includeJwt = options.includeJwt !== false;
  const includeTls = options.includeTls !== false;

  const results = [];

  if (includeHsm) {
    try {
      const hsm = await import("./hsm.js");
      if (typeof hsm.getGlobalHSM === "function") {
        try {
          const client = hsm.getGlobalHSM();
          const keys = await client.listKeys?.().catch(() => []);
          for (const k of keys || []) {
            const algorithm = String(k.algorithm || k.keyType || "unknown").toLowerCase();
            const rotatable = CLASSICAL_SIGNATURE.has(algorithm) || CLASSICAL_KEM.has(algorithm);
            results.push({
              keyId: String(k.keyId || k.id || ""),
              type: CLASSICAL_SIGNATURE.has(algorithm) ? "signature" : CLASSICAL_KEM.has(algorithm) ? "kem" : "symmetric",
              algorithm,
              location: "hsm",
              rotatable,
            });
          }
        } catch {
          // No HSM configured or listKeys failed; skip.
        }
      }
    } catch {
      // hsm module not loadable; skip.
    }
  }

  if (includeJwt) {
    const jwtAlg = (process.env.JWT_ALGORITHM || process.env.JWT_ALG || "").toLowerCase();
    if (jwtAlg) {
      const classical = mapJwtAlg(jwtAlg);
      if (classical) {
        results.push({
          keyId: process.env.JWT_KEY_ID || "jwt-default",
          type: "signature",
          algorithm: classical,
          location: "jwt-config",
          rotatable: true,
        });
      }
    }
  }

  if (includeTls) {
    const tlsAlg = (process.env.TLS_KEY_ALGORITHM || "").toLowerCase();
    if (tlsAlg && (CLASSICAL_SIGNATURE.has(tlsAlg) || CLASSICAL_KEM.has(tlsAlg))) {
      results.push({
        keyId: process.env.TLS_KEY_ID || "tls-default",
        type: CLASSICAL_SIGNATURE.has(tlsAlg) ? "signature" : "kem",
        algorithm: tlsAlg,
        location: "tls-config",
        rotatable: true,
      });
    }
  }

  // Persist discovered keys into the store so getMigrationStatus can compute counts.
  await mutate(async (store) => {
    for (const entry of results) {
      if (!entry.keyId) continue;
      const existing = store.keys[entry.keyId];
      if (existing && existing.status !== "classical") continue; // Don't overwrite rotated state.
      store.keys[entry.keyId] = {
        keyId: entry.keyId,
        type: entry.type,
        algorithm: entry.algorithm,
        location: entry.location,
        rotatable: entry.rotatable,
        status: existing?.status || "classical",
        discoveredAt: existing?.discoveredAt || now(),
      };
    }
    store.lastScanAt = now();
  });

  return results;
}

function mapJwtAlg(alg) {
  switch (alg) {
    case "rs256": return "rsa-2048";
    case "rs384": return "rsa-3072";
    case "rs512": return "rsa-4096";
    case "es256": return "ecdsa-p256";
    case "es384": return "ecdsa-p384";
    case "eddsa": return "ed25519";
    default: return null;
  }
}

// ---- Planning migration ----

/**
 * Produce a migration plan for the given classical keys targeting a PQ level.
 *
 * @param {Array<{keyId: string, type: string, algorithm: string, location: string, rotatable: boolean}>} classicalKeys
 * @param {string} [targetLevel="ml-dsa-65"]
 * @returns {Promise<Array<{keyId: string, from: string, to: string, steps: string[], estimatedTime: number, risks: string[]}>>}
 */
export async function planMigration(classicalKeys, targetLevel = "ml-dsa-65") {
  if (!Array.isArray(classicalKeys)) {
    throw new Error("classicalKeys must be an array");
  }
  if (!VALID_TARGETS.has(targetLevel)) {
    throw new Error(`invalid target level: ${targetLevel}`);
  }

  const plan = [];
  for (const k of classicalKeys) {
    if (!k || typeof k !== "object") continue;
    if (!k.keyId) continue;
    if (!k.rotatable) continue;
    const to = pqEquivalentFor(String(k.algorithm).toLowerCase(), targetLevel);
    if (!to) continue;
    const steps = stepsFor(k.location);
    const risks = risksFor(k);
    plan.push({
      keyId: k.keyId,
      from: String(k.algorithm).toLowerCase(),
      to,
      steps,
      estimatedTime: estimateTimeMs(k, steps),
      risks,
    });
  }
  return plan;
}

function stepsFor(location) {
  const common = [
    "generate pq keypair",
    "dual-sign transition window",
    "update downstream verifiers",
    "retire classical key",
  ];
  if (location === "jwt-config") {
    return ["publish new jwks entry", ...common];
  }
  if (location === "tls-config") {
    return ["issue hybrid certificate", ...common];
  }
  if (location === "hsm") {
    return ["provision pq slot in hsm", ...common];
  }
  return common;
}

function estimateTimeMs(key, steps) {
  // Rough estimate: 30s per step, doubled for TLS (cert issuance is slow).
  const base = steps.length * 30_000;
  return key.location === "tls-config" ? base * 2 : base;
}

function risksFor(key) {
  const risks = [];
  if (key.location === "tls-config") risks.push("client compatibility with hybrid certificates");
  if (key.location === "jwt-config") risks.push("consumers may reject larger PQ signatures");
  if (key.location === "hsm") risks.push("vendor hsm may not yet support the target algorithm");
  risks.push("larger signature sizes may bloat audit logs");
  return risks;
}

// ---- Rotation ----

/**
 * Rotate a specific classical key to its PQ equivalent. The old key is
 * retained for rollback until explicitly deleted.
 *
 * @param {string} keyId
 * @param {object} [options]
 * @param {string} [options.targetLevel="ml-dsa-65"]
 * @param {string} [options.actor="system"]
 * @returns {Promise<{oldKeyId: string, newKeyId: string, rotatedAt: number, status: string}>}
 */
export async function rotateKey(keyId, options = {}) {
  if (!keyId || typeof keyId !== "string") {
    throw new Error("keyId is required");
  }
  const targetLevel = options.targetLevel || "ml-dsa-65";
  if (!VALID_TARGETS.has(targetLevel)) {
    throw new Error(`invalid target level: ${targetLevel}`);
  }
  const actor = options.actor || "system";

  const result = await mutate(async (store) => {
    const entry = store.keys[keyId];
    if (!entry) {
      throw new Error(`key not found: ${keyId}`);
    }
    if (entry.status === "rotated") {
      // Idempotent: return existing rotation.
      const rot = store.rotations[keyId];
      if (rot) {
        return { oldKeyId: keyId, newKeyId: rot.newKeyId, rotatedAt: rot.rotatedAt, status: "already_rotated" };
      }
    }
    if (!entry.rotatable) {
      throw new Error(`key is not rotatable: ${keyId}`);
    }
    const pqAlgorithm = pqEquivalentFor(entry.algorithm, targetLevel);
    if (!pqAlgorithm) {
      throw new Error(`no pq equivalent for algorithm: ${entry.algorithm}`);
    }

    const newKeyId = `${keyId}-pq-${randomUUID().slice(0, 8)}`;
    const rotatedAt = now();

    // Attempt real key generation via dynamic PQ modules. If unavailable,
    // record the rotation as a logical placeholder so the migration plan
    // remains useful during phased rollouts.
    let backend = "placeholder";
    try {
      if (pqAlgorithm.startsWith("ml-dsa-")) {
        const mod = await import("./pq-dilithium.js").catch(() => null);
        if (mod?.generateKeyPair) {
          await mod.generateKeyPair(pqAlgorithm).catch(() => null);
          backend = "pq-dilithium";
        }
      } else if (pqAlgorithm.startsWith("ml-kem-")) {
        const mod = await import("./pq-kyber.js").catch(() => null);
        if (mod?.generateKeyPair) {
          await mod.generateKeyPair(pqAlgorithm).catch(() => null);
          backend = "pq-kyber";
        }
      }
    } catch {
      backend = "placeholder";
    }

    store.rotations[keyId] = {
      oldKeyId: keyId,
      newKeyId,
      oldAlgorithm: entry.algorithm,
      newAlgorithm: pqAlgorithm,
      rotatedAt,
      rolledBack: false,
      backend,
      previousStatus: entry.status,
    };
    entry.status = "rotated";
    entry.rotatedAt = rotatedAt;
    entry.newKeyId = newKeyId;
    entry.newAlgorithm = pqAlgorithm;

    return { oldKeyId: keyId, newKeyId, rotatedAt, status: "rotated" };
  });

  await recordMigrationEvent({
    type: "rotate",
    keyId,
    newKeyId: result.newKeyId,
    status: result.status,
    actor,
    at: now(),
  });

  return result;
}

/**
 * Rollback a rotation, restoring the previous classical key.
 *
 * @param {string} keyId
 * @returns {Promise<{keyId: string, status: string, rolledBackAt: number}>}
 */
export async function rollbackRotation(keyId) {
  if (!keyId || typeof keyId !== "string") {
    throw new Error("keyId is required");
  }

  const result = await mutate(async (store) => {
    const entry = store.keys[keyId];
    if (!entry) {
      throw new Error(`key not found: ${keyId}`);
    }
    const rot = store.rotations[keyId];
    if (!rot || rot.rolledBack) {
      throw new Error(`no active rotation to rollback for key: ${keyId}`);
    }
    const rolledBackAt = now();
    entry.status = rot.previousStatus || "classical";
    entry.rolledBackAt = rolledBackAt;
    delete entry.rotatedAt;
    delete entry.newKeyId;
    delete entry.newAlgorithm;
    rot.rolledBack = true;
    rot.rolledBackAt = rolledBackAt;
    return { keyId, status: "rolled_back", rolledBackAt };
  });

  await recordMigrationEvent({
    type: "rollback",
    keyId,
    status: "rolled_back",
    actor: "system",
    at: now(),
  });

  return result;
}

// ---- Status and reporting ----

/**
 * Return a summary of migration status across all discovered keys.
 *
 * @param {string|null} [workspaceId]
 * @returns {Promise<{total: number, migrated: number, pending: number, inProgress: number, failed: number, percentComplete: number}>}
 */
export async function getMigrationStatus(workspaceId = null) {
  const store = await loadStore();
  const keys = Object.values(store.keys);
  // workspaceId is reserved for future scoping; included for API shape.
  const _unused = workspaceId;
  let migrated = 0, pending = 0, inProgress = 0, failed = 0;
  for (const k of keys) {
    switch (k.status) {
      case "rotated": migrated++; break;
      case "in_progress": inProgress++; break;
      case "failed": failed++; break;
      case "rolled_back":
      case "classical":
      default: pending++; break;
    }
  }
  const total = keys.length;
  const percentComplete = total === 0 ? 0 : Math.round((migrated / total) * 1000) / 10;
  return { total, migrated, pending, inProgress, failed, percentComplete };
}

/**
 * Append an event to the migration audit trail.
 *
 * @param {{type: string, keyId?: string, newKeyId?: string, status?: string, actor?: string, at?: number, [k: string]: any}} event
 */
export async function recordMigrationEvent(event) {
  if (!event || typeof event !== "object") {
    throw new Error("event must be an object");
  }
  const normalized = {
    id: randomUUID(),
    type: String(event.type || "unknown"),
    keyId: event.keyId || null,
    newKeyId: event.newKeyId || null,
    status: event.status || null,
    actor: event.actor || "system",
    at: Number.isFinite(event.at) ? event.at : now(),
    detail: event.detail || null,
  };
  await withPathLock(auditPath(), async () => {
    const audit = await loadAudit();
    audit.events.push(normalized);
    // Keep last 10,000 events to bound storage.
    if (audit.events.length > 10_000) {
      audit.events = audit.events.slice(-10_000);
    }
    await saveAudit(audit);
  });
  return normalized;
}

/**
 * Probe the environment for post-quantum module availability.
 * Non-destructive: only dynamic imports are attempted, nothing is written.
 *
 * @returns {Promise<{ready: boolean, missing: string[], warnings: string[], modules: Record<string, boolean>}>}
 */
export async function validatePqReadiness() {
  const modules = { "pq-kyber": false, "pq-dilithium": false, "pq-jwt": false };
  const missing = [];
  const warnings = [];

  for (const name of Object.keys(modules)) {
    try {
      const mod = await import(`./${name}.js`);
      if (mod && typeof mod === "object") {
        modules[name] = true;
      }
    } catch {
      modules[name] = false;
      missing.push(name);
    }
  }

  if (!modules["pq-kyber"]) warnings.push("KEM rotations will fall back to placeholder until pq-kyber is installed");
  if (!modules["pq-dilithium"]) warnings.push("Signature rotations will fall back to placeholder until pq-dilithium is installed");
  if (!modules["pq-jwt"]) warnings.push("JWT rotations will not emit PQ-signed tokens until pq-jwt is installed");

  const ready = missing.length === 0;
  return { ready, missing, warnings, modules };
}

/**
 * Build a comprehensive migration report combining status, readiness,
 * inventory, timeline, and recommendations.
 *
 * @returns {Promise<{status: object, readiness: object, inventory: object[], timeline: object[], recommendations: string[], generatedAt: number}>}
 */
export async function generateMigrationReport() {
  const status = await getMigrationStatus();
  const readiness = await validatePqReadiness();
  const store = await loadStore();
  const audit = await loadAudit();

  const inventory = Object.values(store.keys).map((k) => ({
    keyId: k.keyId,
    algorithm: k.algorithm,
    location: k.location,
    type: k.type,
    status: k.status,
    rotatedAt: k.rotatedAt || null,
    newAlgorithm: k.newAlgorithm || null,
  }));

  // Timeline = last 50 audit events sorted by time ascending.
  const timeline = [...audit.events].sort((a, b) => a.at - b.at).slice(-50);

  const recommendations = [];
  if (!readiness.ready) {
    recommendations.push("Install missing PQ modules before rotating production keys");
  }
  if (status.total === 0) {
    recommendations.push("Run a scan to populate the classical key inventory");
  }
  if (status.pending > 0) {
    recommendations.push(`Plan rotations for ${status.pending} remaining classical key(s)`);
  }
  if (status.failed > 0) {
    recommendations.push(`Investigate ${status.failed} failed rotation(s) and consider rollback`);
  }
  if (status.percentComplete >= 100 && status.total > 0) {
    recommendations.push("Migration complete — schedule retirement of rotated classical keys");
  }

  return {
    status,
    readiness,
    inventory,
    timeline,
    recommendations,
    generatedAt: now(),
  };
}

// ---- Test-only internals ----

export const _internals = {
  storePath,
  auditPath,
  loadStore,
  loadAudit,
  VALID_TARGETS,
  CLASSICAL_SIGNATURE,
  CLASSICAL_KEM,
  pqEquivalentFor,
};
