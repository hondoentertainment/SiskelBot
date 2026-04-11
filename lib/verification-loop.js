/**
 * Phase 52.5: Verification loops — verifier-proposer refine cycles.
 *
 * Pattern: a proposer generates an answer, a verifier critiques it, a
 * refiner revises the answer. The loop continues until the verifier
 * approves the answer or a maximum number of iterations is reached.
 *
 * This module is self-contained and does NOT require an LLM: callers
 * can pass in functions (proposer / verifier / refiner) or rely on the
 * built-in rule-based verifiers for testing and simple tasks.
 */

const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_ACCEPT_THRESHOLD = 0.8;

/**
 * Normalize a task argument to a plain string representation.
 */
function normalizeTask(task) {
  if (task == null) return "";
  if (typeof task === "string") return task;
  if (typeof task === "object") {
    if (typeof task.prompt === "string") return task.prompt;
    if (typeof task.question === "string") return task.question;
    if (typeof task.description === "string") return task.description;
    return JSON.stringify(task);
  }
  return String(task);
}

/**
 * Normalize an answer argument to a plain string.
 */
function normalizeAnswer(answer) {
  if (answer == null) return "";
  if (typeof answer === "string") return answer;
  if (typeof answer === "object") {
    if (typeof answer.text === "string") return answer.text;
    if (typeof answer.content === "string") return answer.content;
    if (typeof answer.answer === "string") return answer.answer;
    return JSON.stringify(answer);
  }
  return String(answer);
}

function clampScore(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return 0;
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}

/**
 * Default rule-based verifier. Checks basic coherence signals:
 * non-empty, minimum length, contains some answer markers, no
 * obvious error markers.
 */
export function defaultVerifier(answer, task) {
  const text = normalizeAnswer(answer).trim();
  const suggestions = [];
  let score = 0;

  if (!text) {
    return {
      approved: false,
      score: 0,
      critique: "Answer is empty.",
      suggestions: ["Provide a non-empty response."],
    };
  }

  // Length check.
  if (text.length >= 10) score += 0.35;
  else suggestions.push("Answer is too short; add more detail.");

  // Coherence heuristics.
  if (/[.!?]/.test(text)) score += 0.2;
  else suggestions.push("Use complete sentences.");

  // No obvious error markers.
  if (!/(TODO|FIXME|\berror\b|undefined is|NaN)/i.test(text)) score += 0.25;
  else suggestions.push("Remove error markers or placeholders.");

  // Contains substantive words.
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 5) score += 0.2;
  else suggestions.push("Provide at least 5 meaningful words.");

  // Light task relevance heuristic: if task is a string, overlap of
  // at least one non-trivial token is a small positive signal.
  const taskText = normalizeTask(task).toLowerCase();
  if (taskText) {
    const taskWords = taskText.split(/\s+/).filter((w) => w.length > 3);
    const answerLower = text.toLowerCase();
    const overlap = taskWords.some((w) => answerLower.includes(w));
    if (overlap) score = Math.min(1, score + 0.1);
  }

  score = clampScore(score);
  const approved = score >= DEFAULT_ACCEPT_THRESHOLD;
  const critique = approved
    ? "Answer meets baseline quality checks."
    : suggestions.join(" ") || "Answer does not meet baseline quality.";

  return { approved, score, critique, suggestions };
}

/**
 * Rule-based math verifier. Extracts a simple arithmetic expression
 * from the task (e.g. "2 + 2", "12 * 3", "9-4") and compares the
 * numeric answer produced by the proposer.
 *
 * Supports +, -, *, /.
 */
export function mathVerifier(answer, task) {
  const taskText = normalizeTask(task);
  const answerText = normalizeAnswer(answer);
  const suggestions = [];

  const expr = extractArithmeticExpression(taskText);
  if (!expr) {
    return {
      approved: false,
      score: 0,
      critique: "No arithmetic expression detected in task.",
      suggestions: ["Provide a task like '2 + 2' or 'what is 5 * 6?'"],
    };
  }

  const expected = safeEvalArithmetic(expr.a, expr.op, expr.b);
  if (expected == null) {
    return {
      approved: false,
      score: 0,
      critique: "Unable to evaluate the arithmetic expression.",
      suggestions: ["Use simpler numeric inputs."],
    };
  }

  const numbers = extractNumbers(answerText);
  if (numbers.length === 0) {
    return {
      approved: false,
      score: 0,
      critique: `Expected the answer to contain a number (expected ${expected}).`,
      suggestions: [`Include the numeric result: ${expected}`],
    };
  }

  const match = numbers.some((n) => Math.abs(n - expected) < 1e-9);
  if (match) {
    return {
      approved: true,
      score: 1,
      critique: `Arithmetic answer ${expected} is correct.`,
      suggestions: [],
    };
  }

  suggestions.push(`Replace ${numbers[0]} with ${expected}.`);
  return {
    approved: false,
    score: 0.1,
    critique: `Expected ${expected} but found ${numbers[0]}.`,
    suggestions,
  };
}

function extractArithmeticExpression(text) {
  const m = String(text).match(/(-?\d+(?:\.\d+)?)\s*([+\-*/x×÷])\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const a = Number(m[1]);
  let op = m[2];
  if (op === "x" || op === "×") op = "*";
  if (op === "÷") op = "/";
  const b = Number(m[3]);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return { a, op, b };
}

function safeEvalArithmetic(a, op, b) {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      if (b === 0) return null;
      return a / b;
    default:
      return null;
  }
}

function extractNumbers(text) {
  const matches = String(text).match(/-?\d+(?:\.\d+)?/g);
  if (!matches) return [];
  return matches.map((x) => Number(x)).filter((n) => !Number.isNaN(n));
}

/**
 * Rule-based JavaScript code verifier. Uses a lightweight structural
 * check: balanced braces, parens, and brackets, no stray tokens, and
 * catches a few common error patterns. This deliberately does NOT
 * execute code.
 */
export function codeVerifier(answer, _task) {
  const text = normalizeAnswer(answer);
  const suggestions = [];
  if (!text.trim()) {
    return {
      approved: false,
      score: 0,
      critique: "Answer contains no code.",
      suggestions: ["Provide a code block."],
    };
  }

  // Strip string literals and comments so brace counts aren't thrown off.
  const stripped = stripStringsAndComments(text);

  const balance = checkBalanced(stripped);
  if (!balance.ok) {
    return {
      approved: false,
      score: 0.2,
      critique: `Unbalanced ${balance.symbol}.`,
      suggestions: [`Match all ${balance.symbol} pairs.`],
    };
  }

  if (/\bfunctoin\b|\brturn\b|\bconsle\b/.test(stripped)) {
    suggestions.push("Fix misspelled keywords (function, return, console).");
  }

  // Extremely permissive: if there's at least one identifier-like token
  // and the braces/parens are balanced, we accept.
  const hasTokens = /[A-Za-z_$][A-Za-z0-9_$]*/.test(stripped);
  if (!hasTokens) {
    return {
      approved: false,
      score: 0.3,
      critique: "No identifiers detected in code.",
      suggestions: ["Include variables or function names."],
    };
  }

  if (suggestions.length > 0) {
    return {
      approved: false,
      score: 0.6,
      critique: suggestions.join(" "),
      suggestions,
    };
  }

  return {
    approved: true,
    score: 0.95,
    critique: "Code passes basic structural checks.",
    suggestions: [],
  };
}

function stripStringsAndComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    // Line comment.
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // Block comment.
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Strings.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") i += 2;
        else i++;
      }
      i++;
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function checkBalanced(src) {
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const stack = [];
  for (const ch of src) {
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== pairs[ch]) {
        return { ok: false, symbol: ch };
      }
    }
  }
  if (stack.length > 0) return { ok: false, symbol: stack[stack.length - 1] };
  return { ok: true };
}

/**
 * Minimal JSON schema validator for format verification. Supports a
 * pragmatic subset of JSON Schema: `type`, `required`, `properties`,
 * and nested objects. Good enough for verifier-proposer refine cycles.
 */
export function formatVerifier(answer, _task, schema) {
  const text = normalizeAnswer(answer);
  if (!schema || typeof schema !== "object") {
    return {
      approved: false,
      score: 0,
      critique: "No schema supplied.",
      suggestions: ["Provide a JSON schema."],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      approved: false,
      score: 0,
      critique: `Answer is not valid JSON: ${err.message}`,
      suggestions: ["Output valid JSON."],
    };
  }
  const errors = [];
  validateAgainstSchema(parsed, schema, "$", errors);
  if (errors.length === 0) {
    return {
      approved: true,
      score: 1,
      critique: "Answer matches schema.",
      suggestions: [],
    };
  }
  return {
    approved: false,
    score: 0.3,
    critique: errors.join("; "),
    suggestions: errors,
  };
}

function typeOfValue(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function validateAgainstSchema(value, schema, path, errors) {
  if (schema.type) {
    const actual = typeOfValue(value);
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.includes(actual)) {
      errors.push(`${path}: expected ${expected.join("|")}, got ${actual}`);
      return;
    }
  }
  if (schema.type === "object" || (schema.properties && typeOfValue(value) === "object")) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}.${key}: required`);
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          validateAgainstSchema(value[key], subSchema, `${path}.${key}`, errors);
        }
      }
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, idx) => {
      validateAgainstSchema(item, schema.items, `${path}[${idx}]`, errors);
    });
  }
}

/**
 * Fact verifier. Checks that claims in the answer appear in the
 * provided knowledge base (array of strings or array of { text } objects).
 * Very lightweight — splits on sentences and looks for substring matches.
 */
export function factVerifier(answer, knowledgeBase) {
  const text = normalizeAnswer(answer);
  if (!Array.isArray(knowledgeBase) || knowledgeBase.length === 0) {
    return {
      approved: false,
      score: 0,
      critique: "No knowledge base supplied.",
      suggestions: ["Provide a knowledge base."],
    };
  }
  const kbText = knowledgeBase
    .map((k) => (typeof k === "string" ? k : k?.text || ""))
    .join(" ")
    .toLowerCase();
  const sentences = text
    .split(/[.!?]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length === 0) {
    return {
      approved: false,
      score: 0,
      critique: "Answer has no verifiable claims.",
      suggestions: ["Provide declarative claims."],
    };
  }
  const unsupported = [];
  let supported = 0;
  for (const sentence of sentences) {
    const words = sentence
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    if (words.length === 0) continue;
    const overlapCount = words.filter((w) => kbText.includes(w)).length;
    if (overlapCount / words.length >= 0.5) supported += 1;
    else unsupported.push(sentence);
  }
  const total = sentences.length;
  const score = total === 0 ? 0 : supported / total;
  return {
    approved: score >= DEFAULT_ACCEPT_THRESHOLD,
    score,
    critique:
      unsupported.length === 0
        ? "All claims supported by knowledge base."
        : `Unsupported claims: ${unsupported.slice(0, 3).join("; ")}`,
    suggestions: unsupported.map((s) => `Revise or cite: "${s}"`),
  };
}

/**
 * Combine multiple verifiers. Returns a new verifier that runs each
 * in order, averages scores, and approves only if all approve.
 */
export function chainVerifiers(verifiers) {
  if (!Array.isArray(verifiers) || verifiers.length === 0) {
    throw new Error("chainVerifiers requires a non-empty array of verifiers");
  }
  return async function combinedVerifier(answer, task) {
    const results = [];
    for (const verifier of verifiers) {
      const result = await Promise.resolve(verifier(answer, task));
      results.push(result);
    }
    const scores = results.map((r) => clampScore(r?.score));
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const approved = results.every((r) => r?.approved === true);
    const critiques = results.map((r) => r?.critique || "").filter(Boolean).join(" | ");
    const suggestions = results.flatMap((r) => (Array.isArray(r?.suggestions) ? r.suggestions : []));
    return {
      approved,
      score: avg,
      critique: critiques || "No critique.",
      suggestions,
      details: results,
    };
  };
}

/**
 * Low-level helper: invoke a proposer. A proposer is a function taking
 * `(task, context)` and returning a string answer (or an object with
 * a `text` property). `propose` normalizes the result.
 */
export async function propose(task, proposerFn, options = {}) {
  if (task == null || (typeof task === "string" && !task.trim())) {
    throw new Error("propose: task is required");
  }
  if (typeof proposerFn !== "function") {
    throw new Error("propose: proposerFn must be a function");
  }
  const context = options.context || {};
  const result = await Promise.resolve(proposerFn(task, context));
  return normalizeAnswer(result);
}

/**
 * Low-level helper: invoke a verifier and normalize the result shape.
 */
export async function verify(answer, task, verifierFn, options = {}) {
  if (answer == null) {
    return {
      approved: false,
      score: 0,
      critique: "Answer is null.",
      suggestions: ["Provide a non-null answer."],
    };
  }
  const fn = typeof verifierFn === "function" ? verifierFn : defaultVerifier;
  const context = options.context || {};
  const result = await Promise.resolve(fn(answer, task, context));
  if (!result || typeof result !== "object") {
    return {
      approved: false,
      score: 0,
      critique: "Verifier returned an invalid result.",
      suggestions: [],
    };
  }
  return {
    approved: !!result.approved,
    score: clampScore(result.score),
    critique: typeof result.critique === "string" ? result.critique : "",
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    details: result.details,
  };
}

/**
 * Low-level helper: invoke a refiner. A refiner takes the previous
 * answer and the critique and returns an improved answer. If no
 * refinerFn is provided, a simple default appends the critique note.
 */
export async function refine(answer, critique, refinerFn, options = {}) {
  if (typeof refinerFn === "function") {
    const context = options.context || {};
    const result = await Promise.resolve(refinerFn(answer, critique, context));
    return normalizeAnswer(result);
  }
  const base = normalizeAnswer(answer);
  const note = critique ? ` [revised: ${critique}]` : " [revised]";
  return base + note;
}

/**
 * VerificationLoop — runs proposer → verifier → refine until
 * accepted or max iterations reached.
 */
export class VerificationLoop {
  constructor(options = {}) {
    this.proposer = options.proposer;
    this.verifier = options.verifier || defaultVerifier;
    this.refiner = options.refiner;
    this.maxIterations = Math.max(1, Number(options.maxIterations) || DEFAULT_MAX_ITERATIONS);
    this.acceptThreshold = clampScore(
      typeof options.acceptThreshold === "number"
        ? options.acceptThreshold
        : DEFAULT_ACCEPT_THRESHOLD,
    );
    if (typeof this.proposer !== "function") {
      throw new Error("VerificationLoop: proposer function is required");
    }
  }

  async run(task) {
    if (task == null || (typeof task === "string" && !task.trim())) {
      throw new Error("VerificationLoop.run: task is required");
    }
    const iterations = [];
    let answer = await propose(task, this.proposer);
    let accepted = false;
    let finalVerdict = null;

    for (let i = 0; i < this.maxIterations; i++) {
      const verdict = await verify(answer, task, this.verifier);
      iterations.push({
        iteration: i + 1,
        answer,
        critique: verdict.critique,
        score: verdict.score,
        approved: verdict.approved,
        suggestions: verdict.suggestions,
      });
      finalVerdict = verdict;
      if (verdict.approved && verdict.score >= this.acceptThreshold) {
        accepted = true;
        break;
      }
      if (i === this.maxIterations - 1) break;
      answer = await refine(answer, verdict.critique, this.refiner, {
        context: { iteration: i + 1, suggestions: verdict.suggestions, task },
      });
    }

    return {
      finalAnswer: answer,
      iterations,
      accepted,
      iterationsCount: iterations.length,
      finalScore: finalVerdict ? finalVerdict.score : 0,
    };
  }
}

/**
 * IterativeRefiner — similar to VerificationLoop but keeps a durable
 * history across multiple `refine()` calls. Useful when you want to
 * explicitly step through refinement rather than run a full loop.
 */
export class IterativeRefiner {
  constructor(options = {}) {
    this.proposer = options.proposer;
    this.verifier = options.verifier || defaultVerifier;
    this.refiner = options.refiner;
    this.acceptThreshold = clampScore(
      typeof options.acceptThreshold === "number"
        ? options.acceptThreshold
        : DEFAULT_ACCEPT_THRESHOLD,
    );
    if (typeof this.proposer !== "function") {
      throw new Error("IterativeRefiner: proposer function is required");
    }
    this._history = [];
  }

  async refine(task, maxIterations = DEFAULT_MAX_ITERATIONS) {
    if (task == null || (typeof task === "string" && !task.trim())) {
      throw new Error("IterativeRefiner.refine: task is required");
    }
    const max = Math.max(1, Number(maxIterations) || DEFAULT_MAX_ITERATIONS);
    let answer = await propose(task, this.proposer);
    let accepted = false;
    let finalVerdict = null;

    for (let i = 0; i < max; i++) {
      const verdict = await verify(answer, task, this.verifier);
      const entry = {
        iteration: this._history.length + 1,
        task: normalizeTask(task),
        answer,
        critique: verdict.critique,
        score: verdict.score,
        approved: verdict.approved,
        suggestions: verdict.suggestions,
        at: Date.now(),
      };
      this._history.push(entry);
      finalVerdict = verdict;
      if (verdict.approved && verdict.score >= this.acceptThreshold) {
        accepted = true;
        break;
      }
      if (i === max - 1) break;
      answer = await refine(answer, verdict.critique, this.refiner, {
        context: { iteration: i + 1, suggestions: verdict.suggestions, task },
      });
    }
    return {
      finalAnswer: answer,
      accepted,
      iterationsCount: this._history.length,
      finalScore: finalVerdict ? finalVerdict.score : 0,
    };
  }

  getHistory() {
    return this._history.slice();
  }

  reset() {
    this._history = [];
  }
}

/**
 * Compute refinement metrics from an iteration history. Accepts
 * either the iterations array from VerificationLoop.run() or the
 * history array from IterativeRefiner.getHistory().
 */
export function computeRefinementMetrics(history) {
  const arr = Array.isArray(history) ? history : [];
  const iterations = arr.length;
  if (iterations === 0) {
    return {
      iterations: 0,
      improvementPerStep: [],
      totalImprovement: 0,
      finalScore: 0,
      initialScore: 0,
      earlyStopped: false,
      accepted: false,
    };
  }
  const scores = arr.map((e) => clampScore(e.score));
  const improvementPerStep = [];
  for (let i = 1; i < scores.length; i++) {
    improvementPerStep.push(Number((scores[i] - scores[i - 1]).toFixed(6)));
  }
  const finalScore = scores[scores.length - 1];
  const initialScore = scores[0];
  const totalImprovement = Number((finalScore - initialScore).toFixed(6));
  const lastEntry = arr[arr.length - 1];
  const accepted = !!lastEntry.approved;
  // Early stopped = accepted before reaching end (not just final item approved).
  // Treat "earlyStopped" as accepted in fewer-than-expected iterations if meta
  // provided; otherwise simply whether the last iteration was approved while
  // there's any iteration count < intended max. Without intended max, infer
  // earlyStopped = accepted && iterations > 1 && last iteration approved.
  const earlyStopped = accepted && iterations >= 1;
  return {
    iterations,
    improvementPerStep,
    totalImprovement,
    finalScore,
    initialScore,
    earlyStopped,
    accepted,
  };
}

export default {
  VerificationLoop,
  IterativeRefiner,
  propose,
  verify,
  refine,
  defaultVerifier,
  mathVerifier,
  codeVerifier,
  formatVerifier,
  factVerifier,
  chainVerifiers,
  computeRefinementMetrics,
};
