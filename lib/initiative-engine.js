/**
 * Initiative engine: goal-seeking autonomy loop.
 *
 * Where event-triggers.js is reactive (event -> workflow), the initiative
 * engine is proactive: on a cadence it gathers signals about a workspace,
 * reasons about whether anything is worth doing, and produces *proposals*
 * (suggested initiatives with rationale + confidence) that are surfaced for
 * human approval (HITL) or, when policy allows, auto-executed.
 *
 * Storage: data/initiatives/{workspaceId}.json -> { proposals: [...] }
 *
 * The core functions are pure with respect to the network: signal providers
 * and the LLM completion function are injected, so the engine is fully
 * testable without a backend. When no LLM is available it falls back to a
 * deterministic heuristic so cycles still produce useful proposals.
 */
import { join } from "path";
import { randomUUID, createHash } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { listScheduledAgents, getScheduledAgentRuns } from "./scheduled-agents.js";
import { listMemories } from "./agent-memory.js";
import { createLogger } from "./logger.js";

const log = createLogger("initiative");

const MAX_PROPOSALS = 200;
const VALID_CATEGORIES = ["investigate", "automate", "fix", "notify", "optimize"];
const VALID_STATUSES = ["pending", "approved", "dismissed", "executed", "expired"];
const OPEN_STATUSES = new Set(["pending", "approved"]);

function sanitizeWorkspace(ws) {
  if (typeof ws !== "string" || !String(ws).trim()) return "default";
  return String(ws).trim().slice(0, 50).replace(/[^a-zA-Z0-9._-]/g, "") || "default";
}

function storePath(workspaceId) {
  return join(getDataDir(), "initiatives", sanitizeWorkspace(workspaceId) + ".json");
}

function normalizeStore(raw) {
  if (raw && typeof raw === "object" && Array.isArray(raw.proposals)) return raw;
  return { proposals: [] };
}

function fingerprintOf(parts) {
  return createHash("sha256").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 24);
}

// --- Signal providers -------------------------------------------------------
// A signal provider is `async (workspaceId, opts) => Signal[]`.
// Signal: { kind, summary, detail?, severity (1-5), fingerprint }

/**
 * Surface scheduled agents that have been failing repeatedly.
 */
export async function scheduledAgentFailureSignals(workspaceId, opts = {}) {
  const window = Math.max(3, Number(opts.window) || 5);
  const threshold = Math.max(1, Number(opts.failureThreshold) || 2);
  const signals = [];
  try {
    const agents = await listScheduledAgents(workspaceId);
    for (const agent of agents) {
      const runs = await getScheduledAgentRuns(workspaceId, agent.id, window);
      if (!runs.length) continue;
      const failures = runs.filter((r) => r.status === "failed");
      if (failures.length >= threshold) {
        const lastErr = failures[0]?.error || "unknown error";
        signals.push({
          kind: "scheduled_agent_failure",
          summary: `Scheduled agent "${agent.name}" failed ${failures.length}/${runs.length} recent runs`,
          detail: `Latest error: ${String(lastErr).slice(0, 300)}`,
          severity: failures.length >= window ? 4 : 3,
          fingerprint: fingerprintOf(["saf", agent.id, String(failures.length)]),
          ref: { type: "scheduled_agent", id: agent.id },
        });
      }
    }
  } catch (e) {
    log.warn("scheduledAgentFailureSignals error", { error: e.message });
  }
  return signals;
}

/**
 * Surface high-importance observations the agent has recorded in memory.
 */
export async function memoryObservationSignals(workspaceId, opts = {}) {
  const userId = opts.userId || "anonymous";
  const limit = Math.max(1, Number(opts.limit) || 5);
  const signals = [];
  try {
    const { memories } = await listMemories(userId, workspaceId, {
      category: "observation",
      limit: 50,
      sortBy: "importance",
    });
    for (const m of memories.filter((x) => (x.importance || 3) >= 4).slice(0, limit)) {
      signals.push({
        kind: "memory_observation",
        summary: m.content.slice(0, 200),
        detail: "",
        severity: Math.min(5, Math.max(1, m.importance || 3)) - 1,
        fingerprint: fingerprintOf(["obs", m.id]),
        ref: { type: "memory", id: m.id },
      });
    }
  } catch (e) {
    log.warn("memoryObservationSignals error", { error: e.message });
  }
  return signals;
}

export const defaultSignalProviders = [scheduledAgentFailureSignals, memoryObservationSignals];

/**
 * Run all signal providers and merge their output.
 * @param {string} workspaceId
 * @param {{ providers?: Function[], providerOpts?: object }} opts
 * @returns {Promise<object[]>}
 */
export async function gatherSignals(workspaceId, opts = {}) {
  const providers = Array.isArray(opts.providers) ? opts.providers : defaultSignalProviders;
  const out = [];
  for (const provider of providers) {
    try {
      const sigs = await provider(workspaceId, opts.providerOpts || {});
      if (Array.isArray(sigs)) out.push(...sigs);
    } catch (e) {
      log.warn("signal provider error", { error: e.message });
    }
  }
  return out;
}

// --- Proposal generation ----------------------------------------------------

function buildProposalPrompt(workspaceId, signals) {
  const lines = signals.map(
    (s, i) => `${i + 1}. [${s.kind}, severity ${s.severity}] ${s.summary}${s.detail ? ` — ${s.detail}` : ""}`
  );
  return [
    {
      role: "system",
      content:
        "You are a proactive AI coworker embedded in a team's workspace. You are given a list of " +
        "signals observed about the workspace. Decide whether any of them warrant an initiative — " +
        "something genuinely worth doing on the team's behalf. Be selective: propose only high-value, " +
        "actionable items, and skip noise. Respond with STRICT JSON: an array of objects, each with " +
        `keys "title" (short imperative), "rationale" (1-2 sentences), "category" (one of ${VALID_CATEGORIES.join(", ")}), ` +
        '"suggestedAction" (concrete next step), and "confidence" (0-1). Return [] if nothing is worth doing.',
    },
    {
      role: "user",
      content: `Workspace: ${workspaceId}\n\nSignals:\n${lines.join("\n") || "(none)"}\n\nReturn the JSON array of proposals.`,
    },
  ];
}

function parseProposalsJson(text) {
  if (typeof text !== "string") return [];
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function coerceCategory(c) {
  const v = String(c || "").toLowerCase().trim();
  return VALID_CATEGORIES.includes(v) ? v : "investigate";
}

function coerceConfidence(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}

/**
 * Deterministic fallback when no LLM is available: one proposal per
 * sufficiently severe signal.
 */
function heuristicProposals(signals) {
  const byCategory = {
    scheduled_agent_failure: "fix",
    memory_observation: "investigate",
  };
  return signals
    .filter((s) => (s.severity || 0) >= 2)
    .map((s) => ({
      title:
        s.kind === "scheduled_agent_failure"
          ? `Repair failing scheduled agent`
          : `Investigate: ${s.summary.slice(0, 60)}`,
      rationale: s.detail ? `${s.summary}. ${s.detail}` : s.summary,
      category: byCategory[s.kind] || "investigate",
      suggestedAction:
        s.kind === "scheduled_agent_failure"
          ? "Review the agent's recent runs and fix the underlying error, or pause it."
          : "Review this observation and decide whether it needs follow-up.",
      confidence: Math.min(0.9, 0.4 + (s.severity || 0) * 0.1),
      _signal: s,
    }));
}

/**
 * Turn signals into proposal drafts (not yet persisted).
 * @param {{ workspaceId: string, signals: object[], llmComplete?: Function, maxProposals?: number }} opts
 * @returns {Promise<{ drafts: object[], source: string }>}
 */
export async function proposeFromSignals(opts) {
  const { workspaceId, signals = [], llmComplete, maxProposals = 5 } = opts;
  if (!signals.length) return { drafts: [], source: "none" };

  let drafts = [];
  let source = "heuristic";

  if (typeof llmComplete === "function") {
    try {
      const text = await llmComplete(buildProposalPrompt(workspaceId, signals));
      const parsed = parseProposalsJson(text);
      if (parsed.length) {
        source = "llm";
        drafts = parsed.map((p) => ({
          title: String(p.title || "Untitled initiative").slice(0, 200),
          rationale: String(p.rationale || "").slice(0, 1000),
          category: coerceCategory(p.category),
          suggestedAction: String(p.suggestedAction || "").slice(0, 1000),
          confidence: coerceConfidence(p.confidence),
        }));
      }
    } catch (e) {
      log.warn("llm proposal generation failed, using heuristic", { error: e.message });
    }
  }

  if (!drafts.length) {
    drafts = heuristicProposals(signals);
  }

  // Attach a fingerprint for dedup. Prefer the originating signal's fingerprint
  // when present (heuristic path); otherwise derive from title+category.
  drafts = drafts.slice(0, Math.max(1, maxProposals)).map((d) => {
    const fp = d._signal?.fingerprint || fingerprintOf([d.category, d.title.toLowerCase()]);
    const ref = d._signal?.ref || null;
    delete d._signal;
    return { ...d, signalFingerprint: fp, ref };
  });

  return { drafts, source };
}

// --- Proposal store ---------------------------------------------------------

/**
 * List proposals for a workspace.
 * @param {string} workspaceId
 * @param {{ status?: string, limit?: number }} [opts]
 */
export async function listProposals(workspaceId, opts = {}) {
  const path = storePath(workspaceId);
  const store = normalizeStore(await readJsonPath(path, null));
  let proposals = store.proposals;
  if (opts.status) proposals = proposals.filter((p) => p.status === opts.status);
  proposals = proposals
    .slice()
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const limit = Math.min(Math.max(1, Number(opts.limit) || 100), MAX_PROPOSALS);
  return proposals.slice(0, limit);
}

export async function getProposal(workspaceId, id) {
  const path = storePath(workspaceId);
  const store = normalizeStore(await readJsonPath(path, null));
  return store.proposals.find((p) => p.id === id) || null;
}

/**
 * Persist proposal drafts, skipping any whose fingerprint already has an open
 * (pending/approved) proposal. Returns the created proposals.
 * @param {string} workspaceId
 * @param {object[]} drafts
 * @param {{ source?: string, signals?: object[] }} [meta]
 */
export async function persistProposals(workspaceId, drafts, meta = {}) {
  const ws = sanitizeWorkspace(workspaceId);
  const path = storePath(ws);
  const created = [];
  let skipped = 0;

  await withPathLock(path, async () => {
    const store = normalizeStore(await readJsonPath(path, null));
    const openFingerprints = new Set(
      store.proposals.filter((p) => OPEN_STATUSES.has(p.status)).map((p) => p.signalFingerprint)
    );
    const now = new Date().toISOString();

    for (const d of drafts) {
      if (d.signalFingerprint && openFingerprints.has(d.signalFingerprint)) {
        skipped++;
        continue;
      }
      const proposal = {
        id: randomUUID(),
        workspaceId: ws,
        title: d.title,
        rationale: d.rationale,
        category: coerceCategory(d.category),
        suggestedAction: d.suggestedAction || "",
        confidence: coerceConfidence(d.confidence),
        signalFingerprint: d.signalFingerprint || null,
        ref: d.ref || null,
        source: meta.source || "heuristic",
        status: "pending",
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
      };
      store.proposals.push(proposal);
      if (proposal.signalFingerprint) openFingerprints.add(proposal.signalFingerprint);
      created.push(proposal);
    }

    // Enforce cap: drop oldest resolved proposals first, then oldest overall.
    if (store.proposals.length > MAX_PROPOSALS) {
      store.proposals.sort((a, b) => {
        const aOpen = OPEN_STATUSES.has(a.status) ? 1 : 0;
        const bOpen = OPEN_STATUSES.has(b.status) ? 1 : 0;
        if (aOpen !== bOpen) return bOpen - aOpen;
        return (b.createdAt || "").localeCompare(a.createdAt || "");
      });
      store.proposals = store.proposals.slice(0, MAX_PROPOSALS);
    }

    if (created.length) await writeJsonPath(path, store);
  });

  return { created, skipped };
}

/**
 * Resolve a proposal (approve / dismiss / mark executed).
 * @param {string} workspaceId
 * @param {string} id
 * @param {{ status: string, by?: string, resolution?: string }} opts
 * @returns {Promise<object|null>}
 */
export async function resolveProposal(workspaceId, id, opts) {
  const status = String(opts?.status || "").trim();
  if (!VALID_STATUSES.includes(status) || status === "pending") {
    throw new Error(`status must be one of: ${VALID_STATUSES.filter((s) => s !== "pending").join(", ")}`);
  }
  const path = storePath(workspaceId);
  let updated = null;

  await withPathLock(path, async () => {
    const store = normalizeStore(await readJsonPath(path, null));
    const proposal = store.proposals.find((p) => p.id === id);
    if (!proposal) return;
    proposal.status = status;
    proposal.resolvedAt = new Date().toISOString();
    proposal.resolvedBy = typeof opts.by === "string" ? opts.by.slice(0, 200) : null;
    proposal.resolution = typeof opts.resolution === "string" ? opts.resolution.slice(0, 1000) : null;
    proposal.updatedAt = proposal.resolvedAt;
    await writeJsonPath(path, store);
    updated = proposal;
  });

  return updated;
}

// --- Cycle ------------------------------------------------------------------

/**
 * Build an `llmComplete(messages) => string` adapter from the proxy backend
 * helpers carried in route/scheduler deps. Returns null if not wired.
 */
export function llmCompleteFromBackend({ backendFetch, buildProxyConfig, model } = {}) {
  if (typeof backendFetch !== "function" || typeof buildProxyConfig !== "function") return null;
  return async (messages) => {
    const config = buildProxyConfig(model || "default");
    const url = `${config.baseUrl}${config.path}`;
    const resp = await backendFetch(url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify({ model: model || "default", messages, stream: false }),
    });
    if (!resp.ok) throw new Error(`Backend error: ${resp.status}`);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || "";
  };
}

/**
 * Run one initiative cycle for a workspace: gather signals, generate proposals,
 * persist them (deduped), and optionally surface each new proposal.
 *
 * @param {{
 *   workspaceId: string,
 *   providers?: Function[],
 *   providerOpts?: object,
 *   llmComplete?: Function,
 *   maxProposals?: number,
 *   onProposal?: (proposal: object) => (void|Promise<void>),
 * }} opts
 * @returns {Promise<{ created: object[], skipped: number, signals: object[], source: string }>}
 */
export async function runInitiativeCycle(opts) {
  const workspaceId = sanitizeWorkspace(opts.workspaceId || "default");
  const signals = await gatherSignals(workspaceId, {
    providers: opts.providers,
    providerOpts: opts.providerOpts,
  });
  if (!signals.length) {
    return { created: [], skipped: 0, signals: [], source: "none" };
  }

  const { drafts, source } = await proposeFromSignals({
    workspaceId,
    signals,
    llmComplete: opts.llmComplete,
    maxProposals: opts.maxProposals,
  });

  const { created, skipped } = await persistProposals(workspaceId, drafts, { source });

  if (created.length && typeof opts.onProposal === "function") {
    for (const proposal of created) {
      try {
        await opts.onProposal(proposal);
      } catch (e) {
        log.warn("onProposal handler error", { error: e.message });
      }
    }
  }

  if (created.length) {
    log.info("Initiative cycle produced proposals", {
      workspaceId,
      created: created.length,
      skipped,
      source,
    });
  }

  return { created, skipped, signals, source };
}

/**
 * Format a proposal as a short human-readable message (for Slack/chat surfacing).
 */
export function formatProposalMessage(proposal) {
  const pct = Math.round((proposal.confidence || 0) * 100);
  return [
    `:bulb: *Initiative proposal* — ${proposal.title}`,
    `${proposal.rationale}`,
    `*Suggested action:* ${proposal.suggestedAction || "—"}`,
    `_category: ${proposal.category} · confidence: ${pct}% · id: ${proposal.id}_`,
  ].join("\n");
}

/**
 * Render a proposal as Slack Block Kit blocks with inline Approve/Dismiss
 * buttons. The button `value` carries the workspace + proposal id so the
 * interaction handler can resolve it without extra lookups.
 */
export function formatProposalBlocks(proposal) {
  const pct = Math.round((proposal.confidence || 0) * 100);
  const value = JSON.stringify({ w: proposal.workspaceId, p: proposal.id });
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:bulb: *Initiative proposal* — ${proposal.title}\n` +
          `${proposal.rationale}\n` +
          `*Suggested action:* ${proposal.suggestedAction || "—"}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `category: ${proposal.category} · confidence: ${pct}% · id: ${proposal.id}`,
        },
      ],
    },
    {
      type: "actions",
      block_id: `initiative:${proposal.id}`,
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          action_id: "initiative_approve",
          value,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Dismiss" },
          action_id: "initiative_dismiss",
          value,
        },
      ],
    },
  ];
}

export const _internal = { fingerprintOf, parseProposalsJson, heuristicProposals, MAX_PROPOSALS };
