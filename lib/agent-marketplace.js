/**
 * Phase 47.2: Agent Marketplace
 * Discover and publish specialized agents with reputation scoring,
 * ratings, install counts, reports, and featured curation.
 * Stored under data/agent-marketplace/*.json via json-path-store.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import * as storage from "./storage.js";
import { calculateReputationScore, getReputationBadge } from "./agent-reputation.js";

export const AGENT_CATEGORIES = [
  "research",
  "coding",
  "writing",
  "analysis",
  "support",
  "automation",
  "creative",
  "data",
  "education",
  "other",
];

export const REPORT_REASONS = [
  "spam",
  "abusive",
  "malicious",
  "broken",
  "copyright",
  "other",
];

const MAX_AGENTS = 50_000;
const MAX_REVIEWS = 200_000;
const MAX_REPORTS = 50_000;

// ─── storage paths ──────────────────────────────────────────────────────────

function agentsPath() {
  return join(getDataDir(), "agent-marketplace", "agents.json");
}
function ratingsPath() {
  return join(getDataDir(), "agent-marketplace", "ratings.json");
}
function reportsPath() {
  return join(getDataDir(), "agent-marketplace", "reports.json");
}
function eventsPath() {
  return join(getDataDir(), "agent-marketplace", "events.json");
}

async function loadAgents() {
  const data = await readJsonPath(agentsPath(), { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}
async function saveAgents(items) {
  const trimmed = items.length > MAX_AGENTS ? items.slice(-MAX_AGENTS) : items;
  await writeJsonPath(agentsPath(), { _version: 1, items: trimmed });
}

async function loadRatings() {
  const data = await readJsonPath(ratingsPath(), { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}
async function saveRatings(items) {
  const trimmed = items.length > MAX_REVIEWS ? items.slice(-MAX_REVIEWS) : items;
  await writeJsonPath(ratingsPath(), { _version: 1, items: trimmed });
}

async function loadReports() {
  const data = await readJsonPath(reportsPath(), { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}
async function saveReports(items) {
  const trimmed = items.length > MAX_REPORTS ? items.slice(-MAX_REPORTS) : items;
  await writeJsonPath(reportsPath(), { _version: 1, items: trimmed });
}

async function loadEvents() {
  const data = await readJsonPath(eventsPath(), { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}
async function appendEvent(event) {
  await withPathLock(eventsPath(), async () => {
    const events = await loadEvents();
    events.push(event);
    const trimmed = events.length > MAX_AGENTS ? events.slice(-MAX_AGENTS) : events;
    await writeJsonPath(eventsPath(), { _version: 1, items: trimmed });
  });
}

// ─── utilities ──────────────────────────────────────────────────────────────

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function uniqueSlug(base, existing) {
  const taken = new Set(existing.map((a) => a.slug));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t) => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim().toLowerCase().slice(0, 32))
    .slice(0, 12);
}

function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim().slice(0, 64))
    .slice(0, 64);
}

function sanitizeExamples(examples) {
  if (!Array.isArray(examples)) return [];
  return examples
    .filter((e) => e && typeof e === "object")
    .slice(0, 20)
    .map((e) => ({
      input: typeof e.input === "string" ? e.input.slice(0, 2048) : "",
      output: typeof e.output === "string" ? e.output.slice(0, 4096) : "",
      description: typeof e.description === "string" ? e.description.slice(0, 512) : "",
    }));
}

function sanitizeHyperparameters(hp) {
  if (!hp || typeof hp !== "object") return {};
  const out = {};
  if (typeof hp.temperature === "number") out.temperature = Math.max(0, Math.min(2, hp.temperature));
  if (typeof hp.top_p === "number") out.top_p = Math.max(0, Math.min(1, hp.top_p));
  if (typeof hp.max_tokens === "number") out.max_tokens = Math.max(1, Math.min(128_000, Math.floor(hp.max_tokens)));
  if (typeof hp.frequency_penalty === "number") out.frequency_penalty = Math.max(-2, Math.min(2, hp.frequency_penalty));
  if (typeof hp.presence_penalty === "number") out.presence_penalty = Math.max(-2, Math.min(2, hp.presence_penalty));
  return out;
}

function agentPublic(agent, opts = {}) {
  if (!agent) return null;
  const includePrompt = opts.includePrompt !== false;
  const stats = agentStatsFromRecord(agent);
  const score = calculateReputationScore(stats);
  return {
    marketplaceId: agent.marketplaceId,
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    category: agent.category,
    tags: agent.tags,
    publisher: agent.publisher,
    publishedAt: agent.publishedAt,
    updatedAt: agent.updatedAt,
    model: agent.model,
    tools: agent.tools,
    hyperparameters: agent.hyperparameters,
    examples: agent.examples,
    license: agent.license,
    systemPrompt: includePrompt ? agent.systemPrompt : undefined,
    installs: agent.installs || 0,
    forks: agent.forks || 0,
    reports: agent.reports || 0,
    avgRating: agent.avgRating || 0,
    ratingCount: agent.ratingCount || 0,
    featured: !!agent.featured,
    verifiedPublisher: !!agent.verifiedPublisher,
    reputationScore: score,
    reputationBadge: getReputationBadge(score),
  };
}

function agentStatsFromRecord(agent) {
  return {
    installs: agent.installs || 0,
    avgRating: agent.avgRating || 0,
    ratingCount: agent.ratingCount || 0,
    publishedAt: agent.publishedAt,
    updatedAt: agent.updatedAt,
    verifiedPublisher: !!agent.verifiedPublisher,
    reports: agent.reports || 0,
  };
}

// ─── publish ────────────────────────────────────────────────────────────────

/**
 * Publish a new agent to the marketplace.
 * @param {object} config - { name, description, category, tags, systemPrompt, tools, hyperparameters, model, examples, license }
 * @param {object} publisher - { userId, name, verified? }
 * @returns {Promise<{ marketplaceId, slug, publishedAt }>}
 */
export async function publishAgent(config, publisher) {
  if (!config || typeof config !== "object") {
    throw new Error("agent config is required");
  }
  if (!config.name || typeof config.name !== "string" || !config.name.trim()) {
    throw new Error("agent name is required");
  }
  if (!config.systemPrompt || typeof config.systemPrompt !== "string" || !config.systemPrompt.trim()) {
    throw new Error("systemPrompt is required");
  }

  const category = config.category && AGENT_CATEGORIES.includes(config.category)
    ? config.category
    : "other";
  const pub = publisher && typeof publisher === "object"
    ? {
        userId: publisher.userId || "anonymous",
        name: publisher.name || publisher.userId || "anonymous",
        verified: !!publisher.verified,
      }
    : { userId: "anonymous", name: "anonymous", verified: false };

  const marketplaceId = randomUUID();
  const publishedAt = new Date().toISOString();
  const path = agentsPath();

  const entry = {
    marketplaceId,
    slug: "",
    name: config.name.trim().slice(0, 128),
    description: typeof config.description === "string"
      ? config.description.trim().slice(0, 2048)
      : "",
    category,
    tags: sanitizeTags(config.tags),
    publisher: pub,
    publishedAt,
    updatedAt: publishedAt,
    model: typeof config.model === "string" ? config.model.slice(0, 128) : "",
    tools: sanitizeTools(config.tools),
    hyperparameters: sanitizeHyperparameters(config.hyperparameters),
    examples: sanitizeExamples(config.examples),
    license: typeof config.license === "string" ? config.license.slice(0, 64) : "MIT",
    systemPrompt: config.systemPrompt.slice(0, 32_000),
    installs: 0,
    forks: 0,
    reports: 0,
    avgRating: 0,
    ratingCount: 0,
    featured: false,
    verifiedPublisher: pub.verified,
  };

  await withPathLock(path, async () => {
    const items = await loadAgents();
    entry.slug = uniqueSlug(slugify(entry.name) || marketplaceId, items);
    items.push(entry);
    await saveAgents(items);
  });

  await appendEvent({
    type: "publish",
    marketplaceId,
    userId: pub.userId,
    timestamp: publishedAt,
  });

  return { marketplaceId, slug: entry.slug, publishedAt };
}

// ─── list / search / get ────────────────────────────────────────────────────

/**
 * List marketplace agents with filters and sorting.
 * @param {object} [options] - { category, tag, sortBy, author, limit, offset }
 */
export async function listMarketplaceAgents(options = {}) {
  const {
    category = null,
    tag = null,
    sortBy = "newest",
    author = null,
    limit = 50,
    offset = 0,
  } = options || {};

  let items = await loadAgents();

  if (category) items = items.filter((a) => a.category === category);
  if (tag) items = items.filter((a) => Array.isArray(a.tags) && a.tags.includes(String(tag).toLowerCase()));
  if (author) {
    items = items.filter((a) => a.publisher && (a.publisher.userId === author || a.publisher.name === author));
  }

  switch (sortBy) {
    case "rating":
      items.sort((a, b) => (b.avgRating || 0) - (a.avgRating || 0));
      break;
    case "installs":
      items.sort((a, b) => (b.installs || 0) - (a.installs || 0));
      break;
    case "name":
      items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      break;
    case "reputation":
      items.sort((a, b) => calculateReputationScore(agentStatsFromRecord(b)) - calculateReputationScore(agentStatsFromRecord(a)));
      break;
    case "oldest":
      items.sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
      break;
    case "newest":
    default:
      items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
      break;
  }

  const total = items.length;
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const slice = items.slice(safeOffset, safeOffset + safeLimit);
  return { items: slice.map((a) => agentPublic(a, { includePrompt: false })), total };
}

/**
 * Get a single marketplace agent by id or slug.
 */
export async function getMarketplaceAgent(id) {
  if (!id) return null;
  const items = await loadAgents();
  const found = items.find((a) => a.marketplaceId === id || a.slug === id);
  return found ? agentPublic(found, { includePrompt: true }) : null;
}

/**
 * Search marketplace agents by free-text query.
 */
export async function searchMarketplaceAgents(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const items = await loadAgents();
  const matches = items.filter((a) => {
    const haystack = [
      a.name,
      a.description,
      a.category,
      ...(Array.isArray(a.tags) ? a.tags : []),
      a.publisher && a.publisher.name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
  return matches.map((a) => agentPublic(a, { includePrompt: false }));
}

// ─── update / delete ────────────────────────────────────────────────────────

/**
 * Update a marketplace agent. Only the publisher may update.
 */
export async function updateMarketplaceAgent(id, updates, publisherId) {
  if (!id) throw new Error("id is required");
  if (!updates || typeof updates !== "object") throw new Error("updates required");

  const path = agentsPath();
  let updated = null;

  await withPathLock(path, async () => {
    const items = await loadAgents();
    const idx = items.findIndex((a) => a.marketplaceId === id || a.slug === id);
    if (idx === -1) throw new Error("agent not found");
    const agent = items[idx];
    if (publisherId && agent.publisher && agent.publisher.userId !== publisherId) {
      throw new Error("only the publisher can update this agent");
    }

    if (typeof updates.name === "string" && updates.name.trim()) {
      agent.name = updates.name.trim().slice(0, 128);
    }
    if (typeof updates.description === "string") {
      agent.description = updates.description.trim().slice(0, 2048);
    }
    if (updates.category && AGENT_CATEGORIES.includes(updates.category)) {
      agent.category = updates.category;
    }
    if (updates.tags !== undefined) {
      agent.tags = sanitizeTags(updates.tags);
    }
    if (typeof updates.systemPrompt === "string" && updates.systemPrompt.trim()) {
      agent.systemPrompt = updates.systemPrompt.slice(0, 32_000);
    }
    if (updates.tools !== undefined) {
      agent.tools = sanitizeTools(updates.tools);
    }
    if (updates.hyperparameters !== undefined) {
      agent.hyperparameters = sanitizeHyperparameters(updates.hyperparameters);
    }
    if (typeof updates.model === "string") {
      agent.model = updates.model.slice(0, 128);
    }
    if (updates.examples !== undefined) {
      agent.examples = sanitizeExamples(updates.examples);
    }
    if (typeof updates.license === "string") {
      agent.license = updates.license.slice(0, 64);
    }

    agent.updatedAt = new Date().toISOString();
    items[idx] = agent;
    await saveAgents(items);
    updated = agent;
  });

  await appendEvent({
    type: "update",
    marketplaceId: updated.marketplaceId,
    userId: publisherId || "anonymous",
    timestamp: new Date().toISOString(),
  });

  return agentPublic(updated, { includePrompt: true });
}

/**
 * Delete a marketplace agent. Only the publisher may delete.
 */
export async function deleteMarketplaceAgent(id, publisherId) {
  if (!id) throw new Error("id is required");
  const path = agentsPath();
  let removed = null;

  await withPathLock(path, async () => {
    const items = await loadAgents();
    const idx = items.findIndex((a) => a.marketplaceId === id || a.slug === id);
    if (idx === -1) throw new Error("agent not found");
    const agent = items[idx];
    if (publisherId && agent.publisher && agent.publisher.userId !== publisherId) {
      throw new Error("only the publisher can delete this agent");
    }
    items.splice(idx, 1);
    await saveAgents(items);
    removed = agent;
  });

  await appendEvent({
    type: "delete",
    marketplaceId: removed.marketplaceId,
    userId: publisherId || "anonymous",
    timestamp: new Date().toISOString(),
  });

  return { deleted: true, marketplaceId: removed.marketplaceId };
}

// ─── ratings ────────────────────────────────────────────────────────────────

/**
 * Rate an agent (1-5). One rating per user; subsequent calls update the existing rating.
 */
export async function rateAgent(id, userId, rating, review) {
  if (!id) throw new Error("id is required");
  if (!userId) throw new Error("userId is required");
  const num = Number(rating);
  if (!Number.isFinite(num) || num < 1 || num > 5) {
    throw new Error("rating must be a number between 1 and 5");
  }

  const rPath = ratingsPath();
  const aPath = agentsPath();

  let existing = false;
  await withPathLock(rPath, async () => {
    const ratings = await loadRatings();
    const idx = ratings.findIndex((r) => r.marketplaceId === id && r.userId === userId);
    const entry = {
      marketplaceId: id,
      userId,
      rating: Math.round(num),
      review: typeof review === "string" ? review.trim().slice(0, 2048) : "",
      timestamp: new Date().toISOString(),
    };
    if (idx >= 0) {
      ratings[idx] = entry;
      existing = true;
    } else {
      ratings.push(entry);
    }
    await saveRatings(ratings);
  });

  // Recompute aggregate on the agent record.
  let avg = 0;
  let count = 0;
  await withPathLock(aPath, async () => {
    const agents = await loadAgents();
    const idx = agents.findIndex((a) => a.marketplaceId === id || a.slug === id);
    if (idx >= 0) {
      const ratings = await loadRatings();
      const forAgent = ratings.filter((r) => r.marketplaceId === agents[idx].marketplaceId);
      count = forAgent.length;
      avg = count > 0
        ? Math.round((forAgent.reduce((s, r) => s + (r.rating || 0), 0) / count) * 100) / 100
        : 0;
      agents[idx].avgRating = avg;
      agents[idx].ratingCount = count;
      await saveAgents(agents);
    }
  });

  await appendEvent({
    type: existing ? "rate-update" : "rate",
    marketplaceId: id,
    userId,
    rating: Math.round(num),
    timestamp: new Date().toISOString(),
  });

  return { rated: true, updated: existing, avgRating: avg, ratingCount: count };
}

/**
 * Get aggregated rating data for an agent.
 */
export async function getAgentRatings(id) {
  if (!id) return { average: 0, count: 0, distribution: {}, reviews: [] };
  const ratings = await loadRatings();
  const forAgent = ratings.filter((r) => r.marketplaceId === id);
  const count = forAgent.length;
  const average = count > 0
    ? Math.round((forAgent.reduce((s, r) => s + (r.rating || 0), 0) / count) * 100) / 100
    : 0;
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of forAgent) {
    const key = String(r.rating);
    if (distribution[key] !== undefined) distribution[key]++;
  }
  const reviews = forAgent
    .filter((r) => r.review)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 50)
    .map((r) => ({
      userId: r.userId,
      rating: r.rating,
      review: r.review,
      timestamp: r.timestamp,
    }));
  return { average, count, distribution, reviews };
}

// ─── install ────────────────────────────────────────────────────────────────

/**
 * Install an agent into a workspace. Increments install count and copies the
 * configuration via storage.mergeItems("agents", workspace, ...).
 */
export async function installAgent(marketplaceId, workspaceId, userId) {
  if (!marketplaceId) throw new Error("marketplaceId is required");
  if (!workspaceId) throw new Error("workspaceId is required");

  const aPath = agentsPath();
  let agent = null;

  await withPathLock(aPath, async () => {
    const items = await loadAgents();
    const idx = items.findIndex((a) => a.marketplaceId === marketplaceId || a.slug === marketplaceId);
    if (idx === -1) throw new Error("agent not found");
    items[idx].installs = (items[idx].installs || 0) + 1;
    agent = items[idx];
    await saveAgents(items);
  });

  const installedAgentId = randomUUID();
  const localItem = {
    id: installedAgentId,
    name: agent.name,
    description: agent.description,
    category: agent.category,
    tags: agent.tags,
    model: agent.model,
    tools: agent.tools,
    hyperparameters: agent.hyperparameters,
    systemPrompt: agent.systemPrompt,
    examples: agent.examples,
    license: agent.license,
    installedFromMarketplaceId: agent.marketplaceId,
    installedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  try {
    if (typeof storage.mergeItems === "function") {
      await storage.mergeItems("agents", workspaceId, [localItem], userId || "anonymous");
    }
  } catch (err) {
    console.warn("[agent-marketplace] install copy to workspace failed:", err.message);
  }

  await appendEvent({
    type: "install",
    marketplaceId: agent.marketplaceId,
    userId: userId || "anonymous",
    workspaceId,
    installedAgentId,
    timestamp: new Date().toISOString(),
  });

  return { installedAgentId };
}

// ─── stats ──────────────────────────────────────────────────────────────────

/**
 * Aggregate stats for an agent: installs, average rating, forks, reports, weekly activity.
 */
export async function getAgentStats(id) {
  if (!id) {
    return { installs: 0, avgRating: 0, ratingCount: 0, forks: 0, reports: 0, weeklyActivity: 0 };
  }
  const items = await loadAgents();
  const agent = items.find((a) => a.marketplaceId === id || a.slug === id);
  if (!agent) {
    return { installs: 0, avgRating: 0, ratingCount: 0, forks: 0, reports: 0, weeklyActivity: 0 };
  }

  const events = await loadEvents();
  const cutoff = Date.now() - 7 * 24 * 3_600_000;
  const weeklyActivity = events.filter((e) => {
    if (e.marketplaceId !== agent.marketplaceId) return false;
    const t = new Date(e.timestamp).getTime();
    return Number.isFinite(t) && t >= cutoff;
  }).length;

  const stats = {
    installs: agent.installs || 0,
    avgRating: agent.avgRating || 0,
    ratingCount: agent.ratingCount || 0,
    forks: agent.forks || 0,
    reports: agent.reports || 0,
    weeklyActivity,
  };
  const score = calculateReputationScore({
    ...stats,
    publishedAt: agent.publishedAt,
    updatedAt: agent.updatedAt,
    verifiedPublisher: !!agent.verifiedPublisher,
  });
  return {
    ...stats,
    reputationScore: score,
    reputationBadge: getReputationBadge(score),
  };
}

// ─── reports / moderation ──────────────────────────────────────────────────

/**
 * Submit a report against an agent for moderation.
 */
export async function reportAgent(id, userId, reason) {
  if (!id) throw new Error("id is required");
  if (!userId) throw new Error("userId is required");
  const reasonStr = typeof reason === "string" ? reason.trim().toLowerCase() : "other";
  const finalReason = REPORT_REASONS.includes(reasonStr) ? reasonStr : "other";

  const rPath = reportsPath();
  const aPath = agentsPath();
  const reportId = randomUUID();
  const timestamp = new Date().toISOString();

  await withPathLock(rPath, async () => {
    const reports = await loadReports();
    reports.push({
      reportId,
      marketplaceId: id,
      userId,
      reason: finalReason,
      status: "open",
      timestamp,
    });
    await saveReports(reports);
  });

  await withPathLock(aPath, async () => {
    const items = await loadAgents();
    const idx = items.findIndex((a) => a.marketplaceId === id || a.slug === id);
    if (idx >= 0) {
      items[idx].reports = (items[idx].reports || 0) + 1;
      await saveAgents(items);
    }
  });

  await appendEvent({
    type: "report",
    marketplaceId: id,
    userId,
    reportId,
    reason: finalReason,
    timestamp,
  });

  return { reportId, reason: finalReason, status: "open" };
}

/**
 * List moderation reports filtered by status (admin only).
 */
export async function listReports(status) {
  const reports = await loadReports();
  if (!status) return reports;
  return reports.filter((r) => r.status === status);
}

/**
 * Update a report's status (admin only).
 */
export async function updateReportStatus(reportId, status, adminId) {
  if (!reportId) throw new Error("reportId is required");
  const allowed = ["open", "reviewing", "resolved", "dismissed"];
  if (!allowed.includes(status)) throw new Error(`status must be one of: ${allowed.join(", ")}`);

  const rPath = reportsPath();
  let updated = null;
  await withPathLock(rPath, async () => {
    const reports = await loadReports();
    const idx = reports.findIndex((r) => r.reportId === reportId);
    if (idx === -1) throw new Error("report not found");
    reports[idx].status = status;
    reports[idx].reviewedBy = adminId || "admin";
    reports[idx].reviewedAt = new Date().toISOString();
    updated = reports[idx];
    await saveReports(reports);
  });
  return updated;
}

// ─── featured ───────────────────────────────────────────────────────────────

/**
 * Mark an agent as featured (admin only).
 */
export async function featureAgent(id, adminId) {
  if (!id) throw new Error("id is required");
  const path = agentsPath();
  let updated = null;
  await withPathLock(path, async () => {
    const items = await loadAgents();
    const idx = items.findIndex((a) => a.marketplaceId === id || a.slug === id);
    if (idx === -1) throw new Error("agent not found");
    items[idx].featured = true;
    items[idx].featuredAt = new Date().toISOString();
    items[idx].featuredBy = adminId || "admin";
    updated = items[idx];
    await saveAgents(items);
  });

  await appendEvent({
    type: "feature",
    marketplaceId: updated.marketplaceId,
    userId: adminId || "admin",
    timestamp: new Date().toISOString(),
  });

  return agentPublic(updated, { includePrompt: false });
}

/**
 * Unfeature an agent (admin only).
 */
export async function unfeatureAgent(id, adminId) {
  if (!id) throw new Error("id is required");
  const path = agentsPath();
  let updated = null;
  await withPathLock(path, async () => {
    const items = await loadAgents();
    const idx = items.findIndex((a) => a.marketplaceId === id || a.slug === id);
    if (idx === -1) throw new Error("agent not found");
    items[idx].featured = false;
    updated = items[idx];
    await saveAgents(items);
  });
  return agentPublic(updated, { includePrompt: false });
}

/**
 * List featured agents.
 */
export async function listFeaturedAgents() {
  const items = await loadAgents();
  return items
    .filter((a) => a.featured)
    .sort((a, b) => {
      const ta = new Date(a.featuredAt || a.updatedAt || a.publishedAt).getTime();
      const tb = new Date(b.featuredAt || b.updatedAt || b.publishedAt).getTime();
      return tb - ta;
    })
    .map((a) => agentPublic(a, { includePrompt: false }));
}

// ─── test helper ────────────────────────────────────────────────────────────

export async function _resetAgentMarketplaceForTests() {
  await writeJsonPath(agentsPath(), { _version: 1, items: [] });
  await writeJsonPath(ratingsPath(), { _version: 1, items: [] });
  await writeJsonPath(reportsPath(), { _version: 1, items: [] });
  await writeJsonPath(eventsPath(), { _version: 1, items: [] });
}
