/**
 * Phase 62.2: Ticket routing — priority + skill-based queue assignment.
 *
 * Round-robin assignment within a skill-matched queue. Queues are configured
 * with a list of agents; each agent has a set of skills. Tickets carry a
 * priority and an optional required-skill set. The router picks the queue
 * whose agents collectively cover the required skills (falling back to the
 * default queue when no match) and hands the ticket to the next available
 * agent in round-robin order.
 *
 * Storage layout (via json-path-store):
 *   data/ticket-router/config.json     — queues + agents + skills
 *   data/ticket-router/tickets/{id}.json — individual tickets
 *   data/ticket-router/_index.json     — ticket id index
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Paths ─────────────────────────────────────────────────────────────────

function configPath() {
  return join(getDataDir(), "ticket-router", "config.json");
}

function indexPath() {
  return join(getDataDir(), "ticket-router", "_index.json");
}

function ticketPath(id) {
  return join(getDataDir(), "ticket-router", "tickets", `${sanitize(id)}.json`);
}

function sanitize(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "default";
}

// ─── Config / skills ───────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  queues: {
    default: { agents: [], roundRobinIndex: 0 },
  },
  agents: {},
};

async function readConfig() {
  const cfg = await readJsonPath(configPath(), DEFAULT_CONFIG);
  if (!cfg.queues || typeof cfg.queues !== "object") cfg.queues = { default: { agents: [], roundRobinIndex: 0 } };
  if (!cfg.agents || typeof cfg.agents !== "object") cfg.agents = {};
  if (!cfg.queues.default) cfg.queues.default = { agents: [], roundRobinIndex: 0 };
  return cfg;
}

/**
 * Configure skill-set metadata for agents and (optionally) reassign them to
 * queues. `agents` is a map: agentId -> { skills: [], queue?: "billing" }.
 */
export async function configureSkills(agents = {}) {
  if (!agents || typeof agents !== "object") throw new Error("agents map is required");
  return withPathLock(configPath(), async () => {
    const cfg = await readConfig();
    for (const [agentId, info] of Object.entries(agents)) {
      const skills = Array.isArray(info?.skills)
        ? info.skills.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
        : [];
      const queue = info?.queue ? sanitize(info.queue) : "default";
      cfg.agents[agentId] = { id: agentId, skills, queue };
      // Ensure queue exists.
      if (!cfg.queues[queue]) cfg.queues[queue] = { agents: [], roundRobinIndex: 0 };
      // Ensure agent listed in the right queue.
      for (const q of Object.values(cfg.queues)) {
        q.agents = q.agents.filter((id) => id !== agentId);
      }
      cfg.queues[queue].agents.push(agentId);
    }
    await writeJsonPath(configPath(), cfg);
    return cfg;
  });
}

export async function listQueues() {
  const cfg = await readConfig();
  const queues = [];
  for (const [name, q] of Object.entries(cfg.queues)) {
    const agents = q.agents.map((id) => cfg.agents[id]).filter(Boolean);
    queues.push({
      name,
      agents,
      depth: (cfg.queues[name].pending || []).length,
    });
  }
  return queues;
}

// ─── Ticket lifecycle ──────────────────────────────────────────────────────

export const PRIORITIES = ["low", "normal", "high", "urgent"];

function normalizePriority(p) {
  const s = String(p || "normal").toLowerCase();
  return PRIORITIES.includes(s) ? s : "normal";
}

export async function createTicket(opts = {}) {
  if (!opts || typeof opts !== "object") throw new Error("opts is required");
  const subject = opts.subject;
  if (!subject || typeof subject !== "string") throw new Error("subject is required");
  const id = randomUUID();
  const ticket = {
    id,
    subject,
    body: opts.body || "",
    priority: normalizePriority(opts.priority),
    requiredSkills: Array.isArray(opts.requiredSkills)
      ? opts.requiredSkills.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
      : [],
    status: "open",
    queue: null,
    assignedTo: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), type: "created", data: {} }],
  };
  await writeJsonPath(ticketPath(id), ticket);
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { ids: [] });
    const list = Array.isArray(idx.ids) ? idx.ids : [];
    list.unshift(id);
    if (list.length > 2000) list.length = 2000;
    await writeJsonPath(indexPath(), { ids: list });
  });
  return ticket;
}

/**
 * Assign a ticket to the best-matching queue + agent. Returns the updated
 * ticket.
 */
export async function assignTicket(ticketId) {
  return withPathLock(configPath(), async () => {
    const cfg = await readConfig();
    const ticket = await getTicket(ticketId);
    if (!ticket) {
      const err = new Error(`ticket ${ticketId} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const match = pickQueue(cfg, ticket.requiredSkills);
    const queueName = match.queueName;
    const queue = cfg.queues[queueName];
    let assignee = null;
    if (queue && queue.agents.length > 0) {
      // Round-robin among skill-matching agents.
      const candidates = queue.agents.filter((id) => {
        const a = cfg.agents[id];
        if (!a) return false;
        if (ticket.requiredSkills.length === 0) return true;
        return ticket.requiredSkills.every((s) => a.skills.includes(s));
      });
      const pool = candidates.length > 0 ? candidates : queue.agents;
      const rr = (queue.roundRobinIndex || 0) % pool.length;
      assignee = pool[rr];
      queue.roundRobinIndex = (rr + 1) % pool.length;
    }
    ticket.queue = queueName;
    ticket.assignedTo = assignee;
    ticket.status = assignee ? "assigned" : "queued";
    ticket.updatedAt = new Date().toISOString();
    ticket.history.push({
      at: ticket.updatedAt,
      type: "assigned",
      data: { queue: queueName, agent: assignee, reason: match.reason },
    });
    await writeJsonPath(ticketPath(ticketId), ticket);
    await writeJsonPath(configPath(), cfg);
    return ticket;
  });
}

function pickQueue(cfg, requiredSkills) {
  if (!requiredSkills || requiredSkills.length === 0) {
    return { queueName: "default", reason: "no-skills-required" };
  }
  // Rank queues by how many of their agents cover all required skills.
  let best = { queueName: "default", score: -1, reason: "fallback" };
  for (const [name, queue] of Object.entries(cfg.queues)) {
    let covered = 0;
    for (const agentId of queue.agents) {
      const a = cfg.agents[agentId];
      if (!a) continue;
      if (requiredSkills.every((s) => a.skills.includes(s))) covered += 1;
    }
    if (covered > best.score) {
      best = { queueName: name, score: covered, reason: covered > 0 ? "skill-match" : "fallback" };
    }
  }
  return best;
}

export async function getTicket(id) {
  if (!id) return null;
  const rec = await readJsonPath(ticketPath(id), null);
  if (!rec || !rec.id) return null;
  return rec;
}

export async function listTickets(opts = {}) {
  const idx = await readJsonPath(indexPath(), { ids: [] });
  const ids = Array.isArray(idx.ids) ? idx.ids : [];
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
  const results = [];
  for (const id of ids) {
    const t = await getTicket(id);
    if (!t) continue;
    if (opts.status && t.status !== opts.status) continue;
    if (opts.queue && t.queue !== opts.queue) continue;
    if (opts.assignedTo && t.assignedTo !== opts.assignedTo) continue;
    results.push(t);
    if (results.length >= limit) break;
  }
  return results;
}

export const _internals = {
  pickQueue,
  configPath,
  ticketPath,
  indexPath,
  DEFAULT_CONFIG,
  normalizePriority,
};
