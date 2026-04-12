// @ts-check
/**
 * Phase 55: Strict tool argument validation before execution.
 * Invalid calls return structured tool messages so the model can repair on the next iteration.
 *
 * Phase 53.5: JSON schema validation + schema-guided repair for function-call arguments.
 * Adds a JSON Schema draft-07 subset validator, automatic repair of common
 * malformations (type coercion, default filling, string trimming, JSON extraction),
 * and reporting helpers. Exports are additive and overloaded to preserve the
 * legacy `validateToolCall(name, args, opts)` signature used by the agent loop.
 *
 * @module tool-validation
 */

/** @type {Set<string>} */
const KNOWN_TOOLS = new Set([
  "execute_step",
  "search_context",
  "list_context",
  "semantic_search_context",
  "get_context_document",
  "list_recipes",
  "get_recipe",
  "remember_workspace_fact",
  "list_workspace_memory",
  "fetch_allowed_url",
  "workspace_list_dir",
  "workspace_read_file",
  "workspace_search_text",
  "workspace_write_file",
  "workspace_git_status",
  "workspace_git_log",
  "workspace_git_diff",
  "workspace_git_commit",
  "workspace_run_command",
  "browser_open_extract_text",
  "browser_capture_screenshot",
  "update_agent_session_plan",
]);

/**
 * Legacy validator: validates a tool call by name against a hardcoded tool registry.
 * Used by the agent loop/swarm.
 *
 * @param {string|null|undefined} name
 * @param {object} args - parsed arguments (may be empty object if JSON.parse failed)
 * @param {{ parseError?: string|null }} [opts]
 * @returns {SiskelBot.ToolValidationResult}
 */
function validateNamedToolCall(name, args, opts = {}) {
  const errors = [];
  const parseError = opts.parseError;

  if (parseError) {
    errors.push(`Invalid JSON in function.arguments: ${parseError}`);
    return {
      valid: false,
      errors,
      repairHint:
        "function.arguments must be valid JSON matching the tool schema. " +
        "For example search_context requires {\"query\": \"your search text\"}.",
    };
  }

  if (!name || typeof name !== "string") {
    errors.push("Missing or invalid function name");
    return { valid: false, errors, repairHint: "Use one of the registered tool names." };
  }

  if (!KNOWN_TOOLS.has(name)) {
    errors.push(`Unknown tool "${name}"`);
    return {
      valid: false,
      errors,
      repairHint: `Valid tools: ${[...KNOWN_TOOLS].join(", ")}`,
    };
  }

  if (!args || typeof args !== "object" || Array.isArray(args)) {
    errors.push("Arguments must be a JSON object");
    return { valid: false, errors, repairHint: "Pass a single JSON object as function.arguments." };
  }

  switch (name) {
    case "execute_step": {
      const action = args.action;
      if (typeof action !== "string" || !action.trim()) {
        errors.push("execute_step requires non-empty string property `action`");
      }
      break;
    }
    case "search_context": {
      if (typeof args.query !== "string" || !args.query.trim()) {
        errors.push("search_context requires non-empty string property `query`");
      }
      break;
    }
    case "list_context":
      break;
    case "semantic_search_context": {
      if (typeof args.query !== "string" || !args.query.trim()) {
        errors.push("semantic_search_context requires non-empty string property `query`");
      }
      break;
    }
    case "get_context_document": {
      if (typeof args.id !== "string" || !args.id.trim()) {
        errors.push("get_context_document requires non-empty string property `id`");
      }
      break;
    }
    case "list_recipes":
      break;
    case "get_recipe": {
      if (typeof args.name !== "string" || !args.name.trim()) {
        errors.push("get_recipe requires non-empty string property `name`");
      }
      break;
    }
    case "remember_workspace_fact": {
      if (typeof args.fact !== "string" || !args.fact.trim()) {
        errors.push("remember_workspace_fact requires non-empty string property `fact`");
      }
      break;
    }
    case "list_workspace_memory":
      break;
    case "fetch_allowed_url": {
      if (typeof args.url !== "string" || !args.url.trim()) {
        errors.push("fetch_allowed_url requires non-empty string property `url`");
      }
      break;
    }
    case "workspace_list_dir":
      break;
    case "workspace_read_file": {
      if (typeof args.path !== "string" || !args.path.trim()) {
        errors.push("workspace_read_file requires non-empty string property `path`");
      }
      break;
    }
    case "workspace_search_text": {
      if (typeof args.query !== "string" || !args.query.trim()) {
        errors.push("workspace_search_text requires non-empty string property `query`");
      }
      break;
    }
    case "workspace_write_file": {
      if (typeof args.path !== "string" || !args.path.trim()) {
        errors.push("workspace_write_file requires non-empty string property `path`");
      }
      if (typeof args.content !== "string") {
        errors.push("workspace_write_file requires string property `content`");
      }
      break;
    }
    case "workspace_git_status":
      break;
    case "workspace_git_log":
      break;
    case "workspace_git_diff":
      break;
    case "workspace_git_commit": {
      if (typeof args.message !== "string" || !args.message.trim()) {
        errors.push("workspace_git_commit requires non-empty string property `message`");
      }
      if (!Array.isArray(args.paths) || args.paths.length === 0) {
        errors.push("workspace_git_commit requires non-empty array property `paths`");
      }
      break;
    }
    case "workspace_run_command": {
      if (!Array.isArray(args.argv) || args.argv.length === 0) {
        errors.push("workspace_run_command requires non-empty array property `argv`");
      } else if (!args.argv.every((x) => typeof x === "string")) {
        errors.push("workspace_run_command argv entries must be strings");
      }
      break;
    }
    case "browser_open_extract_text": {
      if (typeof args.url !== "string" || !args.url.trim()) {
        errors.push("browser_open_extract_text requires non-empty string property `url`");
      }
      break;
    }
    case "browser_capture_screenshot": {
      if (typeof args.url !== "string" || !args.url.trim()) {
        errors.push("browser_capture_screenshot requires non-empty string property `url`");
      }
      break;
    }
    case "update_agent_session_plan": {
      const hasSummary = Object.prototype.hasOwnProperty.call(args, "planSummary");
      const hasDag = Object.prototype.hasOwnProperty.call(args, "planDag");
      if (!hasSummary && !hasDag) {
        errors.push("update_agent_session_plan requires at least one of planSummary or planDag");
      }
      if (hasDag && args.planDag !== null && args.planDag !== undefined) {
        if (typeof args.planDag !== "object" || Array.isArray(args.planDag)) {
          errors.push("update_agent_session_plan planDag must be an object when provided");
        }
      }
      break;
    }
    default:
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
    repairHint: errors.join("; "),
  };
}

/**
 * Whether strict tool validation is enabled (default: true, disabled by TOOL_VALIDATION_STRICT=0).
 * @returns {boolean}
 */
export function toolValidationEnabled() {
  return process.env.TOOL_VALIDATION_STRICT !== "0";
}

// -----------------------------------------------------------------------------
// Phase 53.5: JSON Schema draft-07 (subset) validator + schema-guided repair
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} ValidationError
 * @property {string} path
 * @property {string} message
 * @property {string} [expected]
 * @property {*} [actual]
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {ValidationError[]} errors
 */

/**
 * @typedef {Object} RepairEntry
 * @property {string} path
 * @property {string} action
 * @property {*} before
 * @property {*} after
 */

/**
 * @typedef {Object} RepairResult
 * @property {*} repaired
 * @property {RepairEntry[]} repairs
 */

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function joinPath(base, key) {
  if (!base) return String(key);
  return `${base}.${key}`;
}

function joinIndex(base, index) {
  return `${base || "$"}[${index}]`;
}

function typeOfSchema(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesJsonType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    default:
      return true;
  }
}

/**
 * Validate that a value matches a schema `type`. Returns a list of errors.
 * @param {object} schema
 * @param {*} value
 * @param {string} [path]
 * @returns {ValidationError[]}
 */
export function validateType(schema, value, path = "") {
  if (!schema || schema.type === undefined) return [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.some((t) => matchesJsonType(value, t))) return [];
  return [
    {
      path: path || "$",
      message: `expected type ${types.join("|")} but got ${typeOfSchema(value)}`,
      expected: types.join("|"),
      actual: typeOfSchema(value),
    },
  ];
}

/**
 * Validate a string value against schema string constraints.
 * @param {object} schema
 * @param {*} value
 * @param {string} [path]
 * @returns {ValidationError[]}
 */
export function validateString(schema, value, path = "") {
  const errors = [];
  if (typeof value !== "string") return errors;
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    errors.push({
      path: path || "$",
      message: `string length ${value.length} is less than minLength ${schema.minLength}`,
      expected: `>=${schema.minLength}`,
      actual: value.length,
    });
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    errors.push({
      path: path || "$",
      message: `string length ${value.length} exceeds maxLength ${schema.maxLength}`,
      expected: `<=${schema.maxLength}`,
      actual: value.length,
    });
  }
  if (schema.pattern) {
    try {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        errors.push({
          path: path || "$",
          message: `string does not match pattern ${schema.pattern}`,
          expected: schema.pattern,
          actual: value,
        });
      }
    } catch {
      // invalid regex in schema — ignore
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({
      path: path || "$",
      message: `value is not in enum`,
      expected: schema.enum.join("|"),
      actual: value,
    });
  }
  return errors;
}

/**
 * Validate a numeric value against schema number constraints.
 * @param {object} schema
 * @param {*} value
 * @param {string} [path]
 * @returns {ValidationError[]}
 */
export function validateNumber(schema, value, path = "") {
  const errors = [];
  if (typeof value !== "number" || Number.isNaN(value)) return errors;
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push({
      path: path || "$",
      message: `value ${value} is less than minimum ${schema.minimum}`,
      expected: `>=${schema.minimum}`,
      actual: value,
    });
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    errors.push({
      path: path || "$",
      message: `value ${value} exceeds maximum ${schema.maximum}`,
      expected: `<=${schema.maximum}`,
      actual: value,
    });
  }
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    errors.push({
      path: path || "$",
      message: `value ${value} is not greater than exclusiveMinimum ${schema.exclusiveMinimum}`,
      expected: `>${schema.exclusiveMinimum}`,
      actual: value,
    });
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    errors.push({
      path: path || "$",
      message: `value ${value} is not less than exclusiveMaximum ${schema.exclusiveMaximum}`,
      expected: `<${schema.exclusiveMaximum}`,
      actual: value,
    });
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
    const ratio = value / schema.multipleOf;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
      errors.push({
        path: path || "$",
        message: `value ${value} is not a multiple of ${schema.multipleOf}`,
        expected: `multiple of ${schema.multipleOf}`,
        actual: value,
      });
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({
      path: path || "$",
      message: `value is not in enum`,
      expected: schema.enum.join("|"),
      actual: value,
    });
  }
  return errors;
}

/**
 * Validate an array against schema array constraints.
 * @param {object} schema
 * @param {*} value
 * @param {string} [path]
 * @returns {ValidationError[]}
 */
export function validateArray(schema, value, path = "") {
  const errors = [];
  if (!Array.isArray(value)) return errors;
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    errors.push({
      path: path || "$",
      message: `array has ${value.length} items, less than minItems ${schema.minItems}`,
      expected: `>=${schema.minItems}`,
      actual: value.length,
    });
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    errors.push({
      path: path || "$",
      message: `array has ${value.length} items, exceeds maxItems ${schema.maxItems}`,
      expected: `<=${schema.maxItems}`,
      actual: value.length,
    });
  }
  if (schema.uniqueItems === true) {
    const seen = new Set();
    for (const item of value) {
      const key = typeof item === "object" ? JSON.stringify(item) : `${typeof item}:${item}`;
      if (seen.has(key)) {
        errors.push({
          path: path || "$",
          message: `array items must be unique`,
          expected: "unique",
          actual: value.length,
        });
        break;
      }
      seen.add(key);
    }
  }
  if (schema.items && isPlainObject(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      errors.push(...validate(schema.items, value[i], { path: joinIndex(path, i) }).errors);
    }
  }
  return errors;
}

/**
 * Validate an object against schema object constraints.
 * @param {object} schema
 * @param {*} value
 * @param {string} [path]
 * @returns {ValidationError[]}
 */
export function validateObject(schema, value, path = "") {
  const errors = [];
  if (!isPlainObject(value)) return errors;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push({
        path: joinPath(path, key),
        message: `required property "${key}" is missing`,
        expected: "required",
        actual: undefined,
      });
    }
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : null;
  if (properties) {
    for (const [key, subSchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      errors.push(...validate(subSchema, value[key], { path: joinPath(path, key) }).errors);
    }
  }
  if (schema.additionalProperties === false) {
    const known = properties ? new Set(Object.keys(properties)) : new Set();
    for (const key of Object.keys(value)) {
      if (!known.has(key)) {
        errors.push({
          path: joinPath(path, key),
          message: `additional property "${key}" is not allowed`,
          expected: "no additional properties",
          actual: key,
        });
      }
    }
  }
  if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
    errors.push({
      path: path || "$",
      message: `object has ${Object.keys(value).length} properties, less than minProperties ${schema.minProperties}`,
      expected: `>=${schema.minProperties}`,
      actual: Object.keys(value).length,
    });
  }
  if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) {
    errors.push({
      path: path || "$",
      message: `object has ${Object.keys(value).length} properties, exceeds maxProperties ${schema.maxProperties}`,
      expected: `<=${schema.maxProperties}`,
      actual: Object.keys(value).length,
    });
  }
  return errors;
}

/**
 * Core validator. Dispatches to type-specific validators.
 * @param {object} schema
 * @param {*} value
 * @param {{ path?: string }} [options]
 * @returns {ValidationResult}
 */
export function validate(schema, value, options = {}) {
  const path = options.path || "";
  const errors = [];
  if (!schema || typeof schema !== "object") {
    return { valid: true, errors };
  }

  errors.push(...validateType(schema, value, path));
  // If the type is wrong, skip deeper constraint checks for clarity.
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  if (typeof value === "string") {
    errors.push(...validateString(schema, value, path));
  } else if (typeof value === "number") {
    errors.push(...validateNumber(schema, value, path));
  } else if (Array.isArray(value)) {
    errors.push(...validateArray(schema, value, path));
  } else if (isPlainObject(value)) {
    errors.push(...validateObject(schema, value, path));
  }

  // enum on mixed types
  if (Array.isArray(schema.enum) && typeof value !== "string" && typeof value !== "number") {
    const found = schema.enum.some((candidate) => {
      if (candidate === value) return true;
      try {
        return JSON.stringify(candidate) === JSON.stringify(value);
      } catch {
        return false;
      }
    });
    if (!found) {
      errors.push({
        path: path || "$",
        message: `value is not in enum`,
        expected: JSON.stringify(schema.enum),
        actual: value,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

// -----------------------------------------------------------------------------
// Schema-guided repair
// -----------------------------------------------------------------------------

/**
 * Coerce a primitive value into the schema's declared type if possible.
 * @param {object} schema
 * @param {*} value
 * @param {string} path
 * @param {RepairEntry[]} repairs
 * @returns {*}
 */
export function coerceTypes(schema, value, path = "", repairs = []) {
  if (!schema || schema.type === undefined) return value;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];

  // Already matches one of the accepted types
  if (types.some((t) => matchesJsonType(value, t))) return value;

  const pick = (t) => types.includes(t);

  // number coercion
  if (pick("number") || pick("integer")) {
    if (typeof value === "string" && value.trim() !== "") {
      const num = Number(value);
      if (!Number.isNaN(num)) {
        const coerced = pick("integer") ? Math.trunc(num) : num;
        repairs.push({ path: path || "$", action: "coerce-number", before: value, after: coerced });
        return coerced;
      }
    }
    if (typeof value === "boolean") {
      const coerced = value ? 1 : 0;
      repairs.push({ path: path || "$", action: "coerce-number", before: value, after: coerced });
      return coerced;
    }
  }

  // boolean coercion
  if (pick("boolean")) {
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes") {
        repairs.push({ path: path || "$", action: "coerce-boolean", before: value, after: true });
        return true;
      }
      if (v === "false" || v === "0" || v === "no" || v === "") {
        repairs.push({ path: path || "$", action: "coerce-boolean", before: value, after: false });
        return false;
      }
    }
    if (typeof value === "number") {
      const coerced = value !== 0;
      repairs.push({ path: path || "$", action: "coerce-boolean", before: value, after: coerced });
      return coerced;
    }
  }

  // string coercion
  if (pick("string")) {
    if (typeof value === "number" || typeof value === "boolean") {
      const coerced = String(value);
      repairs.push({ path: path || "$", action: "coerce-string", before: value, after: coerced });
      return coerced;
    }
  }

  // object from JSON string
  if (pick("object") && typeof value === "string") {
    const parsed = tryParseJson(value);
    if (parsed !== undefined && isPlainObject(parsed)) {
      repairs.push({ path: path || "$", action: "parse-json-object", before: value, after: parsed });
      return parsed;
    }
  }

  // array from JSON string or comma-separated
  if (pick("array") && typeof value === "string") {
    const parsed = tryParseJson(value);
    if (Array.isArray(parsed)) {
      repairs.push({ path: path || "$", action: "parse-json-array", before: value, after: parsed });
      return parsed;
    }
    if (value.includes(",")) {
      const split = value.split(",").map((s) => s.trim()).filter(Boolean);
      repairs.push({ path: path || "$", action: "split-csv-array", before: value, after: split });
      return split;
    }
  }

  // null coercion
  if (pick("null") && (value === "" || value === "null")) {
    repairs.push({ path: path || "$", action: "coerce-null", before: value, after: null });
    return null;
  }

  return value;
}

/**
 * Repair string values: trim trailing whitespace when exceeding maxLength.
 * @param {object} schema
 * @param {*} value
 * @param {string} [path]
 * @param {RepairEntry[]} [repairs]
 * @returns {*}
 */
export function repairStrings(schema, value, path = "", repairs = []) {
  if (typeof value !== "string" || !schema) return value;
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    const trimmed = value.slice(0, schema.maxLength);
    repairs.push({ path: path || "$", action: "trim-maxLength", before: value, after: trimmed });
    return trimmed;
  }
  return value;
}

/**
 * Repair number values by clamping to the schema bounds.
 * @param {object} schema
 * @param {*} value
 * @param {string} [path]
 * @param {RepairEntry[]} [repairs]
 * @returns {*}
 */
export function repairNumbers(schema, value, path = "", repairs = []) {
  if (typeof value !== "number" || Number.isNaN(value) || !schema) return value;
  let v = value;
  if (typeof schema.minimum === "number" && v < schema.minimum) {
    repairs.push({ path: path || "$", action: "clamp-min", before: v, after: schema.minimum });
    v = schema.minimum;
  }
  if (typeof schema.maximum === "number" && v > schema.maximum) {
    repairs.push({ path: path || "$", action: "clamp-max", before: v, after: schema.maximum });
    v = schema.maximum;
  }
  if (schema.type === "integer" && !Number.isInteger(v)) {
    const int = Math.trunc(v);
    repairs.push({ path: path || "$", action: "truncate-integer", before: v, after: int });
    v = int;
  }
  return v;
}

/**
 * Repair array values: drop excess items and recursively repair each.
 * @param {object} schema
 * @param {*} value
 * @param {string} [path]
 * @param {RepairEntry[]} [repairs]
 * @returns {*}
 */
export function repairArrays(schema, value, path = "", repairs = []) {
  if (!Array.isArray(value) || !schema) return value;
  let out = value;
  if (typeof schema.maxItems === "number" && out.length > schema.maxItems) {
    const trimmed = out.slice(0, schema.maxItems);
    repairs.push({ path: path || "$", action: "trim-maxItems", before: out.length, after: trimmed.length });
    out = trimmed;
  }
  if (schema.uniqueItems === true) {
    const seen = new Set();
    const unique = [];
    for (const item of out) {
      const key = typeof item === "object" ? JSON.stringify(item) : `${typeof item}:${item}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(item);
      }
    }
    if (unique.length !== out.length) {
      repairs.push({ path: path || "$", action: "dedupe-array", before: out.length, after: unique.length });
      out = unique;
    }
  }
  if (schema.items && isPlainObject(schema.items)) {
    out = out.map((item, i) => {
      const sub = repair(schema.items, item, { path: joinIndex(path, i), _repairs: repairs });
      return sub.repaired;
    });
  }
  return out;
}

/**
 * Repair object values: remove extras when additionalProperties: false, recurse.
 * @param {object} schema
 * @param {*} value
 * @param {string} [path]
 * @param {RepairEntry[]} [repairs]
 * @returns {*}
 */
export function repairObjects(schema, value, path = "", repairs = []) {
  if (!isPlainObject(value) || !schema) return value;
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const out = { ...value };

  if (schema.additionalProperties === false) {
    const known = new Set(Object.keys(properties));
    for (const key of Object.keys(out)) {
      if (!known.has(key)) {
        repairs.push({
          path: joinPath(path, key),
          action: "remove-additional",
          before: out[key],
          after: undefined,
        });
        delete out[key];
      }
    }
  }

  for (const [key, subSchema] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      const sub = repair(subSchema, out[key], { path: joinPath(path, key), _repairs: repairs });
      out[key] = sub.repaired;
    }
  }

  return out;
}

/**
 * Fill default values for missing properties defined in the schema.
 * @param {object} schema
 * @param {*} value
 * @param {string} [path]
 * @param {RepairEntry[]} [repairs]
 * @returns {*}
 */
export function fillDefaults(schema, value, path = "", repairs = []) {
  if (!schema || !isPlainObject(schema)) return value;

  // Top-level default for non-object values
  if (value === undefined && schema.default !== undefined) {
    repairs.push({
      path: path || "$",
      action: "fill-default",
      before: undefined,
      after: schema.default,
    });
    return structuredClone(schema.default);
  }

  if (!isPlainObject(value)) return value;
  const properties = isPlainObject(schema.properties) ? schema.properties : null;
  if (!properties) return value;

  const out = { ...value };
  for (const [key, subSchema] of Object.entries(properties)) {
    if (!isPlainObject(subSchema)) continue;
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      if (subSchema.default !== undefined) {
        const def = structuredClone(subSchema.default);
        repairs.push({
          path: joinPath(path, key),
          action: "fill-default",
          before: undefined,
          after: def,
        });
        out[key] = def;
      }
    } else {
      out[key] = fillDefaults(subSchema, out[key], joinPath(path, key), repairs);
    }
  }
  return out;
}

/**
 * Repair a value to better match the schema. Safe to call on any input.
 * @param {object} schema
 * @param {*} value
 * @param {{ path?: string, _repairs?: RepairEntry[] }} [options]
 * @returns {RepairResult}
 */
export function repair(schema, value, options = {}) {
  const path = options.path || "";
  const repairs = options._repairs || [];

  if (!schema || typeof schema !== "object") {
    return { repaired: value, repairs };
  }

  // 1. Parse JSON string when a structured type is expected
  let current = value;
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (typeof current === "string" && (types.includes("object") || types.includes("array"))) {
    const parsed = tryParseJson(current) ?? tryParseJson(repairJson(current));
    if (parsed !== undefined && (isPlainObject(parsed) || Array.isArray(parsed))) {
      repairs.push({
        path: path || "$",
        action: "parse-json",
        before: current,
        after: parsed,
      });
      current = parsed;
    }
  }

  // 2. Coerce scalar types (string->number, "true"->true, etc.)
  current = coerceTypes(schema, current, path, repairs);

  // 3. Type-specific repairs
  if (typeof current === "string") {
    current = repairStrings(schema, current, path, repairs);
  } else if (typeof current === "number") {
    current = repairNumbers(schema, current, path, repairs);
  } else if (Array.isArray(current)) {
    current = repairArrays(schema, current, path, repairs);
  } else if (isPlainObject(current)) {
    current = repairObjects(schema, current, path, repairs);
  }

  // 4. Fill defaults for missing required fields (only for objects)
  if (isPlainObject(current) && isPlainObject(schema.properties)) {
    current = fillDefaults(schema, current, path, repairs);
  } else if (current === undefined && schema.default !== undefined) {
    current = fillDefaults(schema, current, path, repairs);
  }

  if (options._repairs) {
    return { repaired: current, repairs };
  }
  return { repaired: current, repairs };
}

// -----------------------------------------------------------------------------
// JSON extraction and repair for LLM output
// -----------------------------------------------------------------------------

function tryParseJson(text) {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Extract the first JSON object/array from free-form text (e.g., LLM output).
 * Handles markdown code blocks and surrounding prose.
 * @param {string} text
 * @returns {* | null}
 */
export function extractJson(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Try direct parse first
  const direct = tryParseJson(trimmed);
  if (direct !== undefined) return direct;

  // Markdown code block: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    const parsed = tryParseJson(inner) ?? tryParseJson(repairJson(inner));
    if (parsed !== undefined) return parsed;
  }

  // Scan for first balanced { ... } or [ ... ]
  const openers = ["{", "["];
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (!openers.includes(ch)) continue;
    const end = findMatchingBracket(trimmed, i);
    if (end === -1) continue;
    const candidate = trimmed.slice(i, end + 1);
    const parsed = tryParseJson(candidate) ?? tryParseJson(repairJson(candidate));
    if (parsed !== undefined) return parsed;
  }

  // Last-ditch repair on entire string
  const repaired = tryParseJson(repairJson(trimmed));
  if (repaired !== undefined) return repaired;

  return null;
}

function findMatchingBracket(text, start) {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Repair common JSON malformations: trailing commas, single quotes, unquoted keys.
 * @param {string} text
 * @returns {string}
 */
export function repairJson(text) {
  if (typeof text !== "string") return text;
  let out = text;

  // Strip JS-style comments
  out = out.replace(/\/\/[^\n\r]*/g, "");
  out = out.replace(/\/\*[\s\S]*?\*\//g, "");

  // Convert single-quoted strings to double-quoted.
  // Walk through the text, toggling between in-string states.
  out = convertSingleToDoubleQuotes(out);

  // Quote unquoted object keys: { foo: 1 } -> { "foo": 1 }
  out = out.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');

  // Remove trailing commas in objects/arrays
  out = out.replace(/,(\s*[}\]])/g, "$1");

  // Replace Python/JS constants
  out = out.replace(/\bNone\b/g, "null");
  out = out.replace(/\bTrue\b/g, "true");
  out = out.replace(/\bFalse\b/g, "false");

  return out;
}

function convertSingleToDoubleQuotes(text) {
  let result = "";
  let i = 0;
  let inDouble = false;
  let inSingle = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inDouble) {
      result += ch;
      if (ch === "\\" && next !== undefined) {
        result += next;
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (inSingle) {
      if (ch === "\\" && next !== undefined) {
        // Preserve escaped char but translate \' to '
        if (next === "'") {
          result += "'";
        } else {
          result += ch + next;
        }
        i += 2;
        continue;
      }
      if (ch === "'") {
        result += '"';
        inSingle = false;
        i++;
        continue;
      }
      if (ch === '"') {
        // Escape embedded double quote
        result += '\\"';
        i++;
        continue;
      }
      result += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      result += ch;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      result += '"';
      i++;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

// -----------------------------------------------------------------------------
// Tool call validation + repair (schema-based API) — overloads legacy signature
// -----------------------------------------------------------------------------

/**
 * Overloaded dispatcher.
 *
 * Legacy mode (string first arg):
 *   validateToolCall(name: string, args: object, opts?: { parseError? })
 *   -> { valid, errors: string[], repairHint }
 *
 * Schema mode (object first arg):
 *   validateToolCall(toolSchema: { name?, parameters|schema }, call: { name, arguments })
 *   -> { valid, errors: ValidationError[], repaired? }
 *
 * @returns {SiskelBot.ToolValidationResult | ValidationResult & { repaired?: * }}
 */
export function validateToolCall(first, second, third) {
  if (typeof first === "string" || first == null) {
    // Legacy signature
    return validateNamedToolCall(first, second, third);
  }
  // Schema signature
  return validateToolCallSchema(first, second);
}

/**
 * Validate a tool call against a JSON schema descriptor.
 * @param {{ name?: string, parameters?: object, schema?: object }} toolSchema
 * @param {{ name?: string, arguments?: * }} call
 * @returns {ValidationResult & { repaired?: * }}
 */
function validateToolCallSchema(toolSchema, call) {
  const errors = [];
  if (!isPlainObject(toolSchema)) {
    return { valid: false, errors: [{ path: "$", message: "toolSchema must be an object" }] };
  }
  if (!isPlainObject(call)) {
    return { valid: false, errors: [{ path: "$", message: "call must be an object" }] };
  }
  if (toolSchema.name && call.name && toolSchema.name !== call.name) {
    errors.push({
      path: "name",
      message: `tool name mismatch: expected ${toolSchema.name}, got ${call.name}`,
      expected: toolSchema.name,
      actual: call.name,
    });
  }
  const paramSchema = toolSchema.parameters || toolSchema.schema || {};
  let args = call.arguments;
  if (typeof args === "string") {
    const parsed = tryParseJson(args) ?? tryParseJson(repairJson(args));
    if (parsed !== undefined) args = parsed;
  }
  const sub = validate(paramSchema, args);
  errors.push(...sub.errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Auto-repair a tool call: extract/parse JSON arguments, repair against schema,
 * then validate.
 * @param {{ name?: string, parameters?: object, schema?: object }} toolSchema
 * @param {{ name?: string, arguments?: * }} call
 * @returns {{ valid: boolean, errors: ValidationError[], repaired: { name?: string, arguments: * }, repairs: RepairEntry[] }}
 */
export function autoRepairToolCall(toolSchema, call) {
  const repairs = [];
  const outCall = { name: call?.name, arguments: undefined };
  const paramSchema = (toolSchema && (toolSchema.parameters || toolSchema.schema)) || {};
  let args = call?.arguments;

  if (typeof args === "string") {
    const parsed = extractJson(args);
    if (parsed !== null) {
      repairs.push({ path: "arguments", action: "extract-json", before: args, after: parsed });
      args = parsed;
    }
  }
  if (args === undefined || args === null) {
    args = {};
    repairs.push({ path: "arguments", action: "default-empty-object", before: call?.arguments, after: {} });
  }

  const result = repair(paramSchema, args);
  repairs.push(...result.repairs);
  outCall.arguments = result.repaired;

  const v = validate(paramSchema, outCall.arguments);
  return { valid: v.valid, errors: v.errors, repaired: outCall, repairs };
}

// -----------------------------------------------------------------------------
// Reporting
// -----------------------------------------------------------------------------

/**
 * Format a list of validation errors as text or JSON.
 * @param {ValidationError[]} errors
 * @param {"text"|"json"} [format]
 * @returns {string}
 */
export function formatErrors(errors, format = "text") {
  if (!Array.isArray(errors)) return format === "json" ? "[]" : "";
  if (format === "json") {
    return JSON.stringify(errors, null, 2);
  }
  return errors.map((e) => `${e.path || "$"}: ${e.message}`).join("\n");
}

/**
 * In-memory validation-event store. Not persisted — scoped to this process.
 * @type {{ events: Array<{ at: number, valid: boolean, toolName?: string, errorCount: number, repaired?: boolean }>, stats: { total: number, valid: number, invalid: number, repaired: number } }}
 */
const _validationEvents = {
  events: [],
  stats: { total: 0, valid: 0, invalid: 0, repaired: 0 },
};
const MAX_VALIDATION_EVENTS = 500;

/**
 * Record a validation event for later inspection via getValidationStats.
 * @param {{ valid?: boolean, toolName?: string, errorCount?: number, repaired?: boolean }} event
 * @returns {Promise<void>}
 */
export async function recordValidationEvent(event) {
  const entry = {
    at: Date.now(),
    valid: Boolean(event?.valid),
    toolName: event?.toolName || undefined,
    errorCount: Number.isFinite(event?.errorCount) ? event.errorCount : 0,
    repaired: Boolean(event?.repaired),
  };
  _validationEvents.events.push(entry);
  if (_validationEvents.events.length > MAX_VALIDATION_EVENTS) {
    _validationEvents.events.splice(0, _validationEvents.events.length - MAX_VALIDATION_EVENTS);
  }
  _validationEvents.stats.total++;
  if (entry.valid) _validationEvents.stats.valid++;
  else _validationEvents.stats.invalid++;
  if (entry.repaired) _validationEvents.stats.repaired++;
}

/**
 * Aggregate validation stats collected via recordValidationEvent.
 * @returns {Promise<{ total: number, valid: number, invalid: number, repaired: number, recent: Array<object>, byTool: Record<string, { total: number, valid: number, invalid: number }> }>}
 */
export async function getValidationStats() {
  const byTool = {};
  for (const ev of _validationEvents.events) {
    const key = ev.toolName || "<unknown>";
    if (!byTool[key]) byTool[key] = { total: 0, valid: 0, invalid: 0 };
    byTool[key].total++;
    if (ev.valid) byTool[key].valid++;
    else byTool[key].invalid++;
  }
  return {
    ...(_validationEvents.stats),
    recent: _validationEvents.events.slice(-50),
    byTool,
  };
}

/**
 * Reset recorded validation stats. Exposed for tests.
 */
export function _resetValidationStats() {
  _validationEvents.events.length = 0;
  _validationEvents.stats.total = 0;
  _validationEvents.stats.valid = 0;
  _validationEvents.stats.invalid = 0;
  _validationEvents.stats.repaired = 0;
}
