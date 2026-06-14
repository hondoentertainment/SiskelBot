/**
 * Phase 26: AI Quality & Safety — Response safety.
 * Checks LLM output for PII leakage, harmful content, code injection, and grounding.
 */

import { detectPII } from "./prompt-guard.js";

const HARMFUL_PATTERNS = [
  { pattern: /how to (make|build|create) (a |an )?(bomb|explosive|weapon)/i, type: "harmful_instructions", severity: "high" },
  { pattern: /instructions (for|to) (hack|exploit|break into)/i, type: "harmful_instructions", severity: "high" },
  { pattern: /<script[\s>]/i, type: "code_injection", severity: "medium" },
  { pattern: /javascript:\s*\w/i, type: "code_injection", severity: "medium" },
  { pattern: /on(error|load|click)\s*=/i, type: "code_injection", severity: "medium" },
  { pattern: /\beval\s*\(/i, type: "code_injection", severity: "low" },
  { pattern: /DROP\s+TABLE/i, type: "sql_injection", severity: "high" },
  { pattern: /;\s*DELETE\s+FROM/i, type: "sql_injection", severity: "high" },
  { pattern: /UNION\s+SELECT\s+/i, type: "sql_injection", severity: "medium" },
  { pattern: /__(proto|constructor)__/i, type: "prototype_pollution", severity: "medium" },
];

/**
 * Check output text for safety issues: PII leakage, harmful content, code injection.
 * @param {string} text
 * @returns {{ safe: boolean, issues: Array<{type: string, severity: string, detail: string}> }}
 */
export function checkOutputSafety(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { safe: true, issues: [] };
  }

  const issues = [];

  // Check for PII leakage
  const pii = detectPII(text);
  if (pii.hasPII) {
    for (const type of pii.types) {
      issues.push({
        type: "pii_leakage",
        severity: type === "ssn" || type === "credit_card" ? "high" : "medium",
        detail: `Detected ${type} in output`,
      });
    }
  }

  // Check for harmful content patterns
  for (const { pattern, type, severity } of HARMFUL_PATTERNS) {
    if (pattern.test(text)) {
      issues.push({ type, severity, detail: `Matched harmful pattern: ${type}` });
    }
  }

  return {
    safe: issues.length === 0,
    issues,
  };
}

/**
 * Check whether a response is grounded in the provided knowledge sources.
 * Uses simple sentence-level overlap heuristic.
 * @param {string} response - The LLM response text
 * @param {string[]} sources - Array of knowledge base source texts
 * @returns {{ grounded: boolean, score: number, unsupportedClaims: string[] }}
 */
export function checkGrounding(response, sources) {
  if (typeof response !== "string" || !response.trim()) {
    return { grounded: true, score: 1, unsupportedClaims: [] };
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    return { grounded: false, score: 0, unsupportedClaims: [response.trim()] };
  }

  // Combine sources into a single lowered corpus
  const corpus = sources
    .filter((s) => typeof s === "string")
    .map((s) => s.toLowerCase())
    .join(" ");

  // Split response into sentences
  const sentences = response
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10); // ignore very short fragments

  if (sentences.length === 0) {
    return { grounded: true, score: 1, unsupportedClaims: [] };
  }

  const unsupportedClaims = [];
  let supportedCount = 0;

  for (const sentence of sentences) {
    const words = sentence
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3); // skip short/stop words

    if (words.length === 0) {
      supportedCount++;
      continue;
    }

    // A sentence is "supported" if a threshold of its meaningful words appear in corpus
    const matchedWords = words.filter((w) => corpus.includes(w));
    const overlapRatio = matchedWords.length / words.length;

    if (overlapRatio >= 0.5) {
      supportedCount++;
    } else {
      unsupportedClaims.push(sentence);
    }
  }

  const score = Math.round((supportedCount / sentences.length) * 100) / 100;

  return {
    grounded: score >= 0.7,
    score,
    unsupportedClaims,
  };
}
