#!/usr/bin/env node
/**
 * Compare two OpenAPI YAML/JSON specs and emit a Markdown changelog.
 *
 * Usage:
 *   node scripts/openapi-diff.mjs <old> <new> [--output=changelog.md]
 *
 * Categorizes changes:
 *   - BREAKING: removed endpoints, removed required params, added required params,
 *               removed previously-documented response codes
 *   - ADDED:    new endpoints, new optional params, new response codes
 *   - CHANGED:  removed optional params and other non-breaking edits (reserved)
 *
 * Exit code: 0 if no breaking, 1 if breaking changes detected, 2 on bad usage.
 *
 * Spec loader: tries (in order) `yaml`, `js-yaml`, then JSON.parse so the
 * script remains usable whether or not a YAML library is installed.
 */
import { readFileSync, writeFileSync } from "node:fs";

async function tryImport(name) {
  try {
    return await import(name);
  } catch {
    return null;
  }
}

async function loadSpec(path) {
  const raw = readFileSync(path, "utf8");
  const trimmed = raw.trimStart();
  // Quick JSON detection
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      // fall through to YAML
    }
  }
  // Try `yaml` package
  const yamlMod = await tryImport("yaml");
  if (yamlMod) {
    const parse = yamlMod.parse || yamlMod.default?.parse;
    if (typeof parse === "function") return parse(raw);
  }
  // Try `js-yaml`
  const jsYamlMod = await tryImport("js-yaml");
  if (jsYamlMod) {
    const load = jsYamlMod.load || jsYamlMod.default?.load;
    if (typeof load === "function") return load(raw);
  }
  // Final fallback: JSON.parse (will throw with a clear error if not JSON)
  return JSON.parse(raw);
}

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
]);

function methodKeys(operationsObj) {
  if (!operationsObj || typeof operationsObj !== "object") return [];
  return Object.keys(operationsObj).filter((k) => HTTP_METHODS.has(k.toLowerCase()));
}

export function diff(oldSpec, newSpec) {
  const breaking = [];
  const added = [];
  const changed = [];

  const oldPaths = (oldSpec && oldSpec.paths) || {};
  const newPaths = (newSpec && newSpec.paths) || {};

  // Removed endpoints / methods (BREAKING)
  for (const path of Object.keys(oldPaths)) {
    if (!newPaths[path]) {
      breaking.push({ kind: "endpoint_removed", path });
      continue;
    }
    const oldMethods = methodKeys(oldPaths[path]);
    const newMethods = methodKeys(newPaths[path]);
    for (const method of oldMethods) {
      if (!newMethods.includes(method)) {
        breaking.push({ kind: "method_removed", path, method });
      }
    }
  }

  // Added endpoints / methods, plus per-method param + response diffs
  for (const path of Object.keys(newPaths)) {
    if (!oldPaths[path]) {
      added.push({ kind: "endpoint_added", path });
      continue;
    }
    const oldMethods = methodKeys(oldPaths[path]);
    const newMethods = methodKeys(newPaths[path]);

    for (const method of newMethods) {
      if (!oldMethods.includes(method)) {
        added.push({ kind: "method_added", path, method });
      }
    }

    for (const method of newMethods) {
      if (!oldMethods.includes(method)) continue;
      const oldOp = oldPaths[path][method] || {};
      const newOp = newPaths[path][method] || {};

      const oldParams = Array.isArray(oldOp.parameters) ? oldOp.parameters : [];
      const newParams = Array.isArray(newOp.parameters) ? newOp.parameters : [];

      // Parameter removals
      for (const p of oldParams) {
        if (!p || !p.name) continue;
        const stillThere = newParams.find((np) => np && np.name === p.name && np.in === p.in);
        if (!stillThere) {
          if (p.required) {
            breaking.push({ kind: "required_param_removed", path, method, param: p.name });
          } else {
            changed.push({ kind: "optional_param_removed", path, method, param: p.name });
          }
        }
      }
      // Parameter additions
      for (const p of newParams) {
        if (!p || !p.name) continue;
        const wasThere = oldParams.find((op) => op && op.name === p.name && op.in === p.in);
        if (!wasThere) {
          if (p.required) {
            breaking.push({ kind: "required_param_added", path, method, param: p.name });
          } else {
            added.push({ kind: "optional_param_added", path, method, param: p.name });
          }
        }
      }

      // Response code diffs
      const oldResponses =
        oldOp.responses && typeof oldOp.responses === "object" ? oldOp.responses : {};
      const newResponses =
        newOp.responses && typeof newOp.responses === "object" ? newOp.responses : {};
      for (const code of Object.keys(oldResponses)) {
        if (!Object.prototype.hasOwnProperty.call(newResponses, code)) {
          breaking.push({ kind: "response_removed", path, method, code });
        }
      }
      for (const code of Object.keys(newResponses)) {
        if (!Object.prototype.hasOwnProperty.call(oldResponses, code)) {
          added.push({ kind: "response_added", path, method, code });
        }
      }
    }
  }

  return { breaking, added, changed };
}

function describe(entry) {
  const method = entry.method ? entry.method.toUpperCase() : "";
  const detail = entry.param
    ? ` (param: \`${entry.param}\`)`
    : entry.code
      ? ` (status: \`${entry.code}\`)`
      : "";
  return `- **${entry.kind.replace(/_/g, " ")}**: \`${method} ${entry.path}\`${detail}`;
}

export function formatMarkdown(diffResult, oldVersion, newVersion) {
  const lines = [];
  lines.push(`# API Changelog: ${oldVersion} -> ${newVersion}`);
  lines.push("");

  if (diffResult.breaking.length > 0) {
    lines.push(`## Breaking changes (${diffResult.breaking.length})`);
    lines.push("");
    for (const b of diffResult.breaking) lines.push(describe(b));
    lines.push("");
  } else {
    lines.push("## No breaking changes");
    lines.push("");
  }

  if (diffResult.added.length > 0) {
    lines.push(`## Added (${diffResult.added.length})`);
    lines.push("");
    for (const a of diffResult.added) lines.push(describe(a));
    lines.push("");
  }

  if (diffResult.changed.length > 0) {
    lines.push(`## Changed (${diffResult.changed.length})`);
    lines.push("");
    for (const c of diffResult.changed) lines.push(describe(c));
    lines.push("");
  }

  return lines.join("\n");
}

// CLI entry point: only run when this file is invoked directly.
const isMain = (() => {
  try {
    const here = new URL(import.meta.url).pathname;
    return process.argv[1] && (here === process.argv[1] || here.endsWith(process.argv[1]));
  } catch {
    return false;
  }
})();

if (isMain) {
  const [, , oldFile, newFile, ...flags] = process.argv;
  if (!oldFile || !newFile) {
    console.error("Usage: openapi-diff.mjs <old> <new> [--output=changelog.md]");
    process.exit(2);
  }

  const oldSpec = await loadSpec(oldFile);
  const newSpec = await loadSpec(newFile);
  const result = diff(oldSpec, newSpec);
  const md = formatMarkdown(
    result,
    (oldSpec && oldSpec.info && oldSpec.info.version) || "unknown",
    (newSpec && newSpec.info && newSpec.info.version) || "unknown"
  );

  const outputFlag = flags.find((f) => f.startsWith("--output="));
  if (outputFlag) {
    const outPath = outputFlag.split("=")[1];
    writeFileSync(outPath, md);
    console.log(`Wrote changelog to ${outPath}`);
  } else {
    console.log(md);
  }

  process.exit(result.breaking.length > 0 ? 1 : 0);
}
