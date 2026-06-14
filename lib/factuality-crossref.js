/**
 * Phase 67.3: Factuality cross-reference — verify claims against configured sources.
 *
 * IMPORTANT: this module does NOT ship any authoritative data. Operators add
 * sources (name + URL or inline text) which the cross-ref mechanics consult.
 * A source can be either:
 *   - inline: `{ text: "..." }` — the content of the source, indexed by tokens.
 *   - url:    `{ url: "..." }`  — to be fetched via a caller-supplied fetcher.
 *
 * The "verify" step scores a claim against each source using token-overlap,
 * term containment, and optional regex patterns. The caller decides how to
 * weight or gate on these scores.
 *
 * Storage:
 *   data/factuality-crossref/sources/{id}.json  — source record
 *   data/factuality-crossref/_index.json        — registry
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for", "with",
  "at", "by", "from", "is", "are", "was", "were", "be", "been", "being", "this", "that",
  "these", "those", "it", "its", "as", "has", "have", "had", "do", "does", "did", "not",
  "no", "yes", "can", "could", "should", "would", "will", "may", "might", "about", "into",
]);

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function sourcePath(id) {
  return join(getDataDir(), "factuality-crossref", "sources", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "factuality-crossref", "_index.json");
}

async function updateIndex(id, remove = false, entry = null) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { sources: [] });
    const list = Array.isArray(idx.sources) ? idx.sources : [];
    const filtered = list.filter((e) => e.id !== id);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { sources: filtered });
  });
}

// ─── Text utilities ────────────────────────────────────────────────────────

export function extractTerms(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function termSet(text) {
  return new Set(extractTerms(text));
}

function overlapScore(claimTerms, sourceTerms) {
  if (claimTerms.size === 0) return 0;
  let hits = 0;
  for (const t of claimTerms) {
    if (sourceTerms.has(t)) hits += 1;
  }
  return hits / claimTerms.size;
}

// ─── Source CRUD ───────────────────────────────────────────────────────────

/**
 * Configure one or more sources. Accepts an array of `{ id?, name, url?, text?, weight? }`.
 * Returns the persisted records.
 */
export async function configureSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("sources array is required");
  }
  const results = [];
  for (const src of sources) {
    if (!src || typeof src !== "object") {
      throw new Error("each source must be an object");
    }
    if (!src.name || typeof src.name !== "string") {
      throw new Error("source.name is required");
    }
    const hasText = typeof src.text === "string" && src.text.trim();
    const hasUrl = typeof src.url === "string" && src.url.trim();
    if (!hasText && !hasUrl) {
      throw new Error("each source must include either text or url");
    }
    const id = src.id || randomUUID();
    const now = new Date().toISOString();
    const rec = {
      id,
      name: src.name,
      description: src.description || "",
      url: hasUrl ? src.url : null,
      text: hasText ? src.text : null,
      weight: Number.isFinite(Number(src.weight)) ? Number(src.weight) : 1,
      tags: Array.isArray(src.tags) ? src.tags.map(String) : [],
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonPath(sourcePath(id), rec);
    await updateIndex(id, false, { id, name: rec.name, createdAt: now });
    results.push(rec);
  }
  return results;
}

export async function getSource(id) {
  if (!id) return null;
  const rec = await readJsonPath(sourcePath(id), null);
  if (!rec || !rec.id || rec._deleted) return null;
  return rec;
}

export async function listSources() {
  const idx = await readJsonPath(indexPath(), { sources: [] });
  const entries = Array.isArray(idx.sources) ? idx.sources : [];
  const records = [];
  for (const entry of entries) {
    const rec = await getSource(entry.id);
    if (rec) records.push(rec);
  }
  return records;
}

export async function deleteSource(id) {
  const rec = await getSource(id);
  if (!rec) return { ok: false, code: "NOT_FOUND" };
  await writeJsonPath(sourcePath(id), { _deleted: true });
  await updateIndex(id, true);
  return { ok: true };
}

// ─── Verify ────────────────────────────────────────────────────────────────

/**
 * Verify a claim against the configured sources.
 *
 * @param {object} opts
 * @param {string} opts.claim          — the text to check
 * @param {string[]} [opts.sourceIds]  — restrict to these sources (otherwise all)
 * @param {function} [opts.urlFetcher] — async (url) => string; required for URL-only sources
 * @param {RegExp|string[]} [opts.requiredPatterns] — must all match (optional)
 * @returns {Promise<{verdict, confidence, sourceResults}>}
 */
export async function verifyClaim({ claim, sourceIds, urlFetcher, requiredPatterns } = {}) {
  if (!claim || typeof claim !== "string") {
    throw new Error("claim is required");
  }
  const all = await listSources();
  const picked = Array.isArray(sourceIds) && sourceIds.length > 0
    ? all.filter((s) => sourceIds.includes(s.id))
    : all;
  const claimTerms = termSet(claim);
  const sourceResults = [];
  let weightedScore = 0;
  let totalWeight = 0;
  for (const src of picked) {
    let content = src.text || "";
    let fetched = false;
    if (!content && src.url && typeof urlFetcher === "function") {
      try {
        content = await urlFetcher(src.url);
        fetched = true;
      } catch (e) {
        sourceResults.push({
          sourceId: src.id,
          name: src.name,
          score: 0,
          fetched: false,
          error: e.message,
        });
        continue;
      }
    }
    if (!content) {
      sourceResults.push({
        sourceId: src.id,
        name: src.name,
        score: 0,
        fetched,
        reason: "no_content",
      });
      continue;
    }
    const srcTerms = termSet(content);
    const score = overlapScore(claimTerms, srcTerms);
    const weight = Number(src.weight) || 1;
    weightedScore += score * weight;
    totalWeight += weight;
    sourceResults.push({
      sourceId: src.id,
      name: src.name,
      score,
      fetched,
      weight,
      matchedTerms: [...claimTerms].filter((t) => srcTerms.has(t)).slice(0, 20),
    });
  }
  const confidence = totalWeight > 0 ? weightedScore / totalWeight : 0;

  // Optional requiredPatterns: every pattern must match the claim text.
  let patternCheck = { passed: true, failed: [] };
  if (requiredPatterns) {
    const list = Array.isArray(requiredPatterns) ? requiredPatterns : [requiredPatterns];
    for (const p of list) {
      const re = p instanceof RegExp ? p : new RegExp(String(p), "i");
      if (!re.test(claim)) {
        patternCheck.passed = false;
        patternCheck.failed.push(String(p));
      }
    }
  }

  let verdict = "unverified";
  if (sourceResults.length === 0) verdict = "no_sources";
  else if (confidence >= 0.7 && patternCheck.passed) verdict = "supported";
  else if (confidence >= 0.4 && patternCheck.passed) verdict = "partial";
  else verdict = "unsupported";

  return {
    claim,
    verdict,
    confidence,
    patternCheck,
    sourceResults,
  };
}

export const _internals = { sourcePath, indexPath, overlapScore, termSet };
