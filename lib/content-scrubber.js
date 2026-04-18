/**
 * Content scrubber for tool outputs.
 *
 * Defense-in-depth: before tool results are fed back into the LLM or shown
 * to users, strip secrets + PII and flag prompt-injection attempts. Complements
 * log-sanitizer.js (which handles request/log bodies); this module is for
 * arbitrary tool output strings (fetched URLs, KB docs, git diffs, etc.).
 *
 * Design notes:
 *   - Regexes compiled once at module load.
 *   - Replacement strings are `[REDACTED_<UPPER_CATEGORY>]` with no chars that
 *     could re-match other rules (prevents cascading / infinite loops).
 *   - Prompt-injection is flagged but NOT redacted — the phrase existing is
 *     itself the signal; removing it would hide the evidence. We prepend
 *     a warning marker to the output.
 *   - `aws_secret` is gated to avoid false positives on arbitrary base64-ish
 *     40-char strings (git SHAs padded, etc.).
 */

const TRUNCATE_LIMIT = 100000;

/** @typedef {"secret" | "pii" | "prompt_injection" | "custom"} ScrubCategory */

/**
 * @typedef {object} ScrubFinding
 * @property {ScrubCategory} category
 * @property {string} pattern
 * @property {number} startIdx
 * @property {number} endIdx
 * @property {string} [replacement]
 */

/**
 * @typedef {object} ScrubResult
 * @property {string} scrubbed
 * @property {boolean} modified
 * @property {ScrubFinding[]} findings
 * @property {number} originalLength
 * @property {number} scrubbedLength
 */

/**
 * @typedef {object} Rule
 * @property {string} name
 * @property {ScrubCategory} category
 * @property {string} description
 * @property {RegExp} pattern
 * @property {string} [replacement]
 * @property {boolean} [gated]
 */

const redact = (cat) => `[REDACTED_${cat.toUpperCase()}]`;

/** @type {Rule[]} */
const SECRET_RULES = [
  {
    name: "aws_access_key_id",
    category: "secret",
    description: "AWS access key ID (AKIA-prefixed 20-char)",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: redact("aws_access_key_id"),
  },
  {
    name: "github_pat_classic",
    category: "secret",
    description: "GitHub classic personal access token",
    pattern: /\bghp_[A-Za-z0-9]{36}\b/g,
    replacement: redact("github_pat"),
  },
  {
    name: "github_pat_fine_grained",
    category: "secret",
    description: "GitHub fine-grained personal access token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
    replacement: redact("github_pat"),
  },
  {
    name: "openai_key_project",
    category: "secret",
    description: "OpenAI project-scoped API key",
    pattern: /\bsk-proj-[A-Za-z0-9\-_]{32,}\b/g,
    replacement: redact("openai_key"),
  },
  {
    name: "anthropic_key",
    category: "secret",
    description: "Anthropic API key",
    pattern: /\bsk-ant-[A-Za-z0-9\-_]{32,}\b/g,
    replacement: redact("anthropic_key"),
  },
  {
    name: "openai_key",
    category: "secret",
    description: "OpenAI API key (generic sk-...)",
    pattern: /\bsk-[A-Za-z0-9]{32,}\b/g,
    replacement: redact("openai_key"),
  },
  {
    name: "slack_token",
    category: "secret",
    description: "Slack bot/app/user token (xoxb, xoxp, etc.)",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,72}\b/g,
    replacement: redact("slack_token"),
  },
  {
    name: "google_api_key",
    category: "secret",
    description: "Google API key (AIza-prefixed)",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: redact("google_api_key"),
  },
  {
    name: "generic_bearer",
    category: "secret",
    description: "HTTP Bearer authorization token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
    replacement: redact("bearer"),
  },
  {
    name: "jwt",
    category: "secret",
    description: "JSON Web Token (eyJ... three-part base64url)",
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: redact("jwt"),
  },
  {
    name: "private_key_pem",
    category: "secret",
    description: "PEM-encoded private key block",
    // Using [\s\S] for multiline; \1 backreference keeps the END matching the BEGIN label
    pattern:
      /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----[\s\S]+?-----END \1PRIVATE KEY-----/g,
    replacement: redact("private_key"),
  },
  {
    // GATED RULE. Base64-ish 40-char strings have a high false-positive rate
    // (git SHAs doubled, other hashes). We only emit findings when an
    // aws_access_key_id was also detected in the same input, OR when the
    // candidate appears near AWS-secret-related keywords.
    name: "aws_secret",
    category: "secret",
    description: "AWS secret access key (40-char base64-ish, gated by context)",
    pattern: /\b[A-Za-z0-9/+=]{40}\b/g,
    replacement: redact("aws_secret"),
    gated: true,
  },
];

/** @type {Rule[]} */
const PII_RULES = [
  {
    name: "email",
    category: "pii",
    description: "Email address",
    // Word-boundary-anchored; avoids trailing-dot false matches
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    replacement: redact("email"),
  },
  {
    name: "us_ssn",
    category: "pii",
    description: "US Social Security Number (XXX-XX-XXXX)",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: redact("ssn"),
  },
  {
    name: "us_phone",
    category: "pii",
    description: "US phone number",
    pattern: /\b\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}\b/g,
    replacement: redact("phone"),
  },
  {
    name: "credit_card",
    category: "pii",
    description: "16-digit credit card number with separators",
    pattern: /\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}\b/g,
    replacement: redact("credit_card"),
  },
];

/** @type {Rule[]} */
const INJECTION_RULES = [
  {
    name: "ignore_previous",
    category: "prompt_injection",
    description: "\"ignore previous instructions\" variants",
    pattern: /ignore\s+(all\s+)?previous\s+(instructions|prompts|messages)/gi,
  },
  {
    name: "disregard_prior",
    category: "prompt_injection",
    description: "\"disregard all prior\" variants",
    pattern: /disregard\s+(all\s+)?prior/gi,
  },
  {
    name: "system_you_are_now",
    category: "prompt_injection",
    description: "System-role override attempt",
    pattern: /system\s*:\s*you\s+are\s+now/gi,
  },
  {
    name: "chatml_tokens",
    category: "prompt_injection",
    description: "ChatML special tokens (im_start/im_end)",
    pattern: /<\|im_(start|end)\|>/gi,
  },
  {
    name: "override_instructions",
    category: "prompt_injection",
    description: "\"override your instructions\" variants",
    pattern: /override\s+(your\s+)?(instructions|prompt|system)/gi,
  },
  {
    name: "new_instructions",
    category: "prompt_injection",
    description: "\"new instructions:\" marker",
    pattern: /new\s+instructions\s*:/gi,
  },
  {
    name: "chatml_prefix_line",
    category: "prompt_injection",
    description: "ChatML-style role prefix at line start (system/assistant/tool:)",
    pattern: /^(system|assistant|tool)\s*:/gim,
  },
];

/** All rules combined, preserving order. */
const RULES = [...SECRET_RULES, ...PII_RULES, ...INJECTION_RULES];

// Sanity check: no replacement string should itself match any rule.
// (Done at module load to fail fast rather than at runtime.)
for (const r of RULES) {
  if (!r.replacement) continue;
  for (const other of RULES) {
    other.pattern.lastIndex = 0;
    if (other.pattern.test(r.replacement)) {
      throw new Error(
        `content-scrubber: replacement ${r.replacement} matches rule ${other.name}`,
      );
    }
    other.pattern.lastIndex = 0;
  }
}

const INJECTION_WARN_PREFIX = "\u26A0[possible injection detected]\u26A0\n";

/**
 * @param {string} text
 * @param {Rule} rule
 * @returns {Array<{start: number, end: number, match: string}>}
 */
function findAll(text, rule) {
  const out = [];
  rule.pattern.lastIndex = 0;
  let m;
  while ((m = rule.pattern.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, match: m[0] });
    // Guard against zero-width matches (shouldn't happen with our rules, but be safe)
    if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
  }
  rule.pattern.lastIndex = 0;
  return out;
}

/**
 * Check whether an AWS-secret candidate has a keyword hint nearby.
 * Looks at a 40-char window before the match for "secret", "key",
 * "AWS_SECRET", etc.
 */
function hasAwsSecretHint(text, start) {
  const windowStart = Math.max(0, start - 60);
  const slice = text.slice(windowStart, start).toLowerCase();
  return (
    slice.includes("secret") ||
    slice.includes("aws_secret") ||
    slice.includes("aws-secret") ||
    /\bkey\b\s*[:=]/i.test(slice)
  );
}

/**
 * Detect whether any prompt-injection pattern is present.
 * @param {string} text
 * @returns {boolean}
 */
export function detectPromptInjection(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  for (const rule of INJECTION_RULES) {
    rule.pattern.lastIndex = 0;
    const hit = rule.pattern.test(text);
    rule.pattern.lastIndex = 0;
    if (hit) return true;
  }
  return false;
}

/**
 * Apply a set of replacement-producing rules to text, leftmost-first, and
 * return the transformed string plus findings. Rules flagged `gated`
 * are skipped here; handled separately.
 *
 * @param {string} text
 * @param {Rule[]} rules
 * @param {{allowAwsSecret: boolean, remaining: number}} ctx
 * @returns {{text: string, findings: ScrubFinding[], used: number}}
 */
function applyReplaceRules(text, rules, ctx) {
  /** @type {Array<{start: number, end: number, rule: Rule, match: string}>} */
  const hits = [];
  for (const rule of rules) {
    const matches = findAll(text, rule);
    for (const m of matches) {
      // Gated rule: aws_secret only fires when (a) an access key id was
      // already seen in this input, or (b) this specific candidate has a
      // keyword hint ("secret", "AWS_SECRET", key=...) adjacent.
      if (rule.gated && rule.name === "aws_secret") {
        if (!ctx.allowAwsSecret && !hasAwsSecretHint(text, m.start)) continue;
      }
      hits.push({ start: m.start, end: m.end, rule, match: m.match });
    }
  }

  // Sort by start index; resolve overlaps by preferring the earliest start,
  // then the longest match (so a JWT beats an openai_key substring).
  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));

  /** @type {ScrubFinding[]} */
  const findings = [];
  let out = "";
  let cursor = 0;
  let used = 0;
  let lastEnd = 0;

  for (const h of hits) {
    if (h.start < lastEnd) continue; // overlap with an earlier-accepted hit
    if (used >= ctx.remaining) break;
    out += text.slice(cursor, h.start);
    const rep = h.rule.replacement ?? "";
    out += rep;
    findings.push({
      category: h.rule.category,
      pattern: h.rule.name,
      startIdx: h.start,
      endIdx: h.end,
      replacement: rep,
    });
    cursor = h.end;
    lastEnd = h.end;
    used++;
  }
  out += text.slice(cursor);
  return { text: out, findings, used };
}

/**
 * Scan text for injection rules without modifying it. Produces findings only.
 *
 * @param {string} text
 * @param {{remaining: number}} ctx
 * @returns {{findings: ScrubFinding[], used: number}}
 */
function scanInjectionRules(text, ctx) {
  /** @type {ScrubFinding[]} */
  const findings = [];
  let used = 0;
  for (const rule of INJECTION_RULES) {
    const matches = findAll(text, rule);
    for (const m of matches) {
      if (used >= ctx.remaining) break;
      findings.push({
        category: "prompt_injection",
        pattern: rule.name,
        startIdx: m.start,
        endIdx: m.end,
      });
      used++;
    }
    if (used >= ctx.remaining) break;
  }
  return { findings, used };
}

/**
 * Scrub a string or stringifiable value for sensitive patterns + prompt
 * injection. Never throws.
 *
 * @param {string | object | unknown} input
 * @param {object} [opts]
 * @param {boolean} [opts.secrets=true]
 * @param {boolean} [opts.pii=true]
 * @param {boolean} [opts.promptInjection=true]
 * @param {Array<{name: string, pattern: RegExp, category?: string, replacement?: string}>} [opts.customRules]
 * @param {number} [opts.maxFindings=50]
 * @returns {ScrubResult}
 */
export function scrubContent(input, opts = {}) {
  const {
    secrets = true,
    pii = true,
    promptInjection = true,
    customRules = [],
    maxFindings = 50,
  } = opts;

  // Coerce to string
  let text;
  let wasObject = false;
  if (typeof input === "string") {
    text = input;
  } else if (input == null) {
    text = String(input);
  } else {
    wasObject = true;
    try {
      text = JSON.stringify(input);
    } catch {
      try {
        text = String(input);
      } catch {
        text = "";
      }
    }
    if (typeof text !== "string") text = "";
  }

  const originalLength = text.length;

  /** @type {ScrubFinding[]} */
  const findings = [];
  let remaining = Math.max(0, maxFindings);

  // Length guard: truncate and emit a warning finding.
  if (text.length > TRUNCATE_LIMIT) {
    findings.push({
      category: "custom",
      pattern: "input_truncated",
      startIdx: TRUNCATE_LIMIT,
      endIdx: text.length,
      replacement: "",
    });
    text = text.slice(0, TRUNCATE_LIMIT);
    remaining = Math.max(0, remaining - 1);
  }

  // First pass: secrets (includes gated aws_secret detection).
  if (secrets && remaining > 0) {
    const accessKeyRule = SECRET_RULES.find(
      (r) => r.name === "aws_access_key_id",
    );
    let allowAwsSecret = false;
    if (accessKeyRule) {
      accessKeyRule.pattern.lastIndex = 0;
      allowAwsSecret = accessKeyRule.pattern.test(text);
      accessKeyRule.pattern.lastIndex = 0;
    }
    const ctx = { allowAwsSecret, remaining };
    const res = applyReplaceRules(text, SECRET_RULES, ctx);
    text = res.text;
    findings.push(...res.findings);
    remaining -= res.used;
  }

  // Second pass: PII on the (potentially redacted) text.
  if (pii && remaining > 0) {
    const ctx = { allowAwsSecret: false, remaining };
    const res = applyReplaceRules(text, PII_RULES, ctx);
    text = res.text;
    findings.push(...res.findings);
    remaining -= res.used;
  }

  // Third pass: custom rules (treated like replacement rules if replacement provided,
  // otherwise flag-only).
  if (customRules && customRules.length && remaining > 0) {
    /** @type {Rule[]} */
    const normalized = customRules
      .filter((r) => r && r.name && r.pattern instanceof RegExp)
      .map((r) => ({
        name: r.name,
        category: /** @type {ScrubCategory} */ (r.category || "custom"),
        description: `custom: ${r.name}`,
        // Ensure global flag so findAll terminates after all hits
        pattern: r.pattern.flags.includes("g")
          ? r.pattern
          : new RegExp(r.pattern.source, r.pattern.flags + "g"),
        replacement:
          typeof r.replacement === "string"
            ? r.replacement
            : redact(r.category || "custom"),
      }));
    const ctx = { allowAwsSecret: false, remaining };
    const res = applyReplaceRules(text, normalized, ctx);
    text = res.text;
    findings.push(...res.findings);
    remaining -= res.used;
  }

  // Fourth pass: prompt injection. Flag only; do not replace. If hits found,
  // prepend warning marker so downstream LLM and users see the flag.
  if (promptInjection && remaining > 0) {
    const ctx = { remaining };
    const res = scanInjectionRules(text, ctx);
    if (res.findings.length > 0) {
      findings.push(...res.findings);
      text = INJECTION_WARN_PREFIX + text;
    }
  }

  const scrubbed = text;
  return {
    scrubbed,
    modified: findings.length > 0 || scrubbed !== (wasObject ? safeStringify(input) : String(input ?? "")),
    findings,
    originalLength,
    scrubbedLength: scrubbed.length,
  };
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    try {
      return String(v);
    } catch {
      return "";
    }
  }
}

/**
 * Scrub the `content` field of a tool-result object. Returns a new object
 * (never mutates input). Preserves outer shape such as `ok`, `tool_call_id`,
 * `name`, etc.
 *
 * @param {object} result
 * @param {object} [opts]
 * @returns {{scrubbed: object, findings: ScrubFinding[]}}
 */
export function scrubToolResult(result, opts = {}) {
  if (!result || typeof result !== "object") {
    return { scrubbed: result, findings: [] };
  }
  const out = { ...result };
  /** @type {ScrubFinding[]} */
  const findings = [];

  if ("content" in out) {
    const c = out.content;
    if (typeof c === "string") {
      const res = scrubContent(c, opts);
      out.content = res.scrubbed;
      findings.push(...res.findings);
    } else if (c != null && typeof c === "object") {
      const res = scrubContent(c, opts);
      findings.push(...res.findings);
      // Try to keep the object shape: parse the scrubbed JSON back.
      try {
        out.content = JSON.parse(res.scrubbed);
      } catch {
        out.content = res.scrubbed;
      }
    }
  }

  return { scrubbed: out, findings };
}

/**
 * Whether content scrubbing is enabled. Defaults to ON (defense-in-depth);
 * disable by setting `AGENT_CONTENT_SCRUB=0`.
 * @returns {boolean}
 */
export function contentScrubEnabled() {
  return process.env.AGENT_CONTENT_SCRUB !== "0";
}

/**
 * List scrubbing rules for admin inspection. Does NOT expose regex sources,
 * just metadata so operators can audit which rules are active.
 *
 * @returns {Array<{name: string, category: string, description: string}>}
 */
export function listRules() {
  return RULES.map((r) => ({
    name: r.name,
    category: r.category,
    description: r.description,
  }));
}
