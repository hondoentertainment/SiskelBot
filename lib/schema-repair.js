// @ts-check
/**
 * Phase 53.5: Schema validation + best-effort repair.
 *
 * Lightweight JSON-schema validation tailored for LLM tool-call arguments.
 * Supports `type`, `properties`, `required`, `enum`, `minimum`, `maximum`,
 * `minLength`, `maxLength`, `pattern`, `items`, `additionalProperties`, and
 * `default`. Nested schemas are fully recursed.
 *
 * Exposed API:
 *
 *   - `validateArgs(schema, args)`  -- returns `{ ok, errors }`
 *   - `repairArgs(schema, args)`    -- deterministic repair pass
 *       * missing required prop with `default` -> apply default
 *       * string typed as number / number typed as string -> coerce
 *       * enum value with fuzzy-match -> nearest match
 *       * boolean strings ("true", "false") -> booleans
 *       * trailing/leading whitespace -> trimmed
 *   - `diffArgs(before, after)`     -- list of { path, before, after } tuples
 *   - `suggestFixes(schema, args)`  -- human-readable hints for the LLM
 *
 * Persisted repair stats flow through `json-path-store.js` so operators can
 * see which tool names most frequently need repair.
 *
 * @module schema-repair
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

function statsPath() {
  return join(getDataDir(), "schema-repair-stats.json");
}

async function loadStats() {
  const data = await readJsonPath(statsPath(), {
    version: STORE_VERSION,
    stats: {},
  });
  if (!data || typeof data !== "object") return { version: STORE_VERSION, stats: {} };
  if (!data.stats || typeof data.stats !== "object") data.stats = {};
  return data;
}

async function saveStats(data) {
  await writeJsonPath(statsPath(), {
    version: STORE_VERSION,
    stats: data.stats || {},
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Record a single repair event for operator dashboards.
 * @param {string} toolName
 * @param {{ repaired: number, errors: number }} metrics
 */
export async function recordRepairEvent(toolName, metrics) {
  if (!toolName) return;
  const path = statsPath();
  return withPathLock(path, async () => {
    const data = await loadStats();
    const cur = data.stats[toolName] || { validations: 0, repairs: 0, errors: 0, lastAt: null };
    cur.validations += 1;
    if (metrics) {
      cur.repairs += Number(metrics.repaired) || 0;
      cur.errors += Number(metrics.errors) || 0;
    }
    cur.lastAt = new Date().toISOString();
    data.stats[toolName] = cur;
    await saveStats(data);
    return cur;
  });
}

/** Fetch per-tool stats. */
export async function getRepairStats(toolName) {
  const data = await loadStats();
  if (toolName) return data.stats[toolName] || null;
  return data.stats || {};
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ValidationError
 * @property {string} path
 * @property {string} code
 * @property {string} message
 * @property {any}    [value]
 */

/**
 * Validate args against a schema. Returns `{ ok, errors }` where `errors` is
 * an array of `ValidationError`s with JSON-pointer-like paths.
 *
 * @param {any} schema
 * @param {any} args
 * @returns {{ ok: boolean, errors: ValidationError[] }}
 */
export function validateArgs(schema, args) {
  /** @type {ValidationError[]} */
  const errors = [];
  walkValidate(schema, args, "", errors);
  return { ok: errors.length === 0, errors };
}

function walkValidate(schema, value, path, errors) {
  if (!schema || typeof schema !== "object") return;
  const type = schema.type;
  if (value === undefined) {
    // required-ness is handled at the parent object level.
    return;
  }
  if (value === null) {
    if (type && !typesInclude(type, "null")) {
      errors.push({ path, code: "INVALID_TYPE", message: `expected ${describeType(type)}`, value });
    }
    return;
  }
  if (type) {
    const actual = actualType(value);
    if (!typesInclude(type, actual)) {
      // Integer type check handled specially.
      if (actual === "number" && typesInclude(type, "integer")) {
        if (!Number.isInteger(value)) {
          errors.push({ path, code: "NOT_INTEGER", message: "expected integer", value });
          return;
        }
      } else {
        errors.push({
          path,
          code: "INVALID_TYPE",
          message: `expected ${describeType(type)} but got ${actual}`,
          value,
        });
        return;
      }
    }
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      errors.push({
        path,
        code: "NOT_IN_ENUM",
        message: `value not in enum [${schema.enum.join(", ")}]`,
        value,
      });
      return;
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push({ path, code: "TOO_SHORT", message: `minLength ${schema.minLength}`, value });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push({ path, code: "TOO_LONG", message: `maxLength ${schema.maxLength}`, value });
    }
    if (typeof schema.pattern === "string") {
      try {
        const re = new RegExp(schema.pattern);
        if (!re.test(value)) {
          errors.push({ path, code: "PATTERN_MISMATCH", message: `pattern ${schema.pattern}`, value });
        }
      } catch (_) {
        /* invalid pattern -> skip */
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({ path, code: "TOO_SMALL", message: `minimum ${schema.minimum}`, value });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({ path, code: "TOO_LARGE", message: `maximum ${schema.maximum}`, value });
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      walkValidate(schema.items, value[i], `${path}/${i}`, errors);
    }
  }
  if (isPlainObject(value) && (schema.properties || Array.isArray(schema.required))) {
    const props = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value) || value[key] === undefined) {
        errors.push({
          path: `${path}/${key}`,
          code: "REQUIRED",
          message: `missing required property "${key}"`,
        });
      }
    }
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) {
        walkValidate(props[k], v, `${path}/${k}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({
          path: `${path}/${k}`,
          code: "UNKNOWN_PROPERTY",
          message: `unknown property "${k}"`,
        });
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Repair                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} RepairResult
 * @property {any}    args
 * @property {Array<{ path: string, kind: string, before: any, after: any }>} repairs
 * @property {ValidationError[]} remainingErrors
 */

/**
 * Attempt a deterministic repair of `args` against `schema`. Always returns
 * a new object; does not mutate the input.
 *
 * @param {any} schema
 * @param {any} args
 * @returns {RepairResult}
 */
export function repairArgs(schema, args) {
  /** @type {Array<{ path: string, kind: string, before: any, after: any }>} */
  const repairs = [];
  const cloned = deepClone(args);
  const repaired = walkRepair(schema, cloned, "", repairs);
  const validation = validateArgs(schema, repaired);
  return { args: repaired, repairs, remainingErrors: validation.errors };
}

function walkRepair(schema, value, path, repairs) {
  if (!schema || typeof schema !== "object") return value;
  const type = schema.type;

  // Apply default for undefined / null if schema provides one.
  if ((value === undefined || value === null) && Object.prototype.hasOwnProperty.call(schema, "default")) {
    repairs.push({ path, kind: "default_applied", before: value, after: schema.default });
    return deepClone(schema.default);
  }

  if (value === undefined || value === null) return value;

  // Type coercion.
  if (type) {
    const targetTypes = Array.isArray(type) ? type : [type];
    const actual = actualType(value);
    if (!typesInclude(type, actual)) {
      // string -> number / integer
      if (typeof value === "string" && (targetTypes.includes("number") || targetTypes.includes("integer"))) {
        const n = Number(value.trim());
        if (Number.isFinite(n)) {
          const coerced = targetTypes.includes("integer") ? Math.trunc(n) : n;
          repairs.push({ path, kind: "coerced_to_number", before: value, after: coerced });
          value = coerced;
        }
      }
      // number -> string
      else if (typeof value === "number" && targetTypes.includes("string")) {
        const s = String(value);
        repairs.push({ path, kind: "coerced_to_string", before: value, after: s });
        value = s;
      }
      // string -> boolean
      else if (typeof value === "string" && targetTypes.includes("boolean")) {
        const trimmed = value.trim().toLowerCase();
        if (trimmed === "true" || trimmed === "yes" || trimmed === "1") {
          repairs.push({ path, kind: "coerced_to_boolean", before: value, after: true });
          value = true;
        } else if (trimmed === "false" || trimmed === "no" || trimmed === "0") {
          repairs.push({ path, kind: "coerced_to_boolean", before: value, after: false });
          value = false;
        }
      }
      // scalar -> array
      else if (!Array.isArray(value) && targetTypes.includes("array")) {
        repairs.push({ path, kind: "wrapped_in_array", before: value, after: [value] });
        value = [value];
      }
    }
  }

  // Enum fuzzy match.
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    const match = fuzzyEnumMatch(value, schema.enum);
    if (match != null) {
      repairs.push({ path, kind: "enum_fuzzy_matched", before: value, after: match });
      value = match;
    }
  }

  // String trim.
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== value) {
      repairs.push({ path, kind: "trimmed", before: value, after: trimmed });
      value = trimmed;
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      const cut = value.slice(0, schema.maxLength);
      repairs.push({ path, kind: "truncated", before: value, after: cut });
      value = cut;
    }
  }

  // Clamp numbers.
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      repairs.push({ path, kind: "clamped_min", before: value, after: schema.minimum });
      value = schema.minimum;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      repairs.push({ path, kind: "clamped_max", before: value, after: schema.maximum });
      value = schema.maximum;
    }
  }

  // Recurse into arrays.
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = walkRepair(schema.items, value[i], `${path}/${i}`, repairs);
    }
  }

  // Recurse into objects.
  if (isPlainObject(value) && schema.properties) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value) || value[key] === undefined) {
        const sub = schema.properties[key];
        if (sub && Object.prototype.hasOwnProperty.call(sub, "default")) {
          repairs.push({ path: `${path}/${key}`, kind: "default_applied", before: undefined, after: sub.default });
          value[key] = deepClone(sub.default);
        }
      }
    }
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties[k]) {
        value[k] = walkRepair(schema.properties[k], v, `${path}/${k}`, repairs);
      } else if (schema.additionalProperties === false) {
        // Strip unknown keys.
        repairs.push({ path: `${path}/${k}`, kind: "stripped_unknown", before: v, after: undefined });
        delete value[k];
      }
    }
  }

  return value;
}

/**
 * Find the closest enum value using case-insensitive substring and
 * Levenshtein distance with a permissive threshold.
 */
function fuzzyEnumMatch(value, choices) {
  if (value == null || !Array.isArray(choices) || choices.length === 0) return null;
  const s = String(value).trim().toLowerCase();
  if (!s) return null;
  let best = null;
  let bestDist = Infinity;
  for (const c of choices) {
    const cs = String(c).toLowerCase();
    if (cs === s) return c;
    if (cs.startsWith(s) || s.startsWith(cs)) {
      const d = Math.abs(cs.length - s.length);
      if (d < bestDist) { bestDist = d; best = c; }
      continue;
    }
    if (cs.includes(s) || s.includes(cs)) {
      const d = Math.abs(cs.length - s.length) + 1;
      if (d < bestDist) { bestDist = d; best = c; }
      continue;
    }
    const d = levenshtein(cs, s);
    const maxLen = Math.max(cs.length, s.length);
    if (d / maxLen <= 0.34 && d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Produce a shallow list of differences between two structurally similar
 * objects. Paths are `/`-separated.
 *
 * @param {any} before
 * @param {any} after
 * @param {string} [prefix]
 * @returns {Array<{ path: string, before: any, after: any }>}
 */
export function diffArgs(before, after, prefix = "") {
  /** @type {Array<{ path: string, before: any, after: any }>} */
  const out = [];
  walkDiff(before, after, prefix, out);
  return out;
}

function walkDiff(a, b, path, out) {
  if (Object.is(a, b)) return;
  const aIsObj = isPlainObject(a);
  const bIsObj = isPlainObject(b);
  if (aIsObj && bIsObj) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      walkDiff(a[k], b[k], `${path}/${k}`, out);
    }
    return;
  }
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr && bIsArr) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
      walkDiff(a[i], b[i], `${path}/${i}`, out);
    }
    return;
  }
  if (!shallowEqual(a, b)) {
    out.push({ path: path || "/", before: a, after: b });
  }
}

/* -------------------------------------------------------------------------- */
/* Suggestions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Generate human-readable hints the LLM can use to fix its arguments.
 *
 * @param {any} schema
 * @param {any} args
 * @returns {string[]}
 */
export function suggestFixes(schema, args) {
  const { errors } = validateArgs(schema, args);
  const hints = [];
  for (const e of errors) {
    switch (e.code) {
      case "REQUIRED":
        hints.push(`Add required field ${e.path}`);
        break;
      case "INVALID_TYPE":
        hints.push(`Change ${e.path}: ${e.message}`);
        break;
      case "NOT_IN_ENUM":
        hints.push(`Pick a valid value for ${e.path}: ${e.message}`);
        break;
      case "TOO_SMALL":
      case "TOO_LARGE":
      case "TOO_SHORT":
      case "TOO_LONG":
      case "PATTERN_MISMATCH":
        hints.push(`Fix bounds on ${e.path}: ${e.message}`);
        break;
      case "UNKNOWN_PROPERTY":
        hints.push(`Remove unknown property ${e.path}`);
        break;
      case "NOT_INTEGER":
        hints.push(`${e.path} must be an integer (no decimals)`);
        break;
      default:
        hints.push(`${e.path}: ${e.message}`);
    }
  }
  return hints;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function actualType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function typesInclude(schemaType, actual) {
  if (Array.isArray(schemaType)) {
    return schemaType.some((t) => matchesType(t, actual));
  }
  return matchesType(schemaType, actual);
}

function matchesType(t, actual) {
  if (t === actual) return true;
  if (t === "number" && actual === "integer") return true;
  return false;
}

function describeType(type) {
  if (Array.isArray(type)) return type.join("|");
  return String(type || "any");
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  return false;
}

function deepClone(v) {
  if (v === undefined || v === null) return v;
  try {
    return structuredClone(v);
  } catch (_) {
    return JSON.parse(JSON.stringify(v));
  }
}
