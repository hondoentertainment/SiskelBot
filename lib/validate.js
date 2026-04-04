/**
 * Lightweight request validation middleware and sanitization helpers.
 * No external dependencies.
 */

const TYPE_CHECKS = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && !Number.isNaN(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  email: (v) =>
    typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
};

function validateFields(data, schema, prefix) {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;

  for (const [field, rule] of Object.entries(schema)) {
    const fullField = prefix ? `${prefix}.${field}` : field;

    if (typeof rule === "object" && rule !== null && !Array.isArray(rule)) {
      // Nested schema
      const nested = data?.[field];
      if (nested === undefined || nested === null) {
        // Nested objects are required by default — check if all children are optional
        const hasRequired = Object.values(rule).some(
          (r) => typeof r === "string" && !r.startsWith("?")
        );
        if (hasRequired) {
          errors.push({ field: fullField, message: `${fullField} is required` });
        }
      } else if (typeof nested !== "object" || Array.isArray(nested)) {
        errors.push({ field: fullField, message: `${fullField} must be an object` });
      } else {
        errors.push(...validateFields(nested, rule, fullField));
      }
      continue;
    }

    if (typeof rule !== "string") continue;

    const optional = rule.startsWith("?");
    const typeName = optional ? rule.slice(1) : rule;
    const value = data?.[field];

    if (value === undefined || value === null) {
      if (!optional) {
        errors.push({ field: fullField, message: `${fullField} is required` });
      }
      continue;
    }

    const checker = TYPE_CHECKS[typeName];
    if (checker && !checker(value)) {
      errors.push({
        field: fullField,
        message: `${fullField} must be of type ${typeName}`,
      });
    }
  }

  return errors;
}

/**
 * Express middleware factory for request validation.
 *
 * @param {{ body?: object, query?: object, params?: object }} schema
 * @returns {Function} Express middleware
 *
 * Usage:
 *   validate({ body: { messages: 'array', model: '?string' } })
 */
export function validate(schema) {
  return (req, res, next) => {
    const details = [];

    if (schema.body) {
      details.push(...validateFields(req.body, schema.body, ""));
    }
    if (schema.query) {
      details.push(...validateFields(req.query, schema.query, ""));
    }
    if (schema.params) {
      details.push(...validateFields(req.params, schema.params, ""));
    }

    if (details.length > 0) {
      return res.status(400).json({
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details,
      });
    }

    next();
  };
}

/**
 * Sanitize a string value: trim, truncate, strip control characters.
 */
export function sanitizeString(value, maxLength = 1000) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .slice(0, maxLength)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Sanitize an ID value: alphanumeric + hyphens + underscores, max 100 chars.
 * Returns empty string if invalid.
 */
export function sanitizeId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, 100);
  return /^[a-zA-Z0-9_-]+$/.test(trimmed) ? trimmed : "";
}

/**
 * Sanitize a workspace ID: alphanumeric + hyphens + underscores, max 100 chars.
 * Falls back to "default" if invalid.
 */
export function sanitizeWorkspaceId(value) {
  const id = sanitizeId(value);
  return id || "default";
}
