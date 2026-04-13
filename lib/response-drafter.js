/**
 * Phase 62.3: Response drafting — tone-controlled reply generation.
 *
 * Produces draft replies in one of four tones: formal, friendly, empathetic,
 * concise. An optional agent-loop callable can be injected so production code
 * can delegate to real LLMs; tests use the built-in deterministic stub so
 * results are reproducible without network access.
 *
 * Storage layout (via json-path-store):
 *   data/response-drafts/{id}.json   — draft record
 *   data/response-drafts/_index.json — draft id index
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Paths ─────────────────────────────────────────────────────────────────

function draftPath(id) {
  return join(getDataDir(), "response-drafts", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "response-drafts", "_index.json");
}

function sanitize(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

// ─── Tones ─────────────────────────────────────────────────────────────────

export const TONES = {
  formal: {
    name: "formal",
    description: "Polite, professional, third-person-ready.",
    openers: ["Dear customer,", "Hello,", "Good day,"],
    closers: ["Sincerely,\nThe Support Team", "Regards,\nSupport"],
    style: { contractions: false, exclamations: false, maxSentences: 8 },
  },
  friendly: {
    name: "friendly",
    description: "Warm, casual, conversational.",
    openers: ["Hey there!", "Hi!", "Hello!"],
    closers: ["Cheers,\nThe Support Crew", "Take care,\nSupport"],
    style: { contractions: true, exclamations: true, maxSentences: 10 },
  },
  empathetic: {
    name: "empathetic",
    description: "Acknowledges frustration, validates the customer's experience.",
    openers: [
      "I'm really sorry you're dealing with this.",
      "I understand how frustrating this must be.",
    ],
    closers: ["We're here for you,\nSupport", "Thanks for your patience,\nSupport"],
    style: { contractions: true, exclamations: false, maxSentences: 10 },
  },
  concise: {
    name: "concise",
    description: "Minimal words, action-oriented.",
    openers: ["Hi,"],
    closers: ["— Support"],
    style: { contractions: true, exclamations: false, maxSentences: 4 },
  },
};

export function listTones() {
  return Object.values(TONES).map((t) => ({
    name: t.name,
    description: t.description,
  }));
}

// ─── Stub generator ────────────────────────────────────────────────────────

/**
 * Deterministic stub that composes a draft from tone presets + input context.
 * Real callers can override this with `opts.generate` (e.g. bound to the
 * agent-loop).
 */
export function stubGenerate({ tone, subject, body, context }) {
  const t = TONES[tone] || TONES.friendly;
  const opener = t.openers[0];
  const closer = t.closers[0];
  const ref = subject ? `Regarding "${subject}", ` : "";
  const contextLine = context && typeof context === "string" ? `${context.trim()}\n\n` : "";
  let middle;
  switch (tone) {
    case "formal":
      middle = `${ref}we have received your message and will look into it. ${summariseBody(body)}`;
      break;
    case "empathetic":
      middle = `${ref}${summariseBody(body)} We'll stay with you until this is resolved.`;
      break;
    case "concise":
      middle = `${ref}${summariseBody(body, 1)}`;
      break;
    case "friendly":
    default:
      middle = `${ref}thanks for reaching out! ${summariseBody(body)}`;
      break;
  }
  const suffix = t.style.exclamations ? "!" : ".";
  const text = `${opener}\n\n${contextLine}${middle.replace(/\.$/, "")}${suffix}\n\n${closer}`;
  return { text, tone: t.name };
}

function summariseBody(body, maxSentences = 3) {
  const raw = String(body || "").trim();
  if (!raw) return "";
  const sentences = raw.split(/[.!?]+\s*/).filter(Boolean);
  return sentences.slice(0, maxSentences).join(". ") + (sentences.length ? "." : "");
}

// ─── Persistence ───────────────────────────────────────────────────────────

async function storeDraft(record) {
  await writeJsonPath(draftPath(record.id), record);
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { ids: [] });
    const list = Array.isArray(idx.ids) ? idx.ids : [];
    list.unshift(record.id);
    if (list.length > 500) list.length = 500;
    await writeJsonPath(indexPath(), { ids: list });
  });
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Draft a full reply, persist it, and return the record.
 *
 * @param {{
 *   subject?: string, body?: string, context?: string, tone?: string,
 *   ticketId?: string,
 *   generate?: (args: object) => Promise<{text: string, tone: string}> | {text: string, tone: string},
 * }} opts
 */
export async function draftResponse(opts = {}) {
  if (!opts || typeof opts !== "object") throw new Error("opts is required");
  const tone = resolveTone(opts.tone);
  const generator = typeof opts.generate === "function" ? opts.generate : stubGenerate;
  const result = await generator({
    tone,
    subject: opts.subject || "",
    body: opts.body || "",
    context: opts.context || "",
  });
  const text = result?.text;
  if (!text || typeof text !== "string") throw new Error("generator returned no text");
  const record = {
    id: randomUUID(),
    ticketId: opts.ticketId || null,
    tone,
    subject: opts.subject || null,
    body: opts.body || null,
    context: opts.context || null,
    text,
    createdAt: new Date().toISOString(),
  };
  await storeDraft(record);
  return record;
}

/**
 * Like `draftResponse` but does not persist the draft. Useful for UIs that
 * want to preview before committing.
 */
export async function previewDraft(opts = {}) {
  if (!opts || typeof opts !== "object") throw new Error("opts is required");
  const tone = resolveTone(opts.tone);
  const generator = typeof opts.generate === "function" ? opts.generate : stubGenerate;
  const result = await generator({
    tone,
    subject: opts.subject || "",
    body: opts.body || "",
    context: opts.context || "",
  });
  return { tone, text: result?.text || "" };
}

function resolveTone(tone) {
  const key = String(tone || "friendly").toLowerCase();
  if (!(key in TONES)) {
    const err = new Error(`unknown tone: ${tone}`);
    err.code = "INVALID_TONE";
    throw err;
  }
  return key;
}

export async function getDraft(id) {
  if (!id) return null;
  const rec = await readJsonPath(draftPath(id), null);
  if (!rec || !rec.id) return null;
  return rec;
}

export async function listDrafts(limit = 50) {
  const idx = await readJsonPath(indexPath(), { ids: [] });
  const ids = Array.isArray(idx.ids) ? idx.ids : [];
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  const out = [];
  for (const id of ids.slice(0, n)) {
    const rec = await getDraft(id);
    if (rec) out.push(rec);
  }
  return out;
}

export const _internals = {
  resolveTone,
  summariseBody,
  draftPath,
  indexPath,
};
