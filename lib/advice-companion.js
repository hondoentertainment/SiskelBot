/**
 * Honest personal-advice companion (Daimon-style advice app functionality).
 * Persona prompts, thought capture/resurfacing on top of agent memory.
 */
import { remember, listMemories, recall, forget, updateMemory } from "./agent-memory.js";
import {
  loadWorkspaceAgentSettings,
  saveWorkspaceAgentSettings,
} from "./workspace-agent-settings.js";

export const ADVICE_MODE_SENTINEL = "[advice-companion]";

/** Honest, friend-like advisor — challenges soft thinking without cruelty. */
export const ADVICE_SYSTEM_PROMPT = `${ADVICE_MODE_SENTINEL}
You are the user's personal advice companion. You text like a sharp, loyal friend —
warm when it helps, direct when it matters. You do not sugar-coat hard truths.

Goals:
- Help them think clearer and choose better.
- Remember what they care about (use recalled thoughts and memories).
- Reflect their situation honestly; name tradeoffs and blind spots.
- Prefer short, conversational replies (like a text), not lectures.
- When they ask for a decision, give a clear recommendation and why — then note the risks.

Never invent facts about their life. If you need context, ask one focused question.
If they capture a thought or reminder, acknowledge it and offer to use it later.`;

export const CHALLENGE_MODE_ADDENDUM = `
Challenge mode is ON:
- When they seem stuck, avoid, or rationalize — push back constructively.
- Ask the hard question they are dodging (one at a time).
- Do not pile on; challenge then support a concrete next step.
- Celebrate clarity, not comfort.`;

export const THOUGHT_KINDS = new Set(["note", "idea", "reminder", "moment", "decision"]);

/**
 * @param {string | null | undefined} prompt
 */
export function isAdviceCompanionPrompt(prompt) {
  return typeof prompt === "string" && prompt.includes(ADVICE_MODE_SENTINEL);
}

/**
 * @param {{ challenge?: boolean }} [opts]
 */
export function buildAdviceSystemPrompt(opts = {}) {
  const challenge = opts.challenge === true;
  return challenge
    ? `${ADVICE_SYSTEM_PROMPT}\n${CHALLENGE_MODE_ADDENDUM}`
    : ADVICE_SYSTEM_PROMPT;
}

/**
 * Enable advice companion persona on a workspace (durable agent settings).
 * @param {string} storageUserId
 * @param {string} workspaceId
 * @param {{ challenge?: boolean, mergeExisting?: boolean }} [opts]
 */
export async function enableAdviceMode(storageUserId, workspaceId, opts = {}) {
  const current = await loadWorkspaceAgentSettings(storageUserId, workspaceId);
  const challenge = opts.challenge === true;
  const advicePrompt = buildAdviceSystemPrompt({ challenge });
  let defaultSystemPrompt = advicePrompt;
  if (opts.mergeExisting !== false && current.defaultSystemPrompt) {
    const existing = String(current.defaultSystemPrompt);
    if (!isAdviceCompanionPrompt(existing)) {
      defaultSystemPrompt = `${advicePrompt}\n\n---\nAdditional workspace instructions:\n${existing}`;
    } else {
      defaultSystemPrompt = advicePrompt;
    }
  }
  const saved = await saveWorkspaceAgentSettings(storageUserId, workspaceId, {
    ...current,
    defaultSystemPrompt,
  });
  return {
    ok: true,
    challenge,
    adviceMode: true,
    defaultSystemPrompt: saved.defaultSystemPrompt,
  };
}

/**
 * @param {string} storageUserId
 * @param {string} workspaceId
 */
export async function getAdviceModeStatus(storageUserId, workspaceId) {
  const settings = await loadWorkspaceAgentSettings(storageUserId, workspaceId);
  const prompt = settings.defaultSystemPrompt || "";
  return {
    enabled: isAdviceCompanionPrompt(prompt),
    challenge: /Challenge mode is ON/i.test(prompt),
    defaultSystemPrompt: prompt,
  };
}

/**
 * Remove the advice companion persona from workspace settings.
 * Preserves any "Additional workspace instructions" block when present.
 * @param {string} storageUserId
 * @param {string} workspaceId
 */
export async function disableAdviceMode(storageUserId, workspaceId) {
  const current = await loadWorkspaceAgentSettings(storageUserId, workspaceId);
  const existing = String(current.defaultSystemPrompt || "");
  let next = "";
  if (isAdviceCompanionPrompt(existing)) {
    const marker = "\n\n---\nAdditional workspace instructions:\n";
    const idx = existing.indexOf(marker);
    next = idx >= 0 ? existing.slice(idx + marker.length).trim() : "";
  } else {
    next = existing;
  }
  const saved = await saveWorkspaceAgentSettings(storageUserId, workspaceId, {
    ...current,
    defaultSystemPrompt: next,
  });
  return { ok: true, adviceMode: false, defaultSystemPrompt: saved.defaultSystemPrompt };
}

/**
 * Capture a personal thought (note / idea / reminder / moment / decision).
 * @param {string} userId
 * @param {string} workspaceId
 * @param {{ content: string, kind?: string, importance?: number, resurfaceAt?: string|null, tags?: string[] }} input
 */
export async function captureThought(userId, workspaceId, input = {}) {
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!content) throw new Error("content is required");
  const kind = THOUGHT_KINDS.has(input.kind) ? input.kind : "note";
  let resurfaceAt = null;
  if (input.resurfaceAt) {
    const t = Date.parse(input.resurfaceAt);
    if (Number.isNaN(t)) throw new Error("resurfaceAt must be a valid ISO date");
    resurfaceAt = new Date(t).toISOString();
  }
  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
    : [];
  const importance =
    input.importance != null
      ? Number(input.importance)
      : kind === "reminder" || kind === "decision"
        ? 4
        : 3;

  const entry = await remember(userId, workspaceId, {
    content,
    category: "observation",
    importance,
    source: "advice_companion",
    metadata: {
      kind: "thought",
      thoughtKind: kind,
      resurfaceAt,
      tags,
      capturedAt: new Date().toISOString(),
    },
  });
  return { ...entry, thoughtKind: kind, resurfaceAt, tags };
}

/**
 * @param {string} userId
 * @param {string} workspaceId
 * @param {{ limit?: number, thoughtKind?: string }} [opts]
 */
export async function listThoughts(userId, workspaceId, opts = {}) {
  const { memories, total } = await listMemories(userId, workspaceId, {
    category: "observation",
    limit: 200,
    sortBy: "createdAt",
  });
  let thoughts = memories.filter((m) => m?.metadata?.kind === "thought");
  if (opts.thoughtKind && THOUGHT_KINDS.has(opts.thoughtKind)) {
    thoughts = thoughts.filter((m) => m.metadata?.thoughtKind === opts.thoughtKind);
  }
  const limit = Math.min(Math.max(1, Number(opts.limit) || 50), 100);
  return { thoughts: thoughts.slice(0, limit), total: thoughts.length, listedOf: total };
}

/**
 * Thoughts due for resurfacing (resurfaceAt <= now) plus high-importance recent ones.
 * @param {string} userId
 * @param {string} workspaceId
 * @param {{ limit?: number, query?: string }} [opts]
 */
export async function resurfaceThoughts(userId, workspaceId, opts = {}) {
  const now = Date.now();
  const { thoughts } = await listThoughts(userId, workspaceId, { limit: 200 });
  const due = [];
  const sticky = [];
  for (const t of thoughts) {
    const at = t.metadata?.resurfaceAt ? Date.parse(t.metadata.resurfaceAt) : null;
    if (at != null && !Number.isNaN(at) && at <= now) due.push(t);
    else if ((t.importance || 3) >= 4) sticky.push(t);
  }
  let matched = [];
  if (opts.query && String(opts.query).trim()) {
    const r = await recall(userId, workspaceId, String(opts.query), {
      category: "observation",
      limit: 20,
    });
    matched = (r.memories || []).filter((m) => m?.metadata?.kind === "thought");
  }
  const seen = new Set();
  const out = [];
  for (const t of [...due, ...matched, ...sticky]) {
    if (!t?.id || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= (Number(opts.limit) || 8)) break;
  }
  return { thoughts: out, dueCount: due.length };
}

/**
 * Format resurfaced thoughts for a system message.
 * @param {object[]} thoughts
 */
export function formatThoughtsHint(thoughts) {
  if (!Array.isArray(thoughts) || thoughts.length === 0) return "";
  const lines = thoughts.slice(0, 8).map((t, i) => {
    const kind = t.metadata?.thoughtKind || "note";
    return `${i + 1}. [${kind}] ${t.content}`;
  });
  return `Personal thoughts to keep in mind (from their journal):\n${lines.join("\n")}\nBring these up only when relevant; do not dump the whole list.`;
}

export async function deleteThought(userId, workspaceId, thoughtId) {
  return forget(userId, workspaceId, thoughtId);
}

export async function updateThought(userId, workspaceId, thoughtId, patch = {}) {
  const updates = {};
  if (typeof patch.content === "string") updates.content = patch.content;
  if (patch.importance != null) updates.importance = Number(patch.importance);

  const meta = {};
  if (patch.kind != null) {
    if (!THOUGHT_KINDS.has(patch.kind)) throw new Error("invalid thought kind");
    meta.thoughtKind = patch.kind;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "resurfaceAt")) {
    if (patch.resurfaceAt == null || patch.resurfaceAt === "") {
      meta.resurfaceAt = null;
    } else {
      const t = Date.parse(patch.resurfaceAt);
      if (Number.isNaN(t)) throw new Error("resurfaceAt must be a valid ISO date");
      meta.resurfaceAt = new Date(t).toISOString();
    }
  }
  if (Array.isArray(patch.tags)) {
    meta.tags = patch.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12);
  }
  if (Object.keys(meta).length) updates.metadata = meta;

  const result = await updateMemory(thoughtId, updates, workspaceId, userId);
  if (!result.ok) return result;
  if (result.memory?.metadata?.kind !== "thought") {
    return { ok: false, error: "Not an advice thought" };
  }
  return result;
}
