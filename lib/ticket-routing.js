// @ts-check
/**
 * Phase 62.2: Ticket routing.
 *
 * Priority + skill-based queue assignment for customer support. Manages:
 *   - Queues (`createQueue`, `listQueues`)
 *   - Agent skill profiles (`setAgentSkills`)
 *   - Routing a new ticket to the best queue/agent (`routeTicket`)
 *   - Stats per queue (`getQueueStats`)
 *
 * Persistence via `json-path-store.js`.
 *
 * @module ticket-routing
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const VALID_PRIORITIES = ["low", "normal", "high", "urgent"];

function queuesPath() {
  return join(getDataDir(), "ticket-routing-queues.json");
}

function agentsPath() {
  return join(getDataDir(), "ticket-routing-agents.json");
}

function ticketsPath() {
  return join(getDataDir(), "ticket-routing-tickets.json");
}

async function loadQueues() {
  const data = await readJsonPath(queuesPath(), { version: STORE_VERSION, queues: {} });
  if (!data.queues || typeof data.queues !== "object") data.queues = {};
  return data;
}

async function saveQueues(data) {
  await writeJsonPath(queuesPath(), { version: STORE_VERSION, queues: data.queues || {} });
}

async function loadAgents() {
  const data = await readJsonPath(agentsPath(), { version: STORE_VERSION, agents: {} });
  if (!data.agents || typeof data.agents !== "object") data.agents = {};
  return data;
}

async function saveAgents(data) {
  await writeJsonPath(agentsPath(), { version: STORE_VERSION, agents: data.agents || {} });
}

async function loadTickets() {
  const data = await readJsonPath(ticketsPath(), { version: STORE_VERSION, tickets: [] });
  if (!Array.isArray(data.tickets)) data.tickets = [];
  return data;
}

async function saveTickets(data) {
  await writeJsonPath(ticketsPath(), { version: STORE_VERSION, tickets: data.tickets || [] });
}

/* -------------------------------------------------------------------------- */
/* Queues                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create (or update) a queue. A queue has `name`, required `skills`,
 * optional `priority` level gating, and a `slaMinutes` target.
 *
 * @param {string} name
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function createQueue(name, opts = {}) {
  if (!name || typeof name !== "string") throw new Error("queue name is required");
  const path = queuesPath();
  return withPathLock(path, async () => {
    const data = await loadQueues();
    const now = new Date().toISOString();
    const existing = data.queues[name] || { createdAt: now };
    data.queues[name] = {
      ...existing,
      name,
      skills: Array.isArray(opts.skills) ? opts.skills.slice() : (existing.skills || []),
      minPriority: opts.minPriority || existing.minPriority || "low",
      slaMinutes: Number.isFinite(opts.slaMinutes) ? opts.slaMinutes : (existing.slaMinutes || 60),
      description: opts.description || existing.description || "",
      updatedAt: now,
    };
    await saveQueues(data);
    return data.queues[name];
  });
}

/** List all queues. */
export async function listQueues() {
  const data = await loadQueues();
  return Object.values(data.queues || {});
}

/* -------------------------------------------------------------------------- */
/* Agents                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Set or replace an agent's skill profile.
 *
 * @param {string} agentId
 * @param {string[]} skills
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function setAgentSkills(agentId, skills, opts = {}) {
  if (!agentId || typeof agentId !== "string") throw new Error("agentId is required");
  if (!Array.isArray(skills)) throw new Error("skills must be an array");
  const path = agentsPath();
  return withPathLock(path, async () => {
    const data = await loadAgents();
    const now = new Date().toISOString();
    const existing = data.agents[agentId] || { createdAt: now, activeTickets: 0 };
    data.agents[agentId] = {
      ...existing,
      agentId,
      skills: skills.map((s) => String(s)),
      maxConcurrent: Number.isFinite(opts.maxConcurrent) ? opts.maxConcurrent : (existing.maxConcurrent || 5),
      available: opts.available !== false,
      updatedAt: now,
    };
    await saveAgents(data);
    return data.agents[agentId];
  });
}

/** Return all agents. */
export async function listAgents() {
  const data = await loadAgents();
  return Object.values(data.agents || {});
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                    */
/* -------------------------------------------------------------------------- */

function priorityRank(p) {
  const idx = VALID_PRIORITIES.indexOf(p);
  return idx < 0 ? 0 : idx;
}

/**
 * Compute a match score for an agent against a ticket. Higher is better.
 *
 * @param {object} agent
 * @param {object} ticket
 * @returns {number}
 */
function agentMatchScore(agent, ticket) {
  if (!agent.available) return -1;
  if ((agent.activeTickets || 0) >= (agent.maxConcurrent || 5)) return -1;
  const required = Array.isArray(ticket.requiredSkills) ? ticket.requiredSkills : [];
  const agentSkills = Array.isArray(agent.skills) ? agent.skills : [];
  let hits = 0;
  for (const sk of required) {
    if (agentSkills.includes(sk)) hits += 1;
  }
  // Any required skill missing -> can't match
  if (required.length > 0 && hits === 0) return -1;
  const match = required.length > 0 ? hits / required.length : 0.5;
  const load = 1 - (agent.activeTickets || 0) / (agent.maxConcurrent || 5);
  return match * 0.7 + load * 0.3;
}

/**
 * Find the best queue for a ticket based on required skills + priority gating.
 *
 * @param {object} ticket
 * @param {Array<object>} queues
 * @returns {object | null}
 */
function pickQueue(ticket, queues) {
  const required = Array.isArray(ticket.requiredSkills) ? ticket.requiredSkills : [];
  const ticketRank = priorityRank(ticket.priority || "normal");
  let best = null;
  let bestScore = -1;
  for (const q of queues) {
    const minRank = priorityRank(q.minPriority || "low");
    if (ticketRank < minRank) continue;
    const qSkills = Array.isArray(q.skills) ? q.skills : [];
    let hits = 0;
    for (const sk of required) if (qSkills.includes(sk)) hits += 1;
    const score = required.length > 0 ? hits / required.length : 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = q;
    }
  }
  return best;
}

/**
 * Route a ticket: pick a queue, pick the best available agent, persist
 * the assignment, and return the routing decision.
 *
 * @param {object} ticket
 * @returns {Promise<object>}
 */
export async function routeTicket(ticket) {
  if (!ticket || typeof ticket !== "object") throw new Error("ticket is required");
  const priority = VALID_PRIORITIES.includes(ticket.priority) ? ticket.priority : "normal";
  const queues = await listQueues();
  const agents = await listAgents();
  const queue = pickQueue({ ...ticket, priority }, queues);
  /** @type {object | null} */
  let bestAgent = null;
  let bestScore = -1;
  for (const a of agents) {
    const s = agentMatchScore(a, { ...ticket, priority });
    if (s > bestScore) {
      bestScore = s;
      bestAgent = a;
    }
  }
  const now = new Date().toISOString();
  const record = {
    id: `tk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    subject: ticket.subject || "",
    body: ticket.body || "",
    priority,
    requiredSkills: Array.isArray(ticket.requiredSkills) ? ticket.requiredSkills : [],
    queue: queue ? queue.name : null,
    assignedAgent: bestAgent && bestScore > 0 ? bestAgent.agentId : null,
    routedAt: now,
    status: bestAgent && bestScore > 0 ? "assigned" : "unassigned",
  };
  // Persist
  await withPathLock(ticketsPath(), async () => {
    const data = await loadTickets();
    data.tickets.push(record);
    await saveTickets(data);
  });
  if (record.assignedAgent) {
    await withPathLock(agentsPath(), async () => {
      const data = await loadAgents();
      const a = data.agents[record.assignedAgent];
      if (a) {
        a.activeTickets = (a.activeTickets || 0) + 1;
        await saveAgents(data);
      }
    });
  }
  return record;
}

/* -------------------------------------------------------------------------- */
/* Stats                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Aggregate simple stats per queue.
 *
 * @param {string} [queueName]
 * @returns {Promise<object>}
 */
export async function getQueueStats(queueName) {
  const data = await loadTickets();
  /** @type {Record<string, { total: number, assigned: number, unassigned: number, byPriority: Record<string, number> }>} */
  const stats = {};
  for (const t of data.tickets) {
    const q = t.queue || "__unassigned__";
    if (queueName && q !== queueName) continue;
    if (!stats[q]) stats[q] = { total: 0, assigned: 0, unassigned: 0, byPriority: {} };
    stats[q].total += 1;
    if (t.assignedAgent) stats[q].assigned += 1;
    else stats[q].unassigned += 1;
    stats[q].byPriority[t.priority] = (stats[q].byPriority[t.priority] || 0) + 1;
  }
  if (queueName) {
    return stats[queueName] || { total: 0, assigned: 0, unassigned: 0, byPriority: {} };
  }
  return stats;
}

/** List all recorded tickets. */
export async function listTickets(queueName) {
  const data = await loadTickets();
  if (!queueName) return data.tickets;
  return data.tickets.filter((t) => t.queue === queueName);
}
