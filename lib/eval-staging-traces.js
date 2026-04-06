/**
 * Phase 97: List staging-export JSON files for `target: staging_trace` eval cases (operator UX).
 * Directory: `EVAL_STAGING_TRACES_DIR` or `<STORAGE_PATH|data>/eval-sets/traces`.
 */
import { existsSync, readdirSync, statSync } from "fs";
import { join, isAbsolute, normalize, relative, resolve } from "path";

const MAX_FILES = 300;

/**
 * Absolute directory containing staging trace JSON files.
 * @returns {string}
 */
export function resolveStagingTracesDirectory() {
  const env = process.env.EVAL_STAGING_TRACES_DIR?.trim();
  if (env) {
    return isAbsolute(env) ? normalize(env) : resolve(process.cwd(), env);
  }
  const dataRoot = process.env.STORAGE_PATH || join(process.cwd(), "data");
  return join(dataRoot, "eval-sets", "traces");
}

/**
 * @returns {Array<{ name: string, stagingTraceFile: string, bytes: number, mtimeMs: number }>}
 */
export function listStagingTraceSummaries() {
  const dir = resolveStagingTracesDirectory();
  if (!existsSync(dir)) {
    return [];
  }
  const cwd = process.cwd();
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".json") && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  if (names.length > MAX_FILES) {
    names = names.slice(0, MAX_FILES);
  }
  const traces = [];
  for (const name of names) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      const rel = relative(cwd, full);
      const stagingTraceFile = rel.split(/[/\\]/).join("/");
      traces.push({
        name,
        stagingTraceFile,
        bytes: st.size,
        mtimeMs: Math.floor(st.mtimeMs),
      });
    } catch {
      /* skip unreadable entries */
    }
  }
  return traces;
}
