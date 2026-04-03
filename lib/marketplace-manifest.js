/**
 * Phase 49: validate signed tool-pack manifest shape (local discovery).
 * Returns stable, machine-searchable error codes in each error string.
 *
 * @param {unknown} data
 * @returns {{ ok: true; manifest: object } | { ok: false; errors: string[] }}
 */
export function validateMarketplaceManifest(data) {
  /** @type {string[]} */
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    errors.push("[E_MANIFEST_OBJECT] manifest must be an object");
    return { ok: false, errors };
  }
  const m = /** @type {Record<string, unknown>} */ (data);
  if (typeof m.id !== "string" || !m.id.trim()) {
    errors.push("[E_MANIFEST_ID_REQUIRED] id must be a non-empty string");
  } else if (!/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(m.id.trim())) {
    errors.push("[E_MANIFEST_ID_FORMAT] id must match ^[a-z0-9][a-z0-9._-]{1,127}$");
  }

  if (typeof m.version !== "string" || !m.version.trim()) {
    errors.push("[E_MANIFEST_VERSION_REQUIRED] version must be a non-empty string");
  } else if (!isSemverLike(m.version.trim())) {
    errors.push("[E_MANIFEST_VERSION_SEMVER] version must be semver-like (e.g. 1.2.3)");
  }

  if (m.tools != null) {
    if (!Array.isArray(m.tools)) {
      errors.push("[E_MANIFEST_TOOLS_TYPE] tools must be an array when present");
    } else {
      validateTools(m.tools, errors);
    }
  }

  if (m.signature != null) {
    validateSignature(m.signature, errors);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: m };
}

/**
 * @param {unknown[]} tools
 * @param {string[]} errors
 */
function validateTools(tools, errors) {
  /** @type {Set<string>} */
  const names = new Set();
  for (let i = 0; i < tools.length; i += 1) {
    const t = tools[i];
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      errors.push(`[E_TOOL_OBJECT] tools[${i}] must be an object`);
      continue;
    }
    const tool = /** @type {Record<string, unknown>} */ (t);
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) {
      errors.push(`[E_TOOL_NAME_REQUIRED] tools[${i}].name must be a non-empty string`);
    } else if (!/^[a-z][a-z0-9_]{1,63}$/i.test(name)) {
      errors.push(`[E_TOOL_NAME_FORMAT] tools[${i}].name must match ^[a-z][a-z0-9_]{1,63}$`);
    } else if (names.has(name)) {
      errors.push(`[E_TOOL_NAME_DUPLICATE] duplicate tool name: ${name}`);
    } else {
      names.add(name);
    }

    if (tool.description != null && (typeof tool.description !== "string" || !tool.description.trim())) {
      errors.push(`[E_TOOL_DESCRIPTION_TYPE] tools[${i}].description must be a non-empty string when present`);
    }

    if (tool.inputSchema != null && !isPlainObject(tool.inputSchema)) {
      errors.push(`[E_TOOL_INPUT_SCHEMA_TYPE] tools[${i}].inputSchema must be an object when present`);
    }
  }
}

/**
 * @param {unknown} signature
 * @param {string[]} errors
 */
function validateSignature(signature, errors) {
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) {
    errors.push("[E_SIGNATURE_OBJECT] signature must be an object when present");
    return;
  }
  const s = /** @type {Record<string, unknown>} */ (signature);
  if (typeof s.algorithm !== "string" || !s.algorithm.trim()) {
    errors.push("[E_SIGNATURE_ALGORITHM_REQUIRED] signature.algorithm must be a non-empty string");
  }
  if (typeof s.keyId !== "string" || !s.keyId.trim()) {
    errors.push("[E_SIGNATURE_KEY_ID_REQUIRED] signature.keyId must be a non-empty string");
  }
  if (typeof s.value !== "string" || !s.value.trim()) {
    errors.push("[E_SIGNATURE_VALUE_REQUIRED] signature.value must be a non-empty string");
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Lightweight semver validator (1.2.3 + optional pre-release/build).
 * @param {string} version
 * @returns {boolean}
 */
function isSemverLike(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}
