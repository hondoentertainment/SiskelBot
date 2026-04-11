// @ts-check
/**
 * Phase 68.3: Fact verification.
 *
 * Cross-references natural-language claims against a set of
 * authoritative sources. Each source contributes a text corpus that
 * claims are scored against using simple token overlap with weight
 * by source trust. Verdicts:
 *
 *   - "verified" — strong agreement from at least one trusted source
 *   - "disputed" — partial support + explicit contradiction terms
 *   - "unverified" — no support
 *
 * Exports:
 *   - verifyClaim
 *   - addAuthoritativeSource
 *   - listSources
 *   - getClaimStatus
 *   - listClaims
 *
 * @module fact-verification
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const NEGATORS = new Set([
  "not", "no", "never", "false", "incorrect", "untrue", "wrong",
  "disprove", "disproven", "debunked", "misinformation",
]);

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "has", "have", "he", "in", "is", "it", "its", "of", "on", "or", "so",
  "the", "their", "then", "there", "they", "this", "to", "with", "was",
  "were", "would", "could", "should", "i", "you", "we", "our", "do", "does",
  "did", "if", "how", "what", "which", "who", "when", "where", "why",
]);

function sourcesPath() {
  return join(getDataDir(), "fact-verification-sources.json");
}

function claimsPath() {
  return join(getDataDir(), "fact-verification-claims.json");
}

function tokenize(s) {
  if (!s) return [];
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

async function loadSources() {
  const data = await readJsonPath(sourcesPath(), { version: STORE_VERSION, sources: {} });
  if (!data.sources || typeof data.sources !== "object") data.sources = {};
  return data;
}

async function saveSources(data) {
  await writeJsonPath(sourcesPath(), { version: STORE_VERSION, sources: data.sources || {} });
}

async function loadClaims() {
  const data = await readJsonPath(claimsPath(), { version: STORE_VERSION, claims: {} });
  if (!data.claims || typeof data.claims !== "object") data.claims = {};
  return data;
}

async function saveClaims(data) {
  await writeJsonPath(claimsPath(), { version: STORE_VERSION, claims: data.claims || {} });
}

function claimId(claim) {
  const tokens = tokenize(claim).slice(0, 10).join("_");
  return `claim_${tokens}`.slice(0, 120) || `claim_${Date.now()}`;
}

/**
 * Register an authoritative source. `corpus` is a block of text
 * that supporting claims should appear in.
 *
 * @param {{ id?: string, name: string, url?: string, trust?: number, corpus: string }} spec
 * @returns {Promise<object>}
 */
export async function addAuthoritativeSource(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("spec is required");
  }
  if (!spec.name || typeof spec.name !== "string") {
    throw new Error("name is required");
  }
  if (typeof spec.corpus !== "string") {
    throw new Error("corpus is required");
  }
  const id = spec.id && typeof spec.id === "string"
    ? spec.id
    : spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60);
  const trust = Number.isFinite(spec.trust) && spec.trust >= 0 && spec.trust <= 1
    ? spec.trust
    : 0.8;
  const path = sourcesPath();
  return withPathLock(path, async () => {
    const data = await loadSources();
    const now = new Date().toISOString();
    const record = {
      id,
      name: spec.name,
      url: typeof spec.url === "string" ? spec.url : "",
      trust,
      corpus: spec.corpus,
      corpusTokens: tokenize(spec.corpus),
      createdAt: data.sources[id]?.createdAt || now,
      updatedAt: now,
    };
    data.sources[id] = record;
    await saveSources(data);
    return { ...record, corpusTokens: undefined, corpus: undefined };
  });
}

/**
 * List registered authoritative sources (without their corpora).
 * @returns {Promise<object[]>}
 */
export async function listSources() {
  const data = await loadSources();
  return Object.values(data.sources || {}).map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
    trust: s.trust,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
}

/**
 * Score a claim against a single source.
 * @param {string[]} claimTokens
 * @param {object} source
 * @returns {{ support: number, contradicted: boolean, matched: string[] }}
 */
function scoreClaimAgainstSource(claimTokens, source) {
  const corpus = Array.isArray(source.corpusTokens) ? source.corpusTokens : [];
  if (claimTokens.length === 0 || corpus.length === 0) {
    return { support: 0, contradicted: false, matched: [] };
  }
  const corpusSet = new Set(corpus);
  /** @type {string[]} */
  const matched = [];
  for (const t of claimTokens) {
    if (corpusSet.has(t)) matched.push(t);
  }
  const overlap = matched.length / claimTokens.length;
  let contradicted = false;
  for (const t of claimTokens) {
    if (NEGATORS.has(t) && matched.length > 0) {
      contradicted = true;
      break;
    }
  }
  return { support: overlap, contradicted, matched };
}

/**
 * Verify a claim by scoring it across every authoritative source.
 * Persists the verdict to the claims store.
 *
 * @param {string} claim
 * @returns {Promise<object>}
 */
export async function verifyClaim(claim) {
  if (!claim || typeof claim !== "string") {
    throw new Error("claim is required");
  }
  const data = await loadSources();
  const sources = Object.values(data.sources || {});
  const tokens = tokenize(claim);
  /** @type {Array<{ sourceId: string, sourceName: string, trust: number, support: number, contradicted: boolean, matched: string[] }>} */
  const perSource = [];
  let bestSupport = 0;
  let anyContradicted = false;
  for (const s of sources) {
    const { support, contradicted, matched } = scoreClaimAgainstSource(tokens, s);
    const weighted = support * (s.trust || 0.5);
    if (weighted > bestSupport) bestSupport = weighted;
    if (contradicted) anyContradicted = true;
    perSource.push({
      sourceId: s.id,
      sourceName: s.name,
      trust: s.trust,
      support: Math.round(support * 10000) / 10000,
      contradicted,
      matched,
    });
  }
  let verdict = "unverified";
  if (bestSupport >= 0.5 && !anyContradicted) verdict = "verified";
  else if (bestSupport >= 0.2 && anyContradicted) verdict = "disputed";
  else if (bestSupport >= 0.2) verdict = "partial";

  const id = claimId(claim);
  const now = new Date().toISOString();
  const record = {
    id,
    claim,
    verdict,
    confidence: Math.round(bestSupport * 10000) / 10000,
    perSource,
    checkedAt: now,
  };
  await withPathLock(claimsPath(), async () => {
    const store = await loadClaims();
    store.claims[id] = {
      ...record,
      createdAt: store.claims[id]?.createdAt || now,
    };
    await saveClaims(store);
  });
  return record;
}

/**
 * Retrieve the most recent verdict for a claim.
 * @param {string} claim
 * @returns {Promise<object | null>}
 */
export async function getClaimStatus(claim) {
  if (!claim || typeof claim !== "string") return null;
  const id = claimId(claim);
  const data = await loadClaims();
  return data.claims[id] || null;
}

/**
 * List every persisted claim verdict.
 * @returns {Promise<object[]>}
 */
export async function listClaims() {
  const data = await loadClaims();
  return Object.values(data.claims || {});
}
