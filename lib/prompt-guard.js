/**
 * Phase 26: AI Quality & Safety — Input safety.
 * Detects prompt injection attempts, PII, and sanitizes user input.
 */

const INJECTION_PATTERNS = [
  { pattern: /ignore (all |previous |above )?instructions/i, name: "ignore_instructions" },
  { pattern: /you are now/i, name: "role_override" },
  { pattern: /system:\s*override/i, name: "system_override" },
  { pattern: /\bDAN\b.*mode/i, name: "dan_mode" },
  { pattern: /pretend you (are|have)/i, name: "pretend_role" },
  { pattern: /reveal.*system.*prompt/i, name: "reveal_system_prompt" },
  { pattern: /disregard (all |any |prior |your )*instructions/i, name: "disregard_instructions" },
  { pattern: /bypass (your |all |any )?restrictions/i, name: "bypass_restrictions" },
  { pattern: /enter (developer|debug|admin|god) mode/i, name: "special_mode" },
  { pattern: /jailbreak/i, name: "jailbreak" },
  { pattern: /do anything now/i, name: "do_anything_now" },
  { pattern: /act as (an? )?(unrestricted|unfiltered|uncensored)/i, name: "act_unrestricted" },
  { pattern: /new (system |base )?prompt/i, name: "new_prompt" },
  { pattern: /forget (all |your |previous |prior )*instructions/i, name: "forget_instructions" },
  { pattern: /override (safety|content|ethical) (filter|policy|guideline)/i, name: "override_safety" },
];

const PII_PATTERNS = [
  { type: "email", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { type: "phone", pattern: /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g },
  { type: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: "credit_card", pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g },
];

// Control character ranges (excluding normal whitespace)
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Detect prompt injection attempts in input text.
 * @param {string} text
 * @returns {{ safe: boolean, risk: 'none'|'low'|'medium'|'high', patterns: string[] }}
 */
export function detectPromptInjection(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { safe: true, risk: "none", patterns: [] };
  }

  const matched = [];
  for (const { pattern, name } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      matched.push(name);
    }
  }

  if (matched.length === 0) {
    return { safe: true, risk: "none", patterns: [] };
  }

  let risk = "low";
  if (matched.length >= 3) {
    risk = "high";
  } else if (matched.length >= 2) {
    risk = "medium";
  }

  return { safe: false, risk, patterns: matched };
}

/**
 * Detect personally identifiable information in text.
 * @param {string} text
 * @returns {{ hasPII: boolean, types: string[], positions: Array<{type: string, start: number, end: number}> }}
 */
export function detectPII(text) {
  if (typeof text !== "string" || !text) {
    return { hasPII: false, types: [], positions: [] };
  }

  const positions = [];
  const typesSet = new Set();

  for (const { type, pattern } of PII_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      typesSet.add(type);
      positions.push({ type, start: match.index, end: match.index + match[0].length });
    }
  }

  return {
    hasPII: positions.length > 0,
    types: [...typesSet],
    positions,
  };
}

/**
 * Sanitize input text: strip control characters, limit length, normalize unicode.
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxLength=100000] - Maximum character length
 * @param {boolean} [options.stripPII=false] - Replace detected PII with placeholders
 * @param {boolean} [options.blockInjection=false] - Return empty string if injection detected
 * @returns {{ text: string, modified: boolean, blocked: boolean, piiStripped: boolean }}
 */
export function sanitizeInput(text, options = {}) {
  if (typeof text !== "string") {
    return { text: "", modified: true, blocked: false, piiStripped: false };
  }

  const { maxLength = 100_000, stripPII = false, blockInjection = false } = options;
  let result = text;
  let modified = false;
  let blocked = false;
  let piiStripped = false;

  // Block injection if requested
  if (blockInjection) {
    const injection = detectPromptInjection(result);
    if (!injection.safe) {
      return { text: "", modified: true, blocked: true, piiStripped: false };
    }
  }

  // Strip control characters
  const stripped = result.replace(CONTROL_CHAR_RE, "");
  if (stripped !== result) {
    result = stripped;
    modified = true;
  }

  // Normalize unicode (NFC)
  const normalized = result.normalize("NFC");
  if (normalized !== result) {
    result = normalized;
    modified = true;
  }

  // Limit length
  if (result.length > maxLength) {
    result = result.slice(0, maxLength);
    modified = true;
  }

  // Strip PII if requested
  if (stripPII) {
    const pii = detectPII(result);
    if (pii.hasPII) {
      // Replace from end to start to preserve positions
      const sorted = [...pii.positions].sort((a, b) => b.start - a.start);
      let chars = result.split("");
      for (const pos of sorted) {
        const placeholder = `[${pos.type.toUpperCase()}_REDACTED]`;
        chars.splice(pos.start, pos.end - pos.start, placeholder);
      }
      result = chars.join("");
      modified = true;
      piiStripped = true;
    }
  }

  return { text: result, modified, blocked, piiStripped };
}

/**
 * Returns the raw injection patterns for testing/inspection.
 */
export function getInjectionPatterns() {
  return INJECTION_PATTERNS.map((p) => ({ name: p.name, source: p.pattern.source }));
}
