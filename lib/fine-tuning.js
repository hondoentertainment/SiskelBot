/**
 * Fine-tuning workflow manager.
 * Supports OpenAI fine-tuning API and local fine-tuning prep.
 *
 * Responsibilities:
 *   - Export conversations from a workspace to JSONL in multiple formats
 *     (OpenAI chat, Alpaca, ShareGPT).
 *   - Validate training data (JSONL format, token counts, line validity).
 *   - Create / list / get / cancel fine-tune jobs against OpenAI or local.
 *   - Fetch fine-tune job events.
 *
 * Storage:
 *   Job metadata is persisted per-workspace in
 *   data/fine-tune-jobs/{workspaceId}.json via json-path-store.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import * as storage from "./storage.js";
import { listFeedback } from "./feedback.js";
import * as openaiFt from "./fine-tune-providers/openai-ft.js";

const MAX_JOBS = 5_000;
const OPENAI_HARD_TOKEN_LIMIT = 32_768;
const DEFAULT_MAX_EXAMPLES = 10_000;

// ─── storage helpers ───────────────────────────────────────────────────────

function jobsPath(workspaceId) {
  const ws = typeof workspaceId === "string" && workspaceId.trim() ? workspaceId.trim() : "default";
  return join(getDataDir(), "fine-tune-jobs", `${ws}.json`);
}

async function loadJobs(workspaceId) {
  const path = jobsPath(workspaceId);
  const data = await readJsonPath(path, { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

async function saveJobs(workspaceId, items) {
  const path = jobsPath(workspaceId);
  const trimmed = items.length > MAX_JOBS ? items.slice(-MAX_JOBS) : items;
  await writeJsonPath(path, { _version: 1, items: trimmed });
}

async function findJobRecord(jobId) {
  // Search across all workspaces when we only know the id.
  // For efficiency, callers should pass workspaceId when known.
  const path = join(getDataDir(), "fine-tune-jobs");
  try {
    const { readdirSync } = await import("fs");
    const files = readdirSync(path).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const ws = f.replace(/\.json$/, "");
      const items = await loadJobs(ws);
      const found = items.find((j) => j.jobId === jobId || j.id === jobId);
      if (found) return { workspaceId: ws, job: found };
    }
  } catch {
    // directory may not exist yet
  }
  return null;
}

// ─── token estimation ──────────────────────────────────────────────────────

/**
 * Rough token estimate (chars / 4). Used for pre-flight size checks; the
 * real tokenizer lives server-side at the provider.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== "string" || !text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    if (!m) continue;
    total += estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""));
    total += 4; // per-message overhead
  }
  return total;
}

// ─── format conversions ────────────────────────────────────────────────────

/**
 * Convert a sequence of messages to OpenAI chat fine-tune format:
 *   { messages: [{ role, content }, ...] }
 * Only user/assistant/system/tool roles are preserved.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {{ messages: Array<{role:string, content:string}> }}
 */
export function convertToOpenAIFormat(messages) {
  if (!Array.isArray(messages)) return { messages: [] };
  const allowed = new Set(["system", "user", "assistant", "tool", "function"]);
  const cleaned = messages
    .filter((m) => m && typeof m === "object" && allowed.has(m.role))
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    }))
    .filter((m) => m.content.length > 0);
  return { messages: cleaned };
}

/**
 * Convert a conversation to Alpaca instruction format:
 *   { instruction, input, output }
 * Strategy: first user turn = instruction, any system = input (prepended),
 * first assistant reply = output.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {{ instruction: string, input: string, output: string }}
 */
export function convertToAlpacaFormat(messages) {
  if (!Array.isArray(messages)) return { instruction: "", input: "", output: "" };
  const system = messages.find((m) => m?.role === "system");
  const firstUser = messages.find((m) => m?.role === "user");
  const firstAssistant = messages.find((m) => m?.role === "assistant");
  return {
    instruction: firstUser?.content ? String(firstUser.content) : "",
    input: system?.content ? String(system.content) : "",
    output: firstAssistant?.content ? String(firstAssistant.content) : "",
  };
}

/**
 * Convert to ShareGPT format:
 *   { conversations: [{ from, value }] }
 * Mapping: user->human, assistant->gpt, system->system, tool->tool.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {{ conversations: Array<{from:string, value:string}> }}
 */
export function convertToShareGPTFormat(messages) {
  if (!Array.isArray(messages)) return { conversations: [] };
  const roleMap = { user: "human", assistant: "gpt", system: "system", tool: "tool", function: "tool" };
  const conversations = messages
    .filter((m) => m && typeof m === "object" && roleMap[m.role])
    .map((m) => ({
      from: roleMap[m.role],
      value: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    }))
    .filter((m) => m.value.length > 0);
  return { conversations };
}

// ─── export conversations ──────────────────────────────────────────────────

function parseTimestamp(value) {
  if (!value) return null;
  const t = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

async function getPositiveRatedConversationIds(workspaceId, minRating) {
  const items = await listFeedback(workspaceId);
  const ids = new Set();
  for (const item of items) {
    if (item && item.rating >= minRating && item.conversationId) {
      ids.add(item.conversationId);
    }
  }
  return ids;
}

/**
 * Export conversations for fine-tuning.
 *
 * @param {string} workspaceId
 * @param {{
 *   format?: "openai" | "alpaca" | "sharegpt",
 *   minRating?: number | null,
 *   dateFrom?: string | number | null,
 *   dateTo?: string | number | null,
 *   maxExamples?: number,
 * }} [options]
 * @returns {Promise<{
 *   jsonl: string,
 *   exampleCount: number,
 *   estimatedTokens: number,
 *   format: string,
 * }>}
 */
export async function exportConversationsForFineTuning(workspaceId, options = {}) {
  const format = (options.format || "openai").toLowerCase();
  if (!["openai", "alpaca", "sharegpt"].includes(format)) {
    throw new Error(`unsupported format: ${format}`);
  }
  const minRating = Number.isFinite(Number(options.minRating)) ? Number(options.minRating) : null;
  const fromMs = parseTimestamp(options.dateFrom);
  const toMs = parseTimestamp(options.dateTo);
  const maxExamples = Number.isFinite(Number(options.maxExamples))
    ? Math.max(1, Math.floor(Number(options.maxExamples)))
    : DEFAULT_MAX_EXAMPLES;

  const ws = workspaceId || "default";
  const allConversations = await storage.listItems("conversations", ws);

  // Filter by positive feedback if minRating set
  let allowedIds = null;
  if (minRating != null) {
    allowedIds = await getPositiveRatedConversationIds(ws, minRating);
  }

  const lines = [];
  let estimatedTokens = 0;

  for (const conv of allConversations) {
    if (lines.length >= maxExamples) break;
    if (!conv || !Array.isArray(conv.messages) || conv.messages.length < 2) continue;

    if (allowedIds && !allowedIds.has(conv.id)) continue;

    const createdMs = parseTimestamp(conv.createdAt);
    if (fromMs != null && createdMs != null && createdMs < fromMs) continue;
    if (toMs != null && createdMs != null && createdMs > toMs) continue;

    // Need at least one user + one assistant message for a meaningful example.
    const hasUser = conv.messages.some((m) => m?.role === "user");
    const hasAssistant = conv.messages.some((m) => m?.role === "assistant");
    if (!hasUser || !hasAssistant) continue;

    let record;
    if (format === "openai") {
      record = convertToOpenAIFormat(conv.messages);
      if (!record.messages.length) continue;
    } else if (format === "alpaca") {
      record = convertToAlpacaFormat(conv.messages);
      if (!record.instruction || !record.output) continue;
    } else {
      record = convertToShareGPTFormat(conv.messages);
      if (!record.conversations.length) continue;
    }

    const line = JSON.stringify(record);
    lines.push(line);
    estimatedTokens += estimateTokens(line);
  }

  return {
    jsonl: lines.join("\n"),
    exampleCount: lines.length,
    estimatedTokens,
    format,
  };
}

// ─── validation ────────────────────────────────────────────────────────────

/**
 * Validate JSONL training data for format correctness and token budgets.
 * Currently validates against the OpenAI chat fine-tune schema when the
 * record has a `messages` field.
 * @param {string} jsonlContent
 * @returns {{
 *   valid: boolean,
 *   errors: Array<string>,
 *   warnings: Array<string>,
 *   stats: { lineCount: number, exampleCount: number, totalTokens: number, maxExampleTokens: number }
 * }}
 */
export function validateTrainingData(jsonlContent) {
  const errors = [];
  const warnings = [];
  const stats = { lineCount: 0, exampleCount: 0, totalTokens: 0, maxExampleTokens: 0 };

  if (typeof jsonlContent !== "string" || jsonlContent.length === 0) {
    errors.push("training data is empty");
    return { valid: false, errors, warnings, stats };
  }

  const rawLines = jsonlContent.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (raw.trim() === "") continue;
    stats.lineCount += 1;

    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      errors.push(`line ${i + 1}: invalid JSON`);
      continue;
    }

    if (!obj || typeof obj !== "object") {
      errors.push(`line ${i + 1}: record must be an object`);
      continue;
    }

    // OpenAI chat format
    if (Array.isArray(obj.messages)) {
      if (obj.messages.length < 2) {
        errors.push(`line ${i + 1}: messages must contain at least 2 entries`);
        continue;
      }
      let badRole = false;
      const allowed = new Set(["system", "user", "assistant", "tool", "function"]);
      for (let j = 0; j < obj.messages.length; j++) {
        const m = obj.messages[j];
        if (!m || typeof m !== "object") {
          errors.push(`line ${i + 1}: message ${j} is not an object`);
          badRole = true;
          break;
        }
        if (!allowed.has(m.role)) {
          errors.push(`line ${i + 1}: message ${j} has invalid role "${m.role}"`);
          badRole = true;
          break;
        }
        if (typeof m.content !== "string") {
          errors.push(`line ${i + 1}: message ${j} content must be a string`);
          badRole = true;
          break;
        }
      }
      if (badRole) continue;

      const hasAssistant = obj.messages.some((m) => m.role === "assistant");
      if (!hasAssistant) {
        errors.push(`line ${i + 1}: at least one assistant message is required`);
        continue;
      }

      const tok = estimateMessagesTokens(obj.messages);
      stats.totalTokens += tok;
      stats.maxExampleTokens = Math.max(stats.maxExampleTokens, tok);
      stats.exampleCount += 1;
      if (tok > OPENAI_HARD_TOKEN_LIMIT) {
        errors.push(`line ${i + 1}: estimated ${tok} tokens exceeds ${OPENAI_HARD_TOKEN_LIMIT}`);
      } else if (tok > OPENAI_HARD_TOKEN_LIMIT / 2) {
        warnings.push(`line ${i + 1}: estimated ${tok} tokens is large`);
      }
      continue;
    }

    // Alpaca format
    if ("instruction" in obj && "output" in obj) {
      if (typeof obj.instruction !== "string" || typeof obj.output !== "string") {
        errors.push(`line ${i + 1}: instruction and output must be strings`);
        continue;
      }
      if (!obj.instruction.trim() || !obj.output.trim()) {
        errors.push(`line ${i + 1}: instruction and output must be non-empty`);
        continue;
      }
      const tok = estimateTokens(obj.instruction) + estimateTokens(obj.output) + estimateTokens(obj.input || "");
      stats.totalTokens += tok;
      stats.maxExampleTokens = Math.max(stats.maxExampleTokens, tok);
      stats.exampleCount += 1;
      continue;
    }

    // ShareGPT format
    if (Array.isArray(obj.conversations)) {
      if (obj.conversations.length < 2) {
        errors.push(`line ${i + 1}: conversations must contain at least 2 entries`);
        continue;
      }
      let bad = false;
      for (let j = 0; j < obj.conversations.length; j++) {
        const c = obj.conversations[j];
        if (!c || typeof c !== "object" || typeof c.from !== "string" || typeof c.value !== "string") {
          errors.push(`line ${i + 1}: conversation ${j} is malformed`);
          bad = true;
          break;
        }
      }
      if (bad) continue;
      const tok = obj.conversations.reduce((s, c) => s + estimateTokens(c.value) + 4, 0);
      stats.totalTokens += tok;
      stats.maxExampleTokens = Math.max(stats.maxExampleTokens, tok);
      stats.exampleCount += 1;
      continue;
    }

    errors.push(`line ${i + 1}: unknown record shape (expected messages[], instruction/output, or conversations[])`);
  }

  if (stats.exampleCount === 0 && errors.length === 0) {
    errors.push("no valid examples found");
  }

  return { valid: errors.length === 0 && stats.exampleCount > 0, errors, warnings, stats };
}

// ─── fine-tune job management ──────────────────────────────────────────────

/**
 * Create a fine-tune job.
 * If provider is "openai" the OpenAI fine-tune API is called. Otherwise the
 * job is recorded locally with status "prepared" so the user can run a local
 * trainer against the file.
 *
 * @param {string} workspaceId
 * @param {{
 *   provider?: "openai" | "local",
 *   model: string,
 *   trainingFile: string,           // file contents (JSONL) or a path
 *   validationFile?: string,
 *   hyperparameters?: object,
 *   suffix?: string,
 *   apiKey?: string,
 * }} config
 * @returns {Promise<{ jobId: string, status: string, createdAt: string, provider: string, model: string }>}
 */
export async function createFineTuneJob(workspaceId, config = {}) {
  if (!config || typeof config !== "object") throw new Error("config is required");
  if (!config.model || typeof config.model !== "string") throw new Error("model is required");
  if (!config.trainingFile || typeof config.trainingFile !== "string") {
    throw new Error("trainingFile is required");
  }

  const ws = workspaceId || "default";
  const provider = (config.provider || "openai").toLowerCase();
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  let jobId = id;
  let status = "prepared";
  let providerJobId = null;

  if (provider === "openai") {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for openai provider");
    }
    const fileId = await openaiFt.uploadTrainingFile(config.trainingFile, apiKey);
    let validationFileId = null;
    if (config.validationFile) {
      validationFileId = await openaiFt.uploadTrainingFile(config.validationFile, apiKey);
    }
    const result = await openaiFt.createFineTune(
      {
        model: config.model,
        trainingFile: fileId,
        validationFile: validationFileId,
        hyperparameters: config.hyperparameters || undefined,
        suffix: config.suffix || undefined,
      },
      apiKey,
    );
    providerJobId = result.id;
    jobId = result.id;
    status = result.status || "queued";
  }

  const record = {
    id,
    jobId,
    providerJobId,
    workspaceId: ws,
    provider,
    model: config.model,
    suffix: config.suffix || null,
    hyperparameters: config.hyperparameters || null,
    status,
    createdAt,
    updatedAt: createdAt,
  };

  await withPathLock(jobsPath(ws), async () => {
    const items = await loadJobs(ws);
    items.push(record);
    await saveJobs(ws, items);
  });

  return { jobId, status, createdAt, provider, model: config.model };
}

/**
 * List fine-tune jobs for a workspace.
 * @param {string} workspaceId
 * @returns {Promise<Array<object>>}
 */
export async function listFineTuneJobs(workspaceId) {
  const items = await loadJobs(workspaceId || "default");
  return items.slice().reverse();
}

/**
 * Get a fine-tune job by id. Refreshes remote state for openai-backed jobs.
 * @param {string} jobId
 * @param {{ workspaceId?: string, apiKey?: string }} [opts]
 * @returns {Promise<object|null>}
 */
export async function getFineTuneJob(jobId, opts = {}) {
  if (!jobId) return null;
  let workspaceId = opts.workspaceId;
  let record = null;

  if (workspaceId) {
    const items = await loadJobs(workspaceId);
    record = items.find((j) => j.jobId === jobId || j.id === jobId) || null;
  } else {
    const found = await findJobRecord(jobId);
    if (found) {
      workspaceId = found.workspaceId;
      record = found.job;
    }
  }
  if (!record) return null;

  if (record.provider === "openai" && record.providerJobId) {
    const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
    if (apiKey) {
      try {
        const remote = await openaiFt.getFineTune(record.providerJobId, apiKey);
        record.status = remote.status || record.status;
        record.updatedAt = new Date().toISOString();
        record.fineTunedModel = remote.fine_tuned_model || record.fineTunedModel || null;
        await withPathLock(jobsPath(workspaceId), async () => {
          const items = await loadJobs(workspaceId);
          const idx = items.findIndex((j) => j.id === record.id);
          if (idx >= 0) {
            items[idx] = record;
            await saveJobs(workspaceId, items);
          }
        });
      } catch {
        // swallow refresh errors; return cached record
      }
    }
  }

  return record;
}

/**
 * Cancel a fine-tune job.
 * @param {string} jobId
 * @param {{ workspaceId?: string, apiKey?: string }} [opts]
 * @returns {Promise<{ jobId: string, status: string }>}
 */
export async function cancelFineTuneJob(jobId, opts = {}) {
  const record = await getFineTuneJob(jobId, opts);
  if (!record) throw new Error(`job not found: ${jobId}`);

  if (record.provider === "openai" && record.providerJobId) {
    const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required to cancel openai jobs");
    const remote = await openaiFt.cancelFineTune(record.providerJobId, apiKey);
    record.status = remote.status || "cancelled";
  } else {
    record.status = "cancelled";
  }
  record.updatedAt = new Date().toISOString();

  const ws = record.workspaceId || "default";
  await withPathLock(jobsPath(ws), async () => {
    const items = await loadJobs(ws);
    const idx = items.findIndex((j) => j.id === record.id);
    if (idx >= 0) {
      items[idx] = record;
      await saveJobs(ws, items);
    }
  });

  return { jobId: record.jobId, status: record.status };
}

/**
 * Get events for a fine-tune job (e.g. training progress).
 * @param {string} jobId
 * @param {{ workspaceId?: string, apiKey?: string }} [opts]
 * @returns {Promise<{ events: Array<object> }>}
 */
export async function getFineTuneEvents(jobId, opts = {}) {
  const record = await getFineTuneJob(jobId, opts);
  if (!record) throw new Error(`job not found: ${jobId}`);

  if (record.provider === "openai" && record.providerJobId) {
    const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required to read openai events");
    const events = await openaiFt.getFineTuneEvents(record.providerJobId, apiKey);
    return { events: Array.isArray(events) ? events : [] };
  }

  // Local jobs: return a synthetic event stream
  return {
    events: [
      {
        type: "status",
        message: `local job ${record.status}`,
        createdAt: record.updatedAt || record.createdAt,
      },
    ],
  };
}

/**
 * Test-only helper: clear all stored jobs for a workspace.
 * @param {string} workspaceId
 */
export async function __resetJobsForTests(workspaceId) {
  await saveJobs(workspaceId || "default", []);
}
