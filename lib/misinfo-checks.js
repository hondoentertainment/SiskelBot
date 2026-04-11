// @ts-check
/**
 * Phase 67.3: Misinformation / factuality checks.
 *
 * Stores a collection of "claims" and "sources" (each source has a
 * credibility score). `checkClaim` compares a query statement against
 * known claims via simple token overlap and aggregates source
 * credibilities to return an overall verdict:
 *   - supported  (high overlap + credible sources)
 *   - disputed   (sources disagree)
 *   - unsupported (no sources)
 *   - refuted    (matched a refuting claim)
 *
 * This module is deliberately transparent: it does not make factuality
 * determinations on its own, it only reports what the stored sources
 * say.
 *
 * Exports:
 *   - addClaim
 *   - checkClaim
 *   - listClaims
 *   - addSource
 *   - rankSourceCredibility
 *   - listSources
 *
 * @module misinfo-checks
 */
import { join } from "path";
import { randomBytes } from "crypto";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const VERDICTS = new Set(["supports", "refutes", "mixed", "unrelated"]);

function storePath() {
  return join(getDataDir(), "misinfo-checks.json");
}

function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    claims: {},
    sources: {},
  });
  if (!data.claims || typeof data.claims !== "object") data.claims = {};
  if (!data.sources || typeof data.sources !== "object") data.sources = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    claims: data.claims || {},
    sources: data.sources || {},
  });
}

/**
 * Tokenize into lowercase word tokens (for overlap computation).
 */
function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function tokenOverlap(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const t of setA) if (setB.has(t)) intersect += 1;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/**
 * Add a source (url + credibility score 0..1).
 *
 * @param {{name: string, url?: string, credibility?: number, category?: string}} payload
 * @returns {Promise<object>}
 */
export async function addSource(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.name) throw new Error("name required");
  const credibility = Number.isFinite(payload.credibility) ? Math.max(0, Math.min(1, payload.credibility)) : 0.5;
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const id = newId("src");
    const ts = nowIso();
    const record = {
      id,
      name: String(payload.name),
      url: payload.url ? String(payload.url) : "",
      credibility,
      category: payload.category ? String(payload.category) : "general",
      addedAt: ts,
    };
    data.sources[id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Add a claim with optional supporting/refuting source ids.
 *
 * @param {{statement: string, verdict?: string, sources?: Array<{sourceId: string, stance?: "supports"|"refutes"}>, metadata?: object}} payload
 * @returns {Promise<object>}
 */
export async function addClaim(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.statement || typeof payload.statement !== "string") {
    throw new Error("statement required");
  }
  const verdict = String(payload.verdict || "unrelated").toLowerCase();
  if (!VERDICTS.has(verdict)) throw new Error(`verdict must be one of ${[...VERDICTS].join(", ")}`);
  const sources = Array.isArray(payload.sources) ? payload.sources : [];

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    for (const s of sources) {
      if (!s || !s.sourceId) continue;
      if (!data.sources[s.sourceId]) {
        throw new Error(`source ${s.sourceId} not found`);
      }
    }
    const id = newId("claim");
    const ts = nowIso();
    const record = {
      id,
      statement: String(payload.statement),
      tokens: tokenize(payload.statement),
      verdict,
      sources: sources.map((s) => ({
        sourceId: String(s.sourceId),
        stance: s.stance === "refutes" ? "refutes" : "supports",
      })),
      metadata: payload.metadata && typeof payload.metadata === "object" ? { ...payload.metadata } : {},
      addedAt: ts,
    };
    data.claims[id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Check a statement against stored claims. Returns an overall verdict
 * plus the top matching claims and aggregated source credibility.
 *
 * @param {{statement: string, minOverlap?: number}} payload
 * @returns {Promise<{statement: string, verdict: string, matches: object[], sourceScore: number}>}
 */
export async function checkClaim(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.statement) throw new Error("statement required");
  const minOverlap = Number.isFinite(payload.minOverlap) ? payload.minOverlap : 0.3;
  const qTokens = tokenize(payload.statement);

  const data = await loadStore();
  const matches = [];
  for (const claim of Object.values(data.claims || {})) {
    const score = tokenOverlap(qTokens, claim.tokens || []);
    if (score >= minOverlap) {
      const sourceDetails = [];
      let weightedSupport = 0;
      let weightedRefute = 0;
      for (const ref of claim.sources || []) {
        const src = data.sources[ref.sourceId];
        const cred = src ? src.credibility : 0.5;
        if (ref.stance === "refutes") weightedRefute += cred;
        else weightedSupport += cred;
        sourceDetails.push({
          sourceId: ref.sourceId,
          name: src?.name || "",
          stance: ref.stance,
          credibility: cred,
        });
      }
      matches.push({
        claimId: claim.id,
        statement: claim.statement,
        verdict: claim.verdict,
        score: Math.round(score * 10000) / 10000,
        weightedSupport: Math.round(weightedSupport * 10000) / 10000,
        weightedRefute: Math.round(weightedRefute * 10000) / 10000,
        sources: sourceDetails,
      });
    }
  }
  matches.sort((a, b) => b.score - a.score);

  let verdict = "unsupported";
  let sourceScore = 0;
  if (matches.length > 0) {
    const top = matches[0];
    sourceScore = top.weightedSupport - top.weightedRefute;
    if (top.verdict === "refutes") verdict = "refuted";
    else if (top.weightedSupport > 0 && top.weightedRefute === 0) verdict = "supported";
    else if (top.weightedRefute > 0 && top.weightedSupport === 0) verdict = "refuted";
    else if (top.weightedSupport > 0 && top.weightedRefute > 0) verdict = "disputed";
  }

  return {
    statement: payload.statement,
    verdict,
    matches: matches.slice(0, 5),
    sourceScore: Math.round(sourceScore * 10000) / 10000,
  };
}

/**
 * List claims (optionally filtered by verdict).
 *
 * @param {{verdict?: string, limit?: number}} [filter]
 * @returns {Promise<object[]>}
 */
export async function listClaims(filter = {}) {
  const data = await loadStore();
  let all = Object.values(data.claims || {});
  if (filter.verdict) all = all.filter((c) => c.verdict === filter.verdict);
  all.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  const limit = Number.isFinite(filter.limit) && filter.limit > 0 ? Math.floor(filter.limit) : 200;
  return all.slice(0, limit);
}

/**
 * List sources sorted by credibility desc.
 *
 * @param {{category?: string, minCredibility?: number}} [filter]
 * @returns {Promise<object[]>}
 */
export async function listSources(filter = {}) {
  const data = await loadStore();
  let all = Object.values(data.sources || {});
  if (filter.category) all = all.filter((s) => s.category === filter.category);
  if (Number.isFinite(filter.minCredibility)) {
    all = all.filter((s) => s.credibility >= filter.minCredibility);
  }
  all.sort((a, b) => b.credibility - a.credibility);
  return all;
}

/**
 * Rank sources against each other — simple wrapper over listSources
 * that normalizes credibility into a 1..N rank.
 *
 * @param {{category?: string}} [filter]
 * @returns {Promise<Array<{id: string, name: string, credibility: number, rank: number}>>}
 */
export async function rankSourceCredibility(filter = {}) {
  const list = await listSources(filter);
  return list.map((s, i) => ({
    id: s.id,
    name: s.name,
    credibility: s.credibility,
    rank: i + 1,
  }));
}
