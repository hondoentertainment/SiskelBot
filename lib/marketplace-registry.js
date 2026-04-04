import { createHash, timingSafeEqual } from "crypto";
import { join } from "path";
import { getDataDir, readJsonPath, writeJsonPath, withPathLock } from "./json-path-store.js";
import { validateMarketplaceManifest } from "./marketplace-manifest.js";

function registryPath() {
  return join(getDataDir(), "marketplace", "registry.json");
}

function normalizeWorkspaceId(workspaceId) {
  const ws = String(workspaceId || "default").trim();
  return ws || "default";
}

function defaultRegistry() {
  return { _version: 1, byWorkspace: {} };
}

function makePackSummary(manifest, enabled) {
  return {
    id: manifest.id,
    version: manifest.version,
    enabled: enabled !== false,
    tools: Array.isArray(manifest.tools) ? manifest.tools.map((t) => t?.name).filter(Boolean) : [],
    installedAt: new Date().toISOString(),
  };
}

export function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * SHA-256 hex of canonical JSON for manifest without `signature` (same payload as verifyManifestSignature).
 * Operators: set signature.value to this digest after adding trusted keyId; see scripts/marketplace-manifest-digest.mjs.
 * @param {object} manifest
 * @returns {string}
 */
export function computeUnsignedManifestDigestHex(manifest) {
  if (!manifest || typeof manifest !== "object") return "";
  const unsigned = { ...manifest };
  delete unsigned.signature;
  return createHash("sha256").update(stableStringify(unsigned), "utf8").digest("hex");
}

function trustedKeyIds() {
  return String(process.env.MARKETPLACE_TRUSTED_KEY_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Signature v1:
 * - algorithm: "sha256"
 * - keyId: must exist in MARKETPLACE_TRUSTED_KEY_IDS
 * - value: sha256 hex of stable manifest JSON excluding `signature`
 */
export function verifyManifestSignature(manifest) {
  const sig = manifest?.signature;
  if (!sig || typeof sig !== "object") {
    return { ok: false, code: "SIGNATURE_REQUIRED", reason: "manifest.signature is required" };
  }
  const trusted = trustedKeyIds();
  if (!trusted.length) {
    return { ok: false, code: "TRUST_STORE_EMPTY", reason: "MARKETPLACE_TRUSTED_KEY_IDS is not configured" };
  }
  const keyId = String(sig.keyId || "").trim();
  if (!trusted.includes(keyId)) {
    return { ok: false, code: "KEY_NOT_TRUSTED", reason: `signature keyId "${keyId}" is not trusted` };
  }
  const algorithm = String(sig.algorithm || "").trim().toLowerCase();
  if (algorithm !== "sha256") {
    return { ok: false, code: "ALGORITHM_UNSUPPORTED", reason: `signature algorithm "${algorithm}" is unsupported` };
  }
  const expected = String(sig.value || "").trim().toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    return { ok: false, code: "SIGNATURE_VALUE_INVALID", reason: "signature.value must be a 64-char hex sha256 digest" };
  }
  const unsigned = { ...manifest };
  delete unsigned.signature;
  const actual = createHash("sha256").update(stableStringify(unsigned), "utf8").digest("hex");
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: "SIGNATURE_MISMATCH", reason: "signature digest mismatch" };
  }
  return { ok: true };
}

async function readRegistry() {
  const raw = await readJsonPath(registryPath(), defaultRegistry());
  if (!raw || typeof raw !== "object") return defaultRegistry();
  const byWorkspace = raw.byWorkspace && typeof raw.byWorkspace === "object" ? raw.byWorkspace : {};
  return { _version: 1, byWorkspace };
}

function workspaceNode(reg, workspaceId) {
  const ws = normalizeWorkspaceId(workspaceId);
  if (!reg.byWorkspace[ws] || typeof reg.byWorkspace[ws] !== "object") {
    reg.byWorkspace[ws] = {
      packs: [],
      policy: { allowedPackIds: [], blockedToolNames: [], allowedToolNames: [] },
    };
  }
  const n = reg.byWorkspace[ws];
  if (!Array.isArray(n.packs)) n.packs = [];
  if (!n.policy || typeof n.policy !== "object") {
    n.policy = { allowedPackIds: [], blockedToolNames: [], allowedToolNames: [] };
  }
  return n;
}

export async function listInstalledMarketplacePacks(workspaceId) {
  const reg = await readRegistry();
  const node = workspaceNode(reg, workspaceId);
  return node.packs;
}

export async function listInstalledMarketplaceSummary() {
  const reg = await readRegistry();
  const summary = [];
  for (const [workspaceId, node] of Object.entries(reg.byWorkspace || {})) {
    const packs = Array.isArray(node?.packs) ? node.packs : [];
    for (const p of packs) {
      summary.push({ workspaceId, id: p.id, version: p.version, enabled: p.enabled !== false });
    }
  }
  return summary;
}

export async function installMarketplacePack(workspaceId, manifestInput) {
  const v = validateMarketplaceManifest(manifestInput);
  if (!v.ok) {
    return { ok: false, code: "INVALID_MANIFEST", errors: v.errors };
  }
  const sig = verifyManifestSignature(v.manifest);
  if (!sig.ok) {
    return { ok: false, code: sig.code, error: sig.reason };
  }
  const ws = normalizeWorkspaceId(workspaceId);
  return withPathLock(registryPath(), async () => {
    const reg = await readRegistry();
    const node = workspaceNode(reg, ws);
    const pack = makePackSummary(v.manifest, true);
    const idx = node.packs.findIndex((p) => p && p.id === pack.id);
    if (idx >= 0) node.packs[idx] = pack;
    else node.packs.push(pack);
    await writeJsonPath(registryPath(), reg);
    return { ok: true, pack };
  });
}

export async function setMarketplacePackEnabled(workspaceId, packId, enabled) {
  const ws = normalizeWorkspaceId(workspaceId);
  const id = String(packId || "").trim();
  if (!id) return { ok: false, code: "INVALID_INPUT", error: "packId is required" };
  return withPathLock(registryPath(), async () => {
    const reg = await readRegistry();
    const node = workspaceNode(reg, ws);
    const idx = node.packs.findIndex((p) => p && p.id === id);
    if (idx === -1) return { ok: false, code: "NOT_FOUND", error: "pack not installed" };
    node.packs[idx] = { ...node.packs[idx], enabled: enabled !== false, updatedAt: new Date().toISOString() };
    await writeJsonPath(registryPath(), reg);
    return { ok: true, pack: node.packs[idx] };
  });
}

function normalizePolicy(raw) {
  const out = {
    allowedPackIds: [],
    blockedToolNames: [],
    allowedToolNames: [],
  };
  if (!raw || typeof raw !== "object") return out;
  for (const k of Object.keys(out)) {
    const arr = Array.isArray(raw[k]) ? raw[k] : [];
    out[k] = arr.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 100);
  }
  return out;
}

export async function getWorkspaceMarketplacePolicy(workspaceId) {
  const reg = await readRegistry();
  const node = workspaceNode(reg, workspaceId);
  return normalizePolicy(node.policy);
}

export async function saveWorkspaceMarketplacePolicy(workspaceId, policyInput) {
  const ws = normalizeWorkspaceId(workspaceId);
  return withPathLock(registryPath(), async () => {
    const reg = await readRegistry();
    const node = workspaceNode(reg, ws);
    node.policy = normalizePolicy(policyInput);
    await writeJsonPath(registryPath(), reg);
    return node.policy;
  });
}

export async function isMarketplaceActionAllowed(workspaceId, actionName) {
  const name = String(actionName || "").trim();
  if (!name) return { allowed: false, reason: "missing action name" };
  const policy = await getWorkspaceMarketplacePolicy(workspaceId);
  if (policy.blockedToolNames.includes(name)) {
    return { allowed: false, reason: "blocked by workspace policy" };
  }
  if (policy.allowedToolNames.length > 0 && !policy.allowedToolNames.includes(name)) {
    return { allowed: false, reason: "not in workspace allowlist" };
  }
  return { allowed: true, reason: "" };
}

export function getTrustedMarketplaceKeyIds() {
  return trustedKeyIds();
}
