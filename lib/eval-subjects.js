/**
 * Eval subject registry.
 *
 * `lib/eval-in-prod.js` records shadow samples generically. For regression
 * bisection and the quality dashboard we need a stable enumeration of the
 * *subjects* (features, agents, tools) we're tracking — so a failing
 * sample can be traced back to one specific feature rather than a blob of
 * raw metadata.
 *
 * Storage layout:
 *   data/eval-subjects/_registry.json
 *     { subjects: [{ subjectId, feature, module, tags, createdAt }] }
 *
 * Phase 63 code-gen subjects (repo-rag, pr-review-agent, test-gen,
 * refactor-agent, migration-assistant) are seeded by ensureSeededSubjects
 * so the first shadow sample against any of them lands on a known
 * subject instead of a free-form string.
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

export const PHASE63_SUBJECTS = Object.freeze([
  {
    subjectId: "phase63.repo-rag",
    feature: "repo-rag",
    module: "lib/repo-rag.js",
    tags: ["phase63", "code-gen", "search"],
  },
  {
    subjectId: "phase63.pr-review-agent",
    feature: "pr-review-agent",
    module: "lib/pr-review-agent.js",
    tags: ["phase63", "code-gen", "review"],
  },
  {
    subjectId: "phase63.test-gen",
    feature: "test-gen",
    module: "lib/test-gen.js",
    tags: ["phase63", "code-gen", "testing"],
  },
  {
    subjectId: "phase63.refactor-agent",
    feature: "refactor-agent",
    module: "lib/refactor-agent.js",
    tags: ["phase63", "code-gen", "refactor"],
  },
  {
    subjectId: "phase63.migration-assistant",
    feature: "migration-assistant",
    module: "lib/migration-assistant.js",
    tags: ["phase63", "code-gen", "migration"],
  },
]);

function registryPath() {
  return join(getDataDir(), "eval-subjects", "_registry.json");
}

async function loadRegistry() {
  const store = await readJsonPath(registryPath(), { subjects: [] });
  return Array.isArray(store.subjects) ? store.subjects : [];
}

async function writeRegistry(subjects) {
  await writeJsonPath(registryPath(), { subjects });
}

function sanitizeSubjectId(val) {
  const s = typeof val === "string" ? val.trim() : "";
  if (!s) return null;
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

/**
 * Register (or update) a subject. Returns the stored record.
 * @param {{ subjectId: string, feature: string, module?: string, tags?: string[] }} input
 */
export async function registerSubject(input = {}) {
  const subjectId = sanitizeSubjectId(input.subjectId);
  if (!subjectId) throw new Error("subjectId required");
  const feature =
    typeof input.feature === "string" && input.feature.trim()
      ? input.feature.trim()
      : null;
  if (!feature) throw new Error("feature required");
  const record = {
    subjectId,
    feature,
    module: typeof input.module === "string" ? input.module : null,
    tags: Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === "string") : [],
    createdAt: Date.now(),
  };
  await withPathLock(registryPath(), async () => {
    const subjects = await loadRegistry();
    const next = subjects.filter((s) => s.subjectId !== subjectId);
    next.push(record);
    await writeRegistry(next);
  });
  return record;
}

/**
 * Ensure the Phase 63 subjects are registered. Idempotent.
 */
export async function ensureSeededSubjects() {
  const existing = await loadRegistry();
  const ids = new Set(existing.map((s) => s.subjectId));
  const toAdd = PHASE63_SUBJECTS.filter((s) => !ids.has(s.subjectId));
  if (toAdd.length === 0) return { added: 0 };
  await withPathLock(registryPath(), async () => {
    const subjects = await loadRegistry();
    const byId = new Map(subjects.map((s) => [s.subjectId, s]));
    for (const seed of toAdd) {
      byId.set(seed.subjectId, { ...seed, createdAt: Date.now() });
    }
    await writeRegistry([...byId.values()]);
  });
  return { added: toAdd.length };
}

export async function listSubjects({ tag } = {}) {
  const subjects = await loadRegistry();
  if (!tag) return subjects;
  return subjects.filter((s) => Array.isArray(s.tags) && s.tags.includes(tag));
}

export async function getSubject(subjectId) {
  const id = sanitizeSubjectId(subjectId);
  if (!id) return null;
  const subjects = await loadRegistry();
  return subjects.find((s) => s.subjectId === id) || null;
}

export async function removeSubject(subjectId) {
  const id = sanitizeSubjectId(subjectId);
  if (!id) return false;
  let removed = false;
  await withPathLock(registryPath(), async () => {
    const subjects = await loadRegistry();
    const next = subjects.filter((s) => s.subjectId !== id);
    removed = next.length !== subjects.length;
    if (removed) await writeRegistry(next);
  });
  return removed;
}

export async function _reset() {
  await writeRegistry([]);
}
