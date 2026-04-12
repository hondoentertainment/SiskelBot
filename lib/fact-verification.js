/**
 * Phase 68.3: Fact verification — verify agent-output claims against authoritative sources.
 *
 * Complements Phase 67.3 (factuality cross-ref for general content); this
 * module focuses on the agent-output pipeline. It records verifications
 * against specific agent runs and messages so evaluations + audits can trace
 * back which statements an agent made were checked and what the verdict was.
 *
 * Storage:
 *   data/fact-verification/{id}.json   — verification record
 *   data/fact-verification/_index.json — registry
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { verifyClaim as crossRef, listSources as listCrossrefSources } from "./factuality-crossref.js";

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function verificationPath(id) {
  return join(getDataDir(), "fact-verification", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "fact-verification", "_index.json");
}

async function updateIndex(id, remove = false, entry = null) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { verifications: [] });
    const list = Array.isArray(idx.verifications) ? idx.verifications : [];
    const filtered = list.filter((e) => e.id !== id);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { verifications: filtered });
  });
}

// ─── Verification ──────────────────────────────────────────────────────────

/**
 * Verify a claim from agent output and persist the result.
 *
 * @param {object} opts
 * @param {string} opts.claim
 * @param {string} [opts.agentRunId]
 * @param {string} [opts.messageId]
 * @param {string} [opts.modelId]
 * @param {string[]} [opts.sourceIds]
 * @param {function} [opts.verifier] — test hook; defaults to factuality-crossref verifyClaim
 */
export async function verifyFact({
  claim,
  agentRunId,
  messageId,
  modelId,
  sourceIds,
  verifier,
} = {}) {
  if (!claim || typeof claim !== "string") {
    throw new Error("claim is required");
  }
  const fn = typeof verifier === "function" ? verifier : (args) => crossRef(args);
  const crossResult = await fn({ claim, sourceIds });
  const id = randomUUID();
  const now = new Date().toISOString();
  const record = {
    id,
    claim,
    agentRunId: agentRunId || null,
    messageId: messageId || null,
    modelId: modelId || null,
    verdict: crossResult.verdict || "unverified",
    confidence: typeof crossResult.confidence === "number" ? crossResult.confidence : null,
    sourceResults: Array.isArray(crossResult.sourceResults) ? crossResult.sourceResults : [],
    patternCheck: crossResult.patternCheck || null,
    verifiedAt: now,
  };
  await writeJsonPath(verificationPath(id), record);
  await updateIndex(id, false, {
    id,
    agentRunId: record.agentRunId,
    messageId: record.messageId,
    verdict: record.verdict,
    verifiedAt: now,
  });
  return record;
}

export async function getVerification(id) {
  if (!id) return null;
  const rec = await readJsonPath(verificationPath(id), null);
  if (!rec || !rec.id || rec._deleted) return null;
  return rec;
}

export async function listVerifications(filter = {}) {
  const idx = await readJsonPath(indexPath(), { verifications: [] });
  const entries = Array.isArray(idx.verifications) ? idx.verifications : [];
  const records = [];
  for (const entry of entries) {
    const rec = await getVerification(entry.id);
    if (!rec) continue;
    if (filter.agentRunId && rec.agentRunId !== filter.agentRunId) continue;
    if (filter.messageId && rec.messageId !== filter.messageId) continue;
    if (filter.modelId && rec.modelId !== filter.modelId) continue;
    if (filter.verdict && rec.verdict !== filter.verdict) continue;
    records.push(rec);
  }
  records.sort((a, b) => Date.parse(b.verifiedAt) - Date.parse(a.verifiedAt));
  return records;
}

/**
 * Build an aggregate report over verifications (all or filtered).
 */
export async function getFactReport(filter = {}) {
  const records = await listVerifications(filter);
  const byVerdict = {};
  let confidenceSum = 0;
  let confidenceCount = 0;
  for (const rec of records) {
    byVerdict[rec.verdict] = (byVerdict[rec.verdict] || 0) + 1;
    if (typeof rec.confidence === "number") {
      confidenceSum += rec.confidence;
      confidenceCount += 1;
    }
  }
  const total = records.length;
  const supported = byVerdict.supported || 0;
  const partial = byVerdict.partial || 0;
  const unsupported = byVerdict.unsupported || 0;
  const unverified = (byVerdict.unverified || 0) + (byVerdict.no_sources || 0);
  const configuredSources = await listCrossrefSources();
  return {
    filter,
    total,
    byVerdict,
    supportRate: total > 0 ? supported / total : 0,
    partialRate: total > 0 ? partial / total : 0,
    failureRate: total > 0 ? unsupported / total : 0,
    unverifiedRate: total > 0 ? unverified / total : 0,
    averageConfidence: confidenceCount > 0 ? confidenceSum / confidenceCount : null,
    sourcesConfigured: configuredSources.length,
  };
}

export const _internals = { verificationPath, indexPath };
