// @ts-check
/**
 * Phase 64.5: Reproducibility checks.
 *
 * Automated checklist for ML/research reproducibility. Each check returns
 * a `pass`/`fail` + an explanation. Checks include:
 *   - data_available — dataset info/URL present
 *   - code_available — code URL / repo present
 *   - seed_specified — random seed is set
 *   - versions_pinned — dependencies pinned
 *   - hardware_described — hardware / GPU described
 *   - license_declared — license present
 *
 * Exports:
 *   - `runReproCheck(subject)` — evaluate all checks
 *   - `getChecklist()` — list available checks
 *   - `recordResult(result)` — persist a result
 *   - `listChecks()` — list persisted results
 *   - `exportReport(format)` — JSON or Markdown
 *
 * @module reproducibility
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function resultsPath() {
  return join(getDataDir(), "reproducibility-results.json");
}

async function loadResults() {
  const data = await readJsonPath(resultsPath(), { version: STORE_VERSION, results: [] });
  if (!Array.isArray(data.results)) data.results = [];
  return data;
}

async function saveResults(data) {
  await writeJsonPath(resultsPath(), { version: STORE_VERSION, results: data.results || [] });
}

/* -------------------------------------------------------------------------- */
/* Checklist definition                                                       */
/* -------------------------------------------------------------------------- */

const CHECKS = [
  {
    id: "data_available",
    name: "Data availability",
    description: "Dataset URL, DOI, or accession number must be provided.",
    check(subject) {
      if (subject.dataset && (subject.dataset.url || subject.dataset.doi || subject.dataset.accession)) {
        return { pass: true, detail: "dataset reference present" };
      }
      return { pass: false, detail: "missing dataset.url / doi / accession" };
    },
  },
  {
    id: "code_available",
    name: "Code availability",
    description: "Source code repository URL must be provided.",
    check(subject) {
      const urls = [subject.codeUrl, subject.repo, subject.repoUrl, subject.code?.url];
      if (urls.some((u) => typeof u === "string" && /^https?:\/\//.test(u))) {
        return { pass: true, detail: "code repo link present" };
      }
      return { pass: false, detail: "missing codeUrl or repo" };
    },
  },
  {
    id: "seed_specified",
    name: "Random seed specified",
    description: "A random seed must be set for reproducibility.",
    check(subject) {
      if (Number.isFinite(subject.seed) || (subject.config && Number.isFinite(subject.config.seed))) {
        return { pass: true, detail: "seed present" };
      }
      return { pass: false, detail: "no numeric seed field found" };
    },
  },
  {
    id: "versions_pinned",
    name: "Dependencies pinned",
    description: "Dependency versions must be pinned.",
    check(subject) {
      const deps = subject.dependencies || subject.deps;
      if (!deps || typeof deps !== "object") {
        return { pass: false, detail: "no dependencies declared" };
      }
      const entries = Object.entries(deps);
      if (entries.length === 0) return { pass: false, detail: "empty dependencies" };
      const loose = entries.filter(([, v]) => typeof v === "string" && /[\^~*]/.test(v));
      if (loose.length > 0) {
        return { pass: false, detail: `${loose.length} loose version(s)` };
      }
      return { pass: true, detail: `${entries.length} dependencies pinned` };
    },
  },
  {
    id: "hardware_described",
    name: "Hardware described",
    description: "The compute environment (CPU/GPU/RAM) must be described.",
    check(subject) {
      if (subject.hardware && typeof subject.hardware === "object") {
        const keys = Object.keys(subject.hardware);
        if (keys.length > 0) return { pass: true, detail: `${keys.length} hardware fields` };
      }
      return { pass: false, detail: "no hardware section" };
    },
  },
  {
    id: "license_declared",
    name: "License declared",
    description: "The code/data must declare a license.",
    check(subject) {
      if (subject.license && typeof subject.license === "string") {
        return { pass: true, detail: `license: ${subject.license}` };
      }
      return { pass: false, detail: "no license string" };
    },
  },
];

/** Return the catalog of available checks. */
export function getChecklist() {
  return CHECKS.map(({ id, name, description }) => ({ id, name, description }));
}

/* -------------------------------------------------------------------------- */
/* Running checks                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate every check against a subject object.
 *
 * @param {object} subject
 * @returns {{ passed: number, failed: number, total: number, score: number, results: Array<object> }}
 */
export function runReproCheck(subject) {
  if (!subject || typeof subject !== "object") {
    throw new Error("subject must be an object");
  }
  const results = CHECKS.map((c) => {
    let out;
    try {
      out = c.check(subject);
    } catch (_e) {
      out = { pass: false, detail: "check threw an error" };
    }
    return {
      id: c.id,
      name: c.name,
      pass: !!out.pass,
      detail: out.detail || "",
    };
  });
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  return {
    passed,
    failed,
    total: results.length,
    score: Math.round((passed / results.length) * 10000) / 100,
    results,
  };
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Persist a check result.
 *
 * @param {object} result
 * @returns {Promise<object>}
 */
export async function recordResult(result) {
  if (!result || typeof result !== "object") throw new Error("result required");
  const path = resultsPath();
  return withPathLock(path, async () => {
    const data = await loadResults();
    const id = result.id || `repro_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const rec = {
      id,
      subjectName: result.subjectName || null,
      ...result,
      createdAt: new Date().toISOString(),
    };
    data.results.push(rec);
    if (data.results.length > 10000) data.results = data.results.slice(-10000);
    await saveResults(data);
    return rec;
  });
}

/** List all recorded check results. */
export async function listChecks() {
  const data = await loadResults();
  return data.results;
}

/**
 * Export a report in JSON or Markdown.
 *
 * @param {"json"|"markdown"} [format]
 * @returns {Promise<string | object>}
 */
export async function exportReport(format = "json") {
  const data = await loadResults();
  if (format === "markdown") {
    const lines = ["# Reproducibility Report", ""];
    for (const r of data.results) {
      lines.push(`## ${r.subjectName || r.id}`);
      lines.push(`- Score: ${r.score != null ? r.score : "n/a"}`);
      lines.push(`- Passed: ${r.passed}/${r.total}`);
      if (Array.isArray(r.results)) {
        for (const c of r.results) {
          lines.push(`  - [${c.pass ? "x" : " "}] ${c.name}: ${c.detail}`);
        }
      }
      lines.push("");
    }
    return lines.join("\n");
  }
  return { count: data.results.length, results: data.results };
}
