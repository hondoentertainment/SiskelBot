/**
 * GBrain strategy matching heuristics.
 *
 * Lightweight, deterministic classifiers that inspect a task description (and,
 * when available, a precomputed analysis) to decide which execution strategy
 * best fits. These are intentionally cheap and text-based so the router can
 * invoke them without hitting an LLM on every request.
 *
 * Each matcher returns either a boolean or a score in [0, 1] depending on the
 * question being asked. Heuristics are conservative: uncertain inputs fall
 * through to the default strategy rather than forcing an expensive pathway.
 *
 * @module gbrain-heuristics
 */

/**
 * Pull a plain text representation out of a task input. Callers may pass a
 * string, an analysis object with `{ task, text, prompt, description }`, or
 * a richer object containing a nested task. We coerce everything to a single
 * lowercase string for pattern matching.
 *
 * @param {unknown} task
 * @returns {string}
 */
export function taskText(task) {
  if (task == null) return "";
  if (typeof task === "string") return task.toLowerCase();
  if (typeof task !== "object") return String(task).toLowerCase();
  const candidates = [
    /** @type {any} */ (task).text,
    /** @type {any} */ (task).prompt,
    /** @type {any} */ (task).description,
    /** @type {any} */ (task).task,
    /** @type {any} */ (task).goal,
    /** @type {any} */ (task).message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.toLowerCase();
    }
  }
  try {
    return JSON.stringify(task).toLowerCase();
  } catch {
    return "";
  }
}

const SIMPLE_QUESTION_PATTERNS = [
  /^\s*(what|who|when|where|which|why|how)\b/,
  /^\s*(is|are|was|were|do|does|did|can|could|will|would|should)\b/,
  /^\s*define\b/,
  /^\s*explain\s+(briefly|shortly)/,
  /\?\s*$/,
];

const CONVERSATIONAL_PATTERNS = [
  /\b(hi|hello|hey|thanks|thank you|good morning|good night)\b/,
  /\b(how are you|nice to meet)\b/,
];

/**
 * Detects simple factual questions / conversational turns that can be answered
 * directly by a single model call without any tools.
 *
 * @param {unknown} task
 * @returns {boolean}
 */
export function matchesSimpleQuestion(task) {
  const text = taskText(task).trim();
  if (!text) return false;
  // Must be short -- long prompts are rarely "simple".
  if (text.length > 280) return false;
  if (text.split(/\s+/).length > 40) return false;

  for (const pattern of SIMPLE_QUESTION_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  for (const pattern of CONVERSATIONAL_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// Tool-intent keywords. Short single-word keywords use word-boundary regex
// matching to avoid substring false positives (e.g. "api" inside "capital").
// Multi-word phrases are matched as substrings.
const TOOL_KEYWORD_REGEXES = [
  /\bfetch\b/,
  /\bdownload\b/,
  /\bhttp\b/,
  /\burl\b/,
  /\bapi\b/,
  /\bbrowse\b/,
  /\bscrape\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bscreenshot\b/,
];
const TOOL_KEYWORD_PHRASES = [
  "search the web",
  "web search",
  "query database",
  "run sql",
  "execute code",
  "run script",
  "run command",
  "open file",
  "read file",
  "write file",
  "list files",
  "call tool",
  "invoke tool",
  "call the api",
];

/**
 * Detects tasks that almost certainly need to invoke an external tool (file
 * I/O, HTTP, web search, code execution, DB queries, browser automation...).
 *
 * @param {unknown} task
 * @returns {boolean}
 */
export function matchesToolRequired(task) {
  const text = taskText(task);
  if (!text) return false;
  for (const regex of TOOL_KEYWORD_REGEXES) {
    if (regex.test(text)) return true;
  }
  for (const phrase of TOOL_KEYWORD_PHRASES) {
    if (text.includes(phrase)) return true;
  }
  // URL-looking tokens strongly imply tool usage.
  if (/https?:\/\/\S+/.test(text)) return true;
  return false;
}

// High-stakes keywords. Short tokens use word-boundary regex to avoid
// substring false positives.
const HIGH_STAKES_REGEXES = [
  /\bproduction\b/,
  /\bprod\b/,
  /\blegal\b/,
  /\bmedical\b/,
  /\bfinancial\b/,
  /\bcompliance\b/,
  /\bregulation\b/,
  /\bregulatory\b/,
  /\bsecurity\b/,
  /\bcritical\b/,
  /\burgent\b/,
  /\bverify\b/,
  /\bcontract\b/,
  /\bpolicy\b/,
  /\baudit\b/,
];
const HIGH_STAKES_PHRASES = [
  "security incident",
  "fact check",
  "fact-check",
  "double check",
  "double-check",
  "high stakes",
  "high-stakes",
];

/**
 * Detects high-stakes tasks where the cost of an error is high enough to
 * justify consensus voting across multiple agents.
 *
 * @param {unknown} task
 * @returns {boolean}
 */
export function matchesHighStakes(task) {
  const text = taskText(task);
  if (!text) return false;
  for (const regex of HIGH_STAKES_REGEXES) {
    if (regex.test(text)) return true;
  }
  for (const phrase of HIGH_STAKES_PHRASES) {
    if (text.includes(phrase)) return true;
  }
  return false;
}

const LONG_RUNNING_REGEXES = [
  /\bovernight\b/,
  /\bmonitor\b/,
  /\bmonitoring\b/,
  /\bcontinuously\b/,
  /\bcontinuous\b/,
  /\bautonomous\b/,
  /\bautonomously\b/,
  /\bmission\b/,
  /\bongoing\b/,
  /\bdaily\b/,
  /\bweekly\b/,
];
const LONG_RUNNING_PHRASES = [
  "over night",
  "long running",
  "long-running",
  "research project",
  "multi day",
  "multi-day",
  "every hour",
  "every day",
  "for several hours",
  "for hours",
];

/**
 * Detects tasks that should run as a long-running mission (hours/days) rather
 * than a single request/response turn.
 *
 * @param {unknown} task
 * @returns {boolean}
 */
export function matchesLongRunning(task) {
  const text = taskText(task);
  if (!text) return false;
  for (const regex of LONG_RUNNING_REGEXES) {
    if (regex.test(text)) return true;
  }
  for (const phrase of LONG_RUNNING_PHRASES) {
    if (text.includes(phrase)) return true;
  }
  // Explicit numeric duration hints: "for 2 hours", "48h", "3 days".
  if (/\b\d+\s*(h|hr|hrs|hour|hours|d|day|days|week|weeks)\b/.test(text)) {
    return true;
  }
  return false;
}

const COMPLEXITY_KEYWORDS = {
  trivial: ["hello", "hi", "hey", "thanks", "thank you", "greet", "small talk"],
  simple: ["define", "what is", "who is", "how do i", "explain briefly"],
  moderate: [
    "compare",
    "summarize",
    "outline",
    "draft",
    "plan",
    "refactor",
    "analyze",
  ],
  complex: [
    "design",
    "architecture",
    "end to end",
    "end-to-end",
    "multi step",
    "multi-step",
    "build a",
    "build an",
    "implement a",
    "investigate",
    "research",
    "evaluate",
  ],
  mission: [
    "autonomously",
    "for several days",
    "multi-day",
    "ongoing",
    "long running",
    "long-running",
    "mission",
    "over the next week",
    "monitor continuously",
  ],
};

/**
 * Bucket a task into a coarse complexity tier.
 *
 * @param {unknown} task
 * @returns {'trivial' | 'simple' | 'moderate' | 'complex' | 'mission'}
 */
export function assessComplexity(task) {
  const text = taskText(task).trim();
  if (!text) return "simple";

  // Word count + explicit keyword bumps.
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // Check keyword-based hints in order of decreasing severity so that the
  // most "expensive" match wins if a task mentions multiple signals.
  const ordered = ["mission", "complex", "moderate", "simple", "trivial"];
  for (const tier of ordered) {
    const keywords = COMPLEXITY_KEYWORDS[tier];
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        return /** @type {any} */ (tier);
      }
    }
  }

  if (matchesLongRunning(task)) return "mission";
  if (matchesSimpleQuestion(task) && wordCount <= 12) return "trivial";
  if (wordCount <= 20) return "simple";
  if (wordCount <= 60) return "moderate";
  if (wordCount <= 150) return "complex";
  return "complex";
}

/**
 * Compute a single object summarising every heuristic at once. Useful for
 * routing code that wants to reason about multiple signals without re-scanning
 * the task text repeatedly.
 *
 * @param {unknown} task
 */
export function summarizeHeuristics(task) {
  return {
    simpleQuestion: matchesSimpleQuestion(task),
    toolRequired: matchesToolRequired(task),
    highStakes: matchesHighStakes(task),
    longRunning: matchesLongRunning(task),
    complexity: assessComplexity(task),
  };
}
