/**
 * Phase 32.4: Multi-turn reasoning memory.
 *
 * Tracks the agent's reasoning chains across turns and conversations so
 * that the agent (and users) can reference past logic. Unlike agent-memory
 * which stores facts and preferences, this module stores the agent's
 * inference chain: premises, inferences, conclusions, confidence, and
 * supporting sources, plus relationships between conclusions.
 *
 * Storage: data/reasoning/{workspaceId}/{conversationId}.json
 * Each file is: { conversationId, workspaceId, steps: [...], links: [...] }
 */
import { randomUUID } from "crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { join, dirname } from "path";

const VALID_RELATIONS = ["supports", "contradicts", "extends", "refines"];
const VALID_EXPORT_FORMATS = ["markdown", "graphviz", "json"];

function getDataDir() {
  return process.env.STORAGE_PATH || join(process.cwd(), "data");
}

function sanitize(val, fallback) {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || fallback;
}

function getReasoningDir(workspaceId) {
  const ws = sanitize(workspaceId, "default");
  return join(getDataDir(), "reasoning", ws);
}

function getReasoningFilePath(workspaceId, conversationId) {
  const cid = sanitize(conversationId, "unknown");
  return join(getReasoningDir(workspaceId), `${cid}.json`);
}

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function emptyChain(conversationId, workspaceId) {
  return {
    conversationId: String(conversationId || "unknown"),
    workspaceId: String(workspaceId || "default"),
    steps: [],
    links: [],
  };
}

function loadChainFile(workspaceId, conversationId) {
  const filePath = getReasoningFilePath(workspaceId, conversationId);
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        if (!Array.isArray(parsed.steps)) parsed.steps = [];
        if (!Array.isArray(parsed.links)) parsed.links = [];
        return parsed;
      }
    }
  } catch {
    // corrupted file — start fresh
  }
  return emptyChain(conversationId, workspaceId);
}

function saveChainFile(workspaceId, conversationId, data) {
  const filePath = getReasoningFilePath(workspaceId, conversationId);
  ensureDir(filePath);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function listConversationsInWorkspace(workspaceId) {
  const dir = getReasoningDir(workspaceId);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

function listWorkspaces() {
  const root = join(getDataDir(), "reasoning");
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Record a single reasoning step for the given conversation.
 *
 * @param {string} conversationId
 * @param {object} step - { workspaceId?, turnIndex, premise, inference, conclusion, confidence?, sources?, toolsUsed? }
 * @returns {Promise<{ id: string, createdAt: string }>}
 */
export async function recordReasoningStep(conversationId, step) {
  if (!conversationId || typeof conversationId !== "string") {
    throw new Error("conversationId is required");
  }
  if (!step || typeof step !== "object") {
    throw new Error("step is required");
  }

  const workspaceId = step.workspaceId || "default";
  const data = loadChainFile(workspaceId, conversationId);

  const now = new Date().toISOString();
  const entry = {
    id: randomUUID(),
    turnIndex:
      Number.isFinite(Number(step.turnIndex)) ? Number(step.turnIndex) : data.steps.length,
    premise: typeof step.premise === "string" ? step.premise : "",
    inference: typeof step.inference === "string" ? step.inference : "",
    conclusion: typeof step.conclusion === "string" ? step.conclusion : "",
    confidence:
      typeof step.confidence === "number" && step.confidence >= 0 && step.confidence <= 1
        ? step.confidence
        : null,
    sources: Array.isArray(step.sources) ? step.sources.slice(0, 50) : [],
    toolsUsed: Array.isArray(step.toolsUsed) ? step.toolsUsed.slice(0, 50) : [],
    createdAt: now,
  };

  data.steps.push(entry);
  saveChainFile(workspaceId, conversationId, data);

  return { id: entry.id, createdAt: entry.createdAt };
}

/**
 * Get the ordered list of reasoning steps for a conversation.
 *
 * @param {string} conversationId
 * @param {string} [workspaceId]
 * @returns {Promise<{ conversationId: string, workspaceId: string, steps: Array, links: Array }>}
 */
export async function getReasoningChain(conversationId, workspaceId = "default") {
  if (!conversationId || typeof conversationId !== "string") {
    return emptyChain(conversationId, workspaceId);
  }
  const data = loadChainFile(workspaceId, conversationId);
  const steps = [...data.steps].sort((a, b) => {
    const ti = (a.turnIndex || 0) - (b.turnIndex || 0);
    if (ti !== 0) return ti;
    return (a.createdAt || "").localeCompare(b.createdAt || "");
  });
  return { ...data, steps };
}

/**
 * Link two conclusions with a typed relationship. Both conclusions can be
 * step ids (preferred) or the literal conclusion text. The link is stored on
 * the conversation of the first conclusion when discoverable, otherwise on the
 * provided workspace's `__global__` chain.
 *
 * @param {string} conclusionA - step id or conclusion text
 * @param {string} conclusionB - step id or conclusion text
 * @param {('supports'|'contradicts'|'extends'|'refines')} relationType
 * @param {object} [options] - { conversationId?, workspaceId? }
 * @returns {Promise<{ id: string, createdAt: string, relationType: string }>}
 */
export async function linkConclusions(conclusionA, conclusionB, relationType, options = {}) {
  if (!conclusionA || !conclusionB) {
    throw new Error("conclusionA and conclusionB are required");
  }
  if (!VALID_RELATIONS.includes(relationType)) {
    throw new Error(`relationType must be one of: ${VALID_RELATIONS.join(", ")}`);
  }

  const workspaceId = options.workspaceId || "default";
  let conversationId = options.conversationId || null;

  // If no conversationId was provided, try to locate step ids by scanning.
  if (!conversationId) {
    const conversations = listConversationsInWorkspace(workspaceId);
    for (const cid of conversations) {
      const chain = loadChainFile(workspaceId, cid);
      if (chain.steps.some((s) => s.id === conclusionA || s.id === conclusionB)) {
        conversationId = cid;
        break;
      }
    }
  }
  if (!conversationId) conversationId = "__global__";

  const data = loadChainFile(workspaceId, conversationId);
  const now = new Date().toISOString();
  const link = {
    id: randomUUID(),
    conclusionA: String(conclusionA),
    conclusionB: String(conclusionB),
    relationType,
    createdAt: now,
  };
  data.links.push(link);
  saveChainFile(workspaceId, conversationId, data);

  return { id: link.id, createdAt: link.createdAt, relationType };
}

function scoreRelevance(text, words) {
  if (!text || typeof text !== "string") return 0;
  const lower = text.toLowerCase();
  let matches = 0;
  for (const w of words) {
    if (lower.includes(w)) matches++;
  }
  return words.length === 0 ? 0 : Math.round((matches / words.length) * 100) / 100;
}

/**
 * Search past reasoning steps across all conversations in a workspace for a
 * relevant query. Ranks by textual match against premise + inference + conclusion.
 *
 * @param {string} query
 * @param {string} [workspaceId]
 * @param {object} [options] - { limit? }
 * @returns {Promise<Array<{ step: object, conversationId: string, relevance: number }>>}
 */
export async function findRelatedReasoning(query, workspaceId = "default", options = {}) {
  if (!query || typeof query !== "string" || !query.trim()) return [];

  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const conversations = listConversationsInWorkspace(workspaceId);
  const limit = Math.min(Math.max(1, Number(options.limit) || 20), 200);

  const results = [];
  for (const cid of conversations) {
    const chain = loadChainFile(workspaceId, cid);
    for (const step of chain.steps) {
      const text = `${step.premise || ""}\n${step.inference || ""}\n${step.conclusion || ""}`;
      const relevance = scoreRelevance(text, words);
      if (relevance > 0) {
        results.push({ step, conversationId: cid, relevance });
      }
    }
  }

  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, limit);
}

/**
 * Detect internal contradictions in a reasoning chain.
 * Uses (a) explicit 'contradicts' links, and (b) simple textual opposition
 * heuristics (e.g. "is X" vs "is not X", negation overlap).
 *
 * @param {string} conversationId
 * @param {string} [workspaceId]
 * @returns {Promise<Array<{ stepA: object, stepB: object, type: string }>>}
 */
export async function detectContradictions(conversationId, workspaceId = "default") {
  if (!conversationId) return [];
  const chain = loadChainFile(workspaceId, conversationId);
  const out = [];

  // 1. Explicit links
  for (const link of chain.links || []) {
    if (link.relationType !== "contradicts") continue;
    const stepA = chain.steps.find((s) => s.id === link.conclusionA) || {
      id: link.conclusionA,
      conclusion: link.conclusionA,
    };
    const stepB = chain.steps.find((s) => s.id === link.conclusionB) || {
      id: link.conclusionB,
      conclusion: link.conclusionB,
    };
    out.push({ stepA, stepB, type: "explicit" });
  }

  // 2. Heuristic: same subject phrase with opposing polarity.
  const normalise = (s) => (s || "").toLowerCase().trim();
  const stripNegation = (s) =>
    s
      .replace(/\b(is not|isn't|are not|aren't|was not|wasn't|were not|weren't|does not|doesn't|do not|don't|cannot|can't|won't|will not|no|not)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const steps = chain.steps;
  for (let i = 0; i < steps.length; i++) {
    for (let j = i + 1; j < steps.length; j++) {
      const a = normalise(steps[i].conclusion);
      const b = normalise(steps[j].conclusion);
      if (!a || !b) continue;

      const aNeg = /\b(not|no|n't|cannot|never)\b/.test(a);
      const bNeg = /\b(not|no|n't|cannot|never)\b/.test(b);
      if (aNeg === bNeg) continue;

      const aStripped = stripNegation(a);
      const bStripped = stripNegation(b);
      if (!aStripped || !bStripped) continue;

      // Consider them contradictory if the stripped forms substantially overlap.
      if (
        aStripped === bStripped ||
        (aStripped.length > 8 && bStripped.includes(aStripped)) ||
        (bStripped.length > 8 && aStripped.includes(bStripped))
      ) {
        // Don't double-report if an explicit link already covers this pair
        const alreadyExplicit = out.some(
          (c) =>
            c.type === "explicit" &&
            ((c.stepA.id === steps[i].id && c.stepB.id === steps[j].id) ||
              (c.stepA.id === steps[j].id && c.stepB.id === steps[i].id))
        );
        if (!alreadyExplicit) {
          out.push({ stepA: steps[i], stepB: steps[j], type: "heuristic" });
        }
      }
    }
  }

  return out;
}

/**
 * Build a narrative summary of how the agent reached its conclusions.
 *
 * @param {string} conversationId
 * @param {string} [workspaceId]
 * @returns {Promise<{ summary: string, keyInferences: string[], assumptions: string[] }>}
 */
export async function summarizeReasoning(conversationId, workspaceId = "default") {
  const chain = await getReasoningChain(conversationId, workspaceId);
  const steps = chain.steps;
  if (steps.length === 0) {
    return { summary: "", keyInferences: [], assumptions: [] };
  }

  const keyInferences = [];
  const assumptions = [];
  const lines = [];

  for (const s of steps) {
    if (s.conclusion) {
      keyInferences.push(s.conclusion);
    }
    if (
      s.premise &&
      (!Array.isArray(s.sources) || s.sources.length === 0) &&
      (!Array.isArray(s.toolsUsed) || s.toolsUsed.length === 0)
    ) {
      assumptions.push(s.premise);
    }

    const toolNote = Array.isArray(s.toolsUsed) && s.toolsUsed.length > 0
      ? ` (using ${s.toolsUsed.join(", ")})`
      : "";
    const confNote = typeof s.confidence === "number"
      ? ` [confidence ${Math.round(s.confidence * 100)}%]`
      : "";
    const part = [];
    if (s.premise) part.push(`Starting from "${s.premise}"`);
    if (s.inference) part.push(`the agent inferred "${s.inference}"${toolNote}`);
    if (s.conclusion) part.push(`and concluded "${s.conclusion}"${confNote}`);
    if (part.length > 0) {
      lines.push(`Turn ${s.turnIndex ?? "?"}: ${part.join(", ")}.`);
    }
  }

  return {
    summary: lines.join(" "),
    keyInferences: keyInferences.slice(0, 20),
    assumptions: assumptions.slice(0, 20),
  };
}

function escapeDot(s) {
  return String(s || "").replace(/"/g, '\\"').replace(/\n/g, " ").slice(0, 120);
}

/**
 * Export a reasoning chain in the requested format.
 *
 * @param {string} conversationId
 * @param {('markdown'|'graphviz'|'json')} format
 * @param {string} [workspaceId]
 * @returns {Promise<string>}
 */
export async function exportReasoning(conversationId, format, workspaceId = "default") {
  if (!VALID_EXPORT_FORMATS.includes(format)) {
    throw new Error(`format must be one of: ${VALID_EXPORT_FORMATS.join(", ")}`);
  }

  const chain = await getReasoningChain(conversationId, workspaceId);

  if (format === "json") {
    return JSON.stringify(chain, null, 2);
  }

  if (format === "markdown") {
    const { summary, keyInferences, assumptions } = await summarizeReasoning(
      conversationId,
      workspaceId
    );
    const lines = [];
    lines.push(`# Reasoning chain: ${chain.conversationId}`);
    lines.push("");
    if (summary) {
      lines.push("## Narrative");
      lines.push("");
      lines.push(summary);
      lines.push("");
    }
    if (chain.steps.length > 0) {
      lines.push("## Steps");
      lines.push("");
      for (const s of chain.steps) {
        lines.push(`### Turn ${s.turnIndex ?? "?"}`);
        if (s.premise) lines.push(`- **Premise:** ${s.premise}`);
        if (s.inference) lines.push(`- **Inference:** ${s.inference}`);
        if (s.conclusion) lines.push(`- **Conclusion:** ${s.conclusion}`);
        if (typeof s.confidence === "number") {
          lines.push(`- **Confidence:** ${Math.round(s.confidence * 100)}%`);
        }
        if (Array.isArray(s.toolsUsed) && s.toolsUsed.length > 0) {
          lines.push(`- **Tools:** ${s.toolsUsed.join(", ")}`);
        }
        if (Array.isArray(s.sources) && s.sources.length > 0) {
          lines.push(`- **Sources:** ${s.sources.join(", ")}`);
        }
        lines.push("");
      }
    }
    if (keyInferences.length > 0) {
      lines.push("## Key inferences");
      lines.push("");
      for (const k of keyInferences) lines.push(`- ${k}`);
      lines.push("");
    }
    if (assumptions.length > 0) {
      lines.push("## Assumptions");
      lines.push("");
      for (const a of assumptions) lines.push(`- ${a}`);
      lines.push("");
    }
    if (Array.isArray(chain.links) && chain.links.length > 0) {
      lines.push("## Links");
      lines.push("");
      for (const l of chain.links) {
        lines.push(`- ${l.conclusionA} *${l.relationType}* ${l.conclusionB}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  // graphviz
  const lines = [];
  lines.push(`digraph reasoning_${sanitize(conversationId, "chain")} {`);
  lines.push("  rankdir=LR;");
  lines.push('  node [shape=box, style=rounded];');
  for (const s of chain.steps) {
    if (s.premise) {
      lines.push(`  "p_${s.id}" [label="P: ${escapeDot(s.premise)}", style="rounded,filled", fillcolor="#eef"];`);
    }
    lines.push(`  "c_${s.id}" [label="C: ${escapeDot(s.conclusion || s.inference || "(step)")}"];`);
    if (s.premise) {
      lines.push(`  "p_${s.id}" -> "c_${s.id}" [label="${escapeDot(s.inference || "infers")}"];`);
    }
  }
  // Sequential edges between consecutive conclusions to show the chain
  for (let i = 1; i < chain.steps.length; i++) {
    lines.push(`  "c_${chain.steps[i - 1].id}" -> "c_${chain.steps[i].id}" [style=dashed];`);
  }
  // Link edges
  for (const l of chain.links || []) {
    const a = chain.steps.find((s) => s.id === l.conclusionA);
    const b = chain.steps.find((s) => s.id === l.conclusionB);
    if (a && b) {
      const color =
        l.relationType === "contradicts"
          ? "red"
          : l.relationType === "supports"
            ? "green"
            : l.relationType === "extends"
              ? "blue"
              : "purple";
      lines.push(`  "c_${a.id}" -> "c_${b.id}" [label="${l.relationType}", color="${color}"];`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}

/**
 * Internal helper: extract a reasoning step from an agent iteration that
 * involved tool calls. Used by agent-loop.js.
 *
 * @param {object} info - { turnIndex, toolCalls, toolResults, modelContent }
 * @returns {object|null}
 */
export function extractStepFromIteration(info) {
  if (!info || typeof info !== "object") return null;
  const toolCalls = Array.isArray(info.toolCalls) ? info.toolCalls : [];
  if (toolCalls.length === 0) return null;

  const toolsUsed = toolCalls.map((tc) => tc.name).filter(Boolean);
  const premise = toolCalls
    .map((tc) => `${tc.name}(${safeStringify(tc.args)})`)
    .join("; ")
    .slice(0, 800);

  const resultSnippets = (info.toolResults || [])
    .map((r) => {
      if (!r) return "";
      if (typeof r.content === "string") return r.content;
      try {
        return JSON.stringify(r.content || r);
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join(" | ")
    .slice(0, 800);

  const inference = resultSnippets || "(tool results interpreted)";
  const conclusion =
    typeof info.modelContent === "string" && info.modelContent.trim()
      ? info.modelContent.trim().slice(0, 800)
      : `Proceeded using results from ${toolsUsed.join(", ")}`;

  const sources = toolCalls
    .flatMap((tc) => {
      const a = tc.args || {};
      const acc = [];
      if (typeof a.url === "string") acc.push(a.url);
      if (typeof a.id === "string") acc.push(a.id);
      return acc;
    })
    .slice(0, 20);

  return {
    turnIndex: info.turnIndex,
    premise,
    inference,
    conclusion,
    toolsUsed,
    sources,
    confidence: typeof info.confidence === "number" ? info.confidence : null,
  };
}

function safeStringify(val) {
  try {
    const s = JSON.stringify(val);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(val);
  }
}

/**
 * List all conversations that have recorded reasoning in a workspace.
 *
 * @param {string} [workspaceId]
 * @returns {Promise<string[]>}
 */
export async function listReasoningConversations(workspaceId = "default") {
  return listConversationsInWorkspace(workspaceId);
}

/**
 * List all workspaces with reasoning data (used by cross-workspace search).
 *
 * @returns {Promise<string[]>}
 */
export async function listReasoningWorkspaces() {
  return listWorkspaces();
}
