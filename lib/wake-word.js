/**
 * Wake-word detection and voice command parsing.
 *
 * Provides:
 *   - createWakeWordDetector: a lightweight feature-matching detector
 *     that scans audio chunks for wake-word energy/cadence patterns.
 *     Not as accurate as ML-based detectors (Porcupine, Snowboy) but
 *     adequate for an MVP and runs without native deps.
 *   - parseVoiceCommand: extracts an action and params from a transcript
 *     using a small grammar of patterns and slot fillers.
 *   - VOICE_COMMAND_GRAMMAR: declarative pattern table consumed by
 *     parseVoiceCommand and getCommandHelp.
 *
 * @module lib/wake-word
 */

export const DEFAULT_WAKE_WORDS = [
  "hey siskelbot",
  "hi siskelbot",
  "okay siskelbot",
  "ok siskelbot",
  "siskelbot",
];

const DEFAULT_THRESHOLD = 0.65;

/**
 * Normalize a string for fuzzy comparison: lowercase, collapse whitespace,
 * strip punctuation.
 * @param {string} s
 * @returns {string}
 */
function normalizeText(s) {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s*{}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compute audio "energy" features used by the lightweight detector.
 * Accepts either a Float32Array (PCM in [-1,1]) or a Buffer of bytes.
 * Returns { rms, zeroCrossings, length, peak }.
 * @param {ArrayLike<number>|Buffer} chunk
 * @returns {{ rms: number, zeroCrossings: number, length: number, peak: number }}
 */
export function computeAudioFeatures(chunk) {
  if (!chunk || typeof chunk.length !== "number" || chunk.length === 0) {
    return { rms: 0, zeroCrossings: 0, length: 0, peak: 0 };
  }
  let sum = 0;
  let zc = 0;
  let peak = 0;
  let prev = 0;
  for (let i = 0; i < chunk.length; i++) {
    let v = chunk[i];
    // If it looks like a Buffer/Uint8Array, recenter to [-1,1]
    if (v > 1 || v < -1) v = (v - 128) / 128;
    sum += v * v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
    if (i > 0 && ((prev >= 0 && v < 0) || (prev < 0 && v >= 0))) zc++;
    prev = v;
  }
  return {
    rms: Math.sqrt(sum / chunk.length),
    zeroCrossings: zc,
    length: chunk.length,
    peak,
  };
}

/**
 * Estimate match score for a wake word given audio features.
 * Uses heuristics about expected duration, energy, and cadence.
 * Score is in [0, 1].
 * @param {object} features
 * @param {string} word
 * @returns {number}
 */
function scoreFeaturesAgainstWord(features, word) {
  if (!features || features.length === 0) return 0;
  // Expected syllable count drives expected zero-crossings range.
  const syllables = Math.max(1, word.split(/\s+/).length * 2);
  const expectedZcMin = syllables * 8;
  const expectedZcMax = syllables * 200;
  const energyOk = features.rms > 0.01 && features.peak > 0.05;
  const cadenceOk = features.zeroCrossings >= expectedZcMin && features.zeroCrossings <= expectedZcMax;
  let score = 0;
  if (energyOk) score += 0.4;
  if (cadenceOk) score += 0.4;
  // Length should be at least a few hundred samples per syllable.
  if (features.length >= syllables * 200) score += 0.2;
  return Math.min(1, score);
}

/**
 * Create a wake-word detector. The returned object is stateful: callers
 * push audio chunks via analyze() and receive notifications when a wake
 * word is detected (above threshold).
 *
 * @param {object} [options]
 * @param {string[]} [options.wakeWords] - Phrases to listen for
 * @param {number} [options.threshold] - Match score in [0,1] to fire
 * @param {(detection: object) => void} [options.onDetect] - Detection callback
 * @returns {object} detector with analyze/setWakeWords/getStats/reset
 */
export function createWakeWordDetector(options = {}) {
  let wakeWords = Array.isArray(options.wakeWords) && options.wakeWords.length
    ? options.wakeWords.slice()
    : DEFAULT_WAKE_WORDS.slice();
  let threshold = typeof options.threshold === "number" ? options.threshold : DEFAULT_THRESHOLD;
  const onDetect = typeof options.onDetect === "function" ? options.onDetect : null;

  const stats = {
    detections: 0,
    falsePositives: 0,
    analyses: 0,
    lastDetection: null,
    lastScore: 0,
  };

  function analyze(audioChunk) {
    stats.analyses++;
    const features = computeAudioFeatures(audioChunk);
    let bestWord = null;
    let bestScore = 0;
    for (const w of wakeWords) {
      const score = scoreFeaturesAgainstWord(features, w);
      if (score > bestScore) {
        bestScore = score;
        bestWord = w;
      }
    }
    stats.lastScore = bestScore;
    const detected = bestScore >= threshold;
    if (detected) {
      stats.detections++;
      stats.lastDetection = { word: bestWord, score: bestScore, at: Date.now() };
      if (onDetect) {
        try { onDetect({ word: bestWord, score: bestScore, features }); } catch (_) { /* ignore */ }
      }
    }
    return { detected, word: bestWord, score: bestScore, features };
  }

  /**
   * Analyze a transcript directly. Used when STT runs alongside the
   * detector to confirm a candidate wake-word match.
   * @param {string} transcript
   */
  function analyzeTranscript(transcript) {
    stats.analyses++;
    const norm = normalizeText(transcript || "");
    if (!norm) return { detected: false, word: null, score: 0 };
    let bestWord = null;
    let bestScore = 0;
    for (const w of wakeWords) {
      const target = normalizeText(w);
      if (!target) continue;
      if (norm === target || norm.startsWith(target + " ") || norm.includes(" " + target + " ") || norm.endsWith(" " + target)) {
        const score = norm === target ? 1.0 : 0.9;
        if (score > bestScore) {
          bestScore = score;
          bestWord = w;
        }
      } else {
        // Token overlap fallback
        const targetTokens = target.split(" ");
        const normTokens = new Set(norm.split(" "));
        let overlap = 0;
        for (const t of targetTokens) if (normTokens.has(t)) overlap++;
        const score = overlap / targetTokens.length;
        if (score > bestScore) {
          bestScore = score * 0.8;
          bestWord = w;
        }
      }
    }
    stats.lastScore = bestScore;
    const detected = bestScore >= threshold;
    if (detected) {
      stats.detections++;
      stats.lastDetection = { word: bestWord, score: bestScore, at: Date.now() };
      if (onDetect) {
        try { onDetect({ word: bestWord, score: bestScore, transcript }); } catch (_) { /* ignore */ }
      }
    }
    return { detected, word: bestWord, score: bestScore };
  }

  function setWakeWords(words) {
    if (!Array.isArray(words)) {
      throw new TypeError("wakeWords must be an array of strings");
    }
    wakeWords = words.filter((w) => typeof w === "string" && w.trim().length > 0);
  }

  function getWakeWords() {
    return wakeWords.slice();
  }

  function setThreshold(t) {
    if (typeof t !== "number" || t < 0 || t > 1) {
      throw new RangeError("threshold must be a number in [0,1]");
    }
    threshold = t;
  }

  function getStats() {
    return Object.assign({}, stats);
  }

  function recordFalsePositive() {
    stats.falsePositives++;
  }

  function reset() {
    stats.detections = 0;
    stats.falsePositives = 0;
    stats.analyses = 0;
    stats.lastDetection = null;
    stats.lastScore = 0;
  }

  return {
    analyze,
    analyzeTranscript,
    setWakeWords,
    getWakeWords,
    setThreshold,
    getStats,
    recordFalsePositive,
    reset,
  };
}

/**
 * Declarative voice command grammar.
 *
 * Pattern syntax:
 *   - Plain words match literally (case-insensitive).
 *   - "*" at the end captures everything that follows into params.query.
 *   - "{name}" captures a single token (or remaining text if last) into params[name].
 *   - "(a|b)" matches one of the alternatives and stores it in params.choice.
 */
export const VOICE_COMMAND_GRAMMAR = {
  "new chat": { action: "new_conversation", description: "Start a new conversation" },
  "new conversation": { action: "new_conversation", description: "Start a new conversation" },
  "search for *": { action: "search", description: "Search across knowledge and conversations" },
  "find *": { action: "search", description: "Search across knowledge and conversations" },
  "show {destination}": { action: "navigate", description: "Navigate to a section (recipes, conversations, settings, etc.)" },
  "open {destination}": { action: "navigate", description: "Open a section by name" },
  "go to {destination}": { action: "navigate", description: "Navigate to a section" },
  "run recipe {name}": { action: "run_recipe", description: "Execute a saved recipe by name" },
  "execute recipe {name}": { action: "run_recipe", description: "Execute a saved recipe by name" },
  "stop": { action: "interrupt", description: "Interrupt the current generation or task" },
  "cancel": { action: "interrupt", description: "Cancel the current operation" },
  "delete (last|this) message": { action: "delete_message", description: "Delete the last or current message" },
  "delete message": { action: "delete_message", description: "Delete the current message" },
  "regenerate": { action: "regenerate", description: "Regenerate the last assistant response" },
  "send {text}": { action: "send_message", description: "Send a chat message" },
  "switch model to {name}": { action: "switch_model", description: "Switch the active model" },
  "use model {name}": { action: "switch_model", description: "Switch the active model" },
  "switch workspace to {name}": { action: "switch_workspace", description: "Switch the active workspace" },
  "help": { action: "help", description: "Show available voice commands" },
  "what can you do": { action: "help", description: "Show available voice commands" },
};

/**
 * Compile a grammar pattern into a regex + capture metadata.
 * @param {string} pattern
 * @returns {{ regex: RegExp, captures: string[], hasWildcard: boolean }}
 */
function compilePattern(pattern) {
  const captures = [];
  let hasWildcard = false;
  let regexSrc = "^";
  // Tokenize so we can handle alternations and slot tokens cleanly.
  const tokens = pattern.split(/(\s+|\([^)]+\)|\{[^}]+\}|\*)/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/^\s+$/.test(tok)) {
      regexSrc += "\\s+";
      continue;
    }
    if (tok === "*") {
      hasWildcard = true;
      regexSrc += "(?<query>.+)";
      captures.push("query");
      continue;
    }
    const slotMatch = tok.match(/^\{([^}]+)\}$/);
    if (slotMatch) {
      const name = slotMatch[1];
      captures.push(name);
      // If this is the last meaningful token, allow the slot to capture
      // multiple words; otherwise capture a single word.
      const isLast = tokens.slice(i + 1).every((t) => /^\s+$/.test(t));
      regexSrc += isLast ? `(?<${name}>.+)` : `(?<${name}>\\S+)`;
      continue;
    }
    const altMatch = tok.match(/^\(([^)]+)\)$/);
    if (altMatch) {
      const alts = altMatch[1].split("|").map((s) => s.trim()).filter(Boolean);
      captures.push("choice");
      regexSrc += `(?<choice>${alts.map(escapeRegex).join("|")})`;
      continue;
    }
    regexSrc += escapeRegex(tok);
  }
  regexSrc += "\\s*$";
  return { regex: new RegExp(regexSrc, "i"), captures, hasWildcard };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Memoized compiled patterns.
const compiledCache = new Map();
function getCompiled(pattern) {
  let entry = compiledCache.get(pattern);
  if (!entry) {
    entry = compilePattern(pattern);
    compiledCache.set(pattern, entry);
  }
  return entry;
}

/**
 * Strip a leading wake word from a transcript so it isn't considered
 * part of the command body.
 * @param {string} transcript
 * @param {string[]} [wakeWords]
 * @returns {string}
 */
export function stripWakeWord(transcript, wakeWords = DEFAULT_WAKE_WORDS) {
  let t = normalizeText(transcript || "");
  for (const w of wakeWords) {
    const norm = normalizeText(w);
    if (!norm) continue;
    if (t === norm) return "";
    if (t.startsWith(norm + " ")) {
      t = t.slice(norm.length + 1).trim();
      break;
    }
  }
  return t;
}

/**
 * Parse a transcript into a structured voice command.
 * Tries each pattern in VOICE_COMMAND_GRAMMAR (plus any added via
 * registerGrammarEntry) and returns the first match.
 *
 * @param {string} transcript
 * @param {object} [opts]
 * @param {object} [opts.grammar] - Override grammar table
 * @param {string[]} [opts.wakeWords] - Wake words to strip
 * @returns {{ action: string|null, params: object, confidence: number, pattern: string|null, raw: string }}
 */
export function parseVoiceCommand(transcript, opts = {}) {
  const grammar = opts.grammar || VOICE_COMMAND_GRAMMAR;
  const wakeWords = opts.wakeWords || DEFAULT_WAKE_WORDS;
  const raw = typeof transcript === "string" ? transcript : "";
  const stripped = stripWakeWord(raw, wakeWords);
  if (!stripped) {
    return { action: null, params: {}, confidence: 0, pattern: null, raw };
  }

  let best = null;
  for (const pattern of Object.keys(grammar)) {
    const compiled = getCompiled(pattern);
    const m = compiled.regex.exec(stripped);
    if (!m) continue;
    const grammarEntry = grammar[pattern];
    const params = {};
    if (m.groups) {
      for (const [k, v] of Object.entries(m.groups)) {
        if (typeof v === "string") params[k] = v.trim();
      }
    }
    // Merge any default params declared on the grammar entry.
    if (grammarEntry.params && typeof grammarEntry.params === "object") {
      for (const [k, v] of Object.entries(grammarEntry.params)) {
        if (typeof v === "string" && v === "*") {
          params[k] = params.query || params[k] || "";
        } else if (params[k] == null) {
          params[k] = v;
        }
      }
    }
    // Confidence: longer patterns that match are more specific.
    const specificity = pattern.replace(/[*{}()]/g, "").trim().split(/\s+/).length;
    const confidence = Math.min(1, 0.6 + specificity * 0.08);
    const candidate = {
      action: grammarEntry.action,
      params,
      confidence,
      pattern,
      raw,
    };
    if (!best || candidate.confidence > best.confidence) {
      best = candidate;
    }
  }

  if (best) return best;
  return { action: null, params: {}, confidence: 0, pattern: null, raw };
}
